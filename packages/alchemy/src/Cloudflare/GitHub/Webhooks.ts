import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GitHub from "../../GitHub/index.ts";
import * as Output from "../../Output.ts";
import { Random } from "../../Random.ts";
import { Self } from "../../Self.ts";
import * as Cloudflare from "../SecretsStore/index.ts";
import { isWorker, Worker, WorkerEnvironment } from "../Workers/Worker.ts";
import { GITHUB_SECRETS_STORE_ID } from "./Token.ts";

/**
 * Cloudflare-Workers implementation of {@link WebhookEventSource}.
 *
 * On each `events(repo, props).on(handlers)` invocation this layer
 * inline-creates the per-call infrastructure (Random secret, Cloudflare
 * Secrets-Store secret, GitHub Webhook resource), binds the secret into
 * the host worker, and registers a fetch listener that verifies the
 * webhook HMAC and dispatches to the matching event handler.
 *
 * Mirrors the inline-resource-creation pattern of
 * `AWS.Lambda.QueueEventSourcePolicyLive`: every call creates its own
 * resources via the constructors hoisted into this Layer's outer scope.
 */
export const WebhookEventSourceLive = Layer.effect(
  GitHub.WebhookEventSource,
  Effect.gen(function* () {
    const host = yield* Worker;
    const bindSecret = yield* Cloudflare.SecretBindingPolicy;
    const Store = yield* Cloudflare.SecretsStore;
    const Secret = yield* Cloudflare.Secret;
    const RandomSecret = yield* Random;
    const Webhook = yield* GitHub.Webhook;

    return Effect.fn(function* <Req = never>(
      repo: GitHub.ParsedRepoRef,
      props: GitHub.EventsProps,
      handlers: GitHub.EventHandlers<Req>,
    ) {
      const self = yield* Self.asEffect();
      if (!isWorker(self)) {
        return yield* Effect.die(
          new Error(
            `Cloudflare GitHub WebhookEventSource only supports Cloudflare Workers; got '${(self as { Type: string }).Type}'.`,
          ),
        );
      }

      const slug = GitHub.repoSlug(repo);
      const path = props.path ?? GitHub.defaultWebhookPath(repo);

      const store = yield* Store(GITHUB_SECRETS_STORE_ID);
      const random = yield* RandomSecret(`${slug}-WebhookSecret`);
      const secret = yield* Secret(`${slug}-WebhookSecret`, {
        store,
        value: random.text,
      });
      yield* bindSecret(secret);

      const url = Output.interpolate`${assertWorkerUrl(self)}${path}`;
      yield* Webhook(`${slug}-Webhook`, {
        owner: repo.owner,
        repository: repo.repository,
        url,
        secret: random.text,
        events: props.events as readonly string[] | undefined,
        active: props.active ?? true,
      });

      const secretBindingId = secret.LogicalId;
      yield* host.listen(
        Effect.gen(function* () {
          return (event: any) => {
            if (event?.type !== "fetch") return;
            const request = event.input as cf.Request;
            const reqUrl = new URL(request.url);
            if (reqUrl.pathname !== path) return;
            return handleWebhookRequest<Req>(
              request,
              secretBindingId,
              handlers,
            );
          };
        }),
      );
    }) as unknown as GitHub.WebhookEventSourceService;
  }),
);

/**
 * Lift the worker's `url` Output into a non-undefined `Output<string>`
 * by failing loudly at deploy time if the worker has no URL configured.
 */
const assertWorkerUrl = (
  worker: { url: Output.Output<string | undefined>; LogicalId: string },
): Output.Output<string> =>
  Output.map(worker.url, (u) => {
    if (!u) {
      throw new Error(
        `Cloudflare GitHub WebhookEventSource: host Worker '${worker.LogicalId}' has no URL. Configure the worker with \`url: true\` or attach a custom domain so GitHub can reach the webhook receiver.`,
      );
    }
    return u;
  });

const handleWebhookRequest = <Req>(
  request: cf.Request,
  secretBindingId: string,
  handlers: GitHub.EventHandlers<Req>,
): Effect.Effect<Response, never, Req | WorkerEnvironment> =>
  Effect.gen(function* () {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    const env = (yield* WorkerEnvironment) as Record<
      string,
      cf.SecretsStoreSecret | undefined
    >;
    const secretBinding = env[secretBindingId];
    if (!secretBinding) {
      return new Response("Webhook secret binding missing", { status: 500 });
    }
    const secretValue = yield* Effect.tryPromise(() =>
      secretBinding.get(),
    ).pipe(Effect.catch(() => Effect.succeed(undefined as string | undefined)));
    if (!secretValue) {
      return new Response("Webhook secret unavailable", { status: 500 });
    }
    const rawBody = yield* Effect.tryPromise(() => request.text()).pipe(
      Effect.catch(() => Effect.succeed(undefined as string | undefined)),
    );
    if (rawBody === undefined) {
      return new Response("Failed to read body", { status: 400 });
    }
    const sigHeader = request.headers.get("x-hub-signature-256");
    const ok = yield* Effect.tryPromise(() =>
      GitHub.verifyWebhookSignature(secretValue, rawBody, sigHeader),
    ).pipe(Effect.catch(() => Effect.succeed(false)));
    if (!ok) {
      return new Response("Invalid signature", { status: 401 });
    }
    const eventName = request.headers.get("x-github-event") ?? "";
    if (eventName === "ping") {
      return new Response("pong", { status: 200 });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }
    type Handler = (p: unknown) => Effect.Effect<void, never, Req>;
    const map = handlers as Record<string, Handler | undefined>;
    const handler = map[eventName] ?? map["*"];
    if (handler) {
      yield* handler(payload);
    }
    return new Response("ok", { status: 200 });
  });
