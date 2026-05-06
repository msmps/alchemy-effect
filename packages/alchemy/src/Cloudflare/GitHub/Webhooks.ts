import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  WebhookEventSource,
  type EventHandlers,
  type WebhookEventSourceService,
} from "../../GitHub/EventSources.ts";
import type {
  AnyWebhookDelivery,
  WebhookDelivery,
  WebhookEventName,
} from "../../GitHub/Events.ts";
import {
  Webhook,
  type WebhookEvent as WebhookEventLiteral,
} from "../../GitHub/Webhook.ts";
import {
  Dispatcher,
  repoFullName,
  verifySignature,
  type DispatcherService,
  type RepoRef,
  type WebhookHandler,
} from "../../GitHub/Webhooks.ts";
import type { Input } from "../../Input.ts";
import * as Output from "../../Output.ts";
import type { SecretClient } from "../SecretsStore/SecretBinding.ts";
import { Worker } from "../Workers/Worker.ts";

interface NamedHandler {
  /** Repository fully-qualified name (`owner/name`) the handler is bound to. */
  repoFullName: string;
  /** GitHub event name. */
  event: WebhookEventName;
  /**
   * The actual handler. We type-erase on `any` because each registration
   * may have its own `Req`/`Err`; the dispatcher invokes the effect inside
   * `Effect.forkDetach` where the parent fiber's context provides any
   * services the handler needs.
   */
  handler: WebhookHandler<WebhookEventName, any, any>;
}

/**
 * Build the Cloudflare-side layer that provides everything needed for
 * GitHub webhooks on a Worker host:
 *
 *   - {@link Dispatcher}: receives verified deliveries on `path` and
 *     fans them out to the per-event handlers registered via
 *     {@link GitHub.on}.
 *   - {@link WebhookEventSource}: each `GitHub.on(repo, handlers)` call
 *     registers handlers AND yields a {@link Webhook} resource so
 *     GitHub starts delivering those event names to the host worker.
 *
 * The HMAC secret is supplied by the caller — typically from a
 * `Random` minted in user code and uploaded to a `Cloudflare.Secret`
 * (see the StateStore Token pattern in
 * `Cloudflare/StateStore/Token.ts` for the shape). Two things are
 * passed in:
 *
 *   - `secret`: the bound `Cloudflare.Secret` runtime client used to
 *     read the value at request time for signature verification.
 *   - `value`: the same value (typically `random.text` straight from
 *     an `Alchemy.Random`) used at deploy time for the
 *     `Cloudflare.Secret`'s payload AND embedded into every
 *     `GitHub.Webhook` resource created here, so GitHub signs
 *     deliveries with the same secret the worker verifies against.
 */
export interface WebhooksConfig {
  /** Bound `Cloudflare.Secret` runtime client used to read the value for HMAC verification. */
  secret: SecretClient;
  /** Deploy-time value embedded in each `GitHub.Webhook` resource the event source creates. */
  value: Input<Redacted.Redacted<string>>;
  /**
   * Path the Worker should treat as the webhook endpoint. `handle`
   * returns `undefined` for requests on other paths so callers can
   * fall through to their normal `fetch` routing.
   * @default "/__github/webhook"
   */
  path?: string;
}

export const live = <R>(configEff: Effect.Effect<WebhooksConfig, never, R>) => {
  const init = Effect.gen(function* () {
    const config = yield* configEff;
    const path = config.path ?? "/__github/webhook";
    const host = yield* Worker;
    const handlers = yield* Ref.make<NamedHandler[]>([]);

    const dispatcher: DispatcherService = {
      register: (repo, event, handler) =>
        Ref.update(handlers, (xs) => [
          ...xs,
          {
            repoFullName: repoFullName(repo),
            event,
            handler: handler as WebhookHandler<WebhookEventName, never, never>,
          },
        ]),
      registerAny: () =>
        Effect.die("Dispatcher.registerAny is no longer supported"),
      handle: (request) =>
        Effect.gen(function* () {
          const url = new URL(request.url, "http://localhost");
          if (request.method !== "POST" || url.pathname !== path) {
            return undefined;
          }

          const eventHeader = request.headers["x-github-event"];
          const sig = request.headers["x-hub-signature-256"];
          const deliveryId = request.headers["x-github-delivery"];
          const hookId = request.headers["x-github-hook-id"];
          if (!eventHeader || !deliveryId) {
            return HttpServerResponse.text("missing GitHub headers", {
              status: 400,
            });
          }

          const rawBody = yield* request.text;
          const secretValue = yield* config.secret.get();
          const verified = yield* verifySignature(secretValue, sig, rawBody);
          if (!verified) {
            return HttpServerResponse.text("invalid signature", {
              status: 401,
            });
          }

          let payload: Record<string, any>;
          try {
            payload = JSON.parse(rawBody);
          } catch {
            return HttpServerResponse.text("invalid json", { status: 400 });
          }

          const delivery: WebhookDelivery<WebhookEventName> = {
            event: eventHeader as WebhookEventName,
            deliveryId,
            hookId: hookId ? Number(hookId) : undefined,
            payload: payload as any,
            raw: payload,
          };

          const repoFromPayload = (
            (payload.repository as { full_name?: string } | undefined)
              ?.full_name ?? ""
          ).toLowerCase();

          const xs = yield* Ref.get(handlers);
          const matching = xs.filter(
            (h) =>
              h.repoFullName === repoFromPayload && h.event === eventHeader,
          );

          // Fork each matching handler. We deliberately don't await
          // them — GitHub's webhook timeout is 10s and we want the
          // 204 ack to go out promptly.
          yield* Effect.forEach(
            matching,
            (h) =>
              Effect.forkDetach(
                h
                  .handler(delivery as AnyWebhookDelivery)
                  .pipe(Effect.catchCause(() => Effect.void)),
              ),
            { discard: true },
          );

          return HttpServerResponse.empty({ status: 204 });
        }).pipe(Effect.orDie) as Effect.Effect<
          HttpServerResponse.HttpServerResponse | undefined
        >,
    };

    const eventSource: WebhookEventSourceService = (
      repo: RepoRef,
      handlers: EventHandlers,
    ) =>
      Effect.gen(function* () {
        // 1. Wire each handler into the runtime dispatcher so verified
        //    deliveries are routed by event name.
        yield* Effect.all(
          Object.entries(handlers).map(([event, handler]) =>
            dispatcher.register(
              repo,
              event as WebhookEventName,
              handler as WebhookHandler<WebhookEventName, any, any>,
            ),
          ),
        );

        // 2. Install (or update) the actual GitHub webhook so the
        //    selected event names start being delivered to the host
        //    worker. The resource id is per-repo so a second
        //    `on(repo, ...)` call would conflict — register
        //    everything for one repo in a single `on` call.
        yield* Webhook(`${repo.owner}-${repo.name}-webhook`, {
          owner: repo.owner,
          repository: repo.name,
          url: Output.interpolate`${host.url}${path}`,
          secret: config.value,
          events: Object.keys(handlers) as WebhookEventLiteral[],
        });
      });

    return Context.empty().pipe(
      Context.add(Dispatcher, dispatcher),
      Context.add(WebhookEventSource, eventSource),
    );
  });

  return Layer.effectContext(init);
};
