import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const zone = process.env.CLOUDFLARE_TEST_ZONE;
const inboxAddress = process.env.CLOUDFLARE_TEST_EMAIL_INBOX;
const senderAddress = process.env.CLOUDFLARE_TEST_EMAIL_FROM;

/**
 * `send_email` binding the test worker uses to seed a message into the
 * inbox it also subscribes to. Restricted to the sender/destination pair
 * supplied via env so the e2e test exercises a real round-trip against
 * Cloudflare's email routing.
 */
export const Sender = Cloudflare.SendEmail("Sender", {
  allowedSenderAddresses: senderAddress ? [senderAddress] : undefined,
  destinationAddress: inboxAddress,
});

interface ReceivedMessage {
  from: string;
  to: string;
  subject: string | null;
  bodySize: number;
  receivedAt: number;
}

/**
 * Durable Object that records every message the worker's email handler
 * sees. The test polls `snapshot()` via `GET /received` to confirm the
 * inbound dispatch actually fired.
 */
export class Inbox extends Cloudflare.DurableObjectNamespace<Inbox>()(
  "Inbox",
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      let received =
        (yield* state.storage.get<ReceivedMessage[]>("received")) ?? [];
      return {
        record: Effect.fn(function* (msg: ReceivedMessage) {
          received = [...received, msg];
          yield* state.storage.put("received", received);
        }),
        snapshot: () => Effect.succeed({ received }),
        reset: Effect.fn(function* () {
          received = [];
          yield* state.storage.put("received", received);
        }),
      };
    });
  }),
) {}

/**
 * Fixture worker for `EmailEventSource.test.ts`.
 *
 * Wires `Cloudflare.email({ zone, matchers }).subscribe(...)` to record
 * each inbound message on an `Inbox` DO, and exposes:
 *
 * - `POST /send` — emits an outbound message via the `send_email` binding
 *   to the address the worker also subscribes to.
 * - `GET /received` — snapshot of recorded inbound messages.
 * - `POST /reset` — clear the DO state.
 *
 * The deploy-time policy auto-creates `EmailRouting` + `EmailRule` so no
 * routing wiring is needed in the test stack. When the env vars are
 * absent the worker still deploys (the subscribe call is skipped), so the
 * fixture is safe to import in non-email test contexts.
 */
export default class EmailTestWorker extends Cloudflare.Worker<EmailTestWorker>()(
  "EmailTestWorker",
  {
    main: import.meta.filename,
    subdomain: { enabled: true, previewsEnabled: false },
    compatibility: { date: "2024-09-23", flags: ["nodejs_compat"] },
  },
  Effect.gen(function* () {
    const inboxes = yield* Inbox;
    const sender = yield* Cloudflare.SendEmail.bind(Sender);

    if (zone && inboxAddress) {
      yield* Cloudflare.email({
        zone,
        matchers: [{ type: "literal", field: "to", value: inboxAddress }],
      }).subscribe((message) =>
        inboxes.getByName("default").record({
          from: message.from,
          to: message.to,
          subject: message.headers.get("subject"),
          bodySize: message.bodySize,
          receivedAt: Date.now(),
        }),
      );
    }

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (request.method === "GET" && url.pathname === "/received") {
          const snapshot = yield* inboxes.getByName("default").snapshot();
          return yield* HttpServerResponse.json(snapshot);
        }

        if (request.method === "POST" && url.pathname === "/reset") {
          yield* inboxes.getByName("default").reset();
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && url.pathname === "/send") {
          if (!senderAddress || !inboxAddress) {
            return yield* HttpServerResponse.json(
              {
                ok: false,
                message:
                  "CLOUDFLARE_TEST_EMAIL_FROM and CLOUDFLARE_TEST_EMAIL_INBOX are required",
              },
              { status: 400 },
            );
          }
          const subject =
            url.searchParams.get("subject") ??
            `alchemy email test ${Date.now()}`;
          const result = yield* sender
            .send({
              from: senderAddress,
              to: inboxAddress,
              subject,
              text: `sent at ${new Date().toISOString()}`,
            })
            .pipe(
              Effect.match({
                onSuccess: () => ({ ok: true as const, subject }),
                onFailure: (err) => ({
                  ok: false as const,
                  message: err.message,
                }),
              }),
            );
          return yield* HttpServerResponse.json(result);
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(
    Effect.provide(Cloudflare.EmailEventSourceLive),
    Effect.provide(Cloudflare.SendEmailBindingLive),
  ),
) {}
