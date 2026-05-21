import type * as cf from "@cloudflare/workers-types";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RuntimeContext } from "../../RuntimeContext.ts";
import type { FunctionContext } from "../../Serverless/Function.ts";
import { isWorkerEvent } from "./Worker.ts";

/**
 * Effect-native wrapper around Cloudflare's
 * [`ForwardableEmailMessage`](https://developers.cloudflare.com/email-routing/email-workers/runtime-api/#forwardableemailmessage).
 *
 * The envelope (`from`, `to`, `headers`, `raw`, `rawSize`) is exposed
 * verbatim; the action methods (`forward`, `reply`, `setReject`) return
 * `Effect`s instead of `Promise`/`void`.
 */
export interface ForwardableEmailMessage {
  /** Envelope From address. */
  readonly from: string;
  /** Envelope To address. */
  readonly to: string;
  /** RFC 5322 headers. */
  readonly headers: cf.Headers;
  /** Raw message body stream. */
  readonly raw: cf.ReadableStream<Uint8Array>;
  /** Size of the raw message body in bytes. */
  readonly rawSize: number;
  /**
   * Reject this message back to the connecting client with a permanent
   * SMTP error and the given reason.
   */
  setReject(reason: string): Effect.Effect<void>;
  /**
   * Forward this message to a verified destination address on the
   * account. Fails with `EmailError` if Cloudflare rejects the forward
   * (e.g. unverified destination).
   */
  forward(
    rcptTo: string,
    headers?: cf.Headers,
  ): Effect.Effect<void, EmailError>;
  /**
   * Reply to the sender with a new outbound message. Fails with
   * `EmailError` if Cloudflare rejects the reply.
   */
  reply(message: cf.EmailMessage): Effect.Effect<void, EmailError>;
}

export class EmailError extends Error {
  readonly _tag = "EmailError";
  constructor(
    readonly action: "forward" | "reply",
    readonly cause: unknown,
  ) {
    super(
      `Cloudflare email ${action} failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

const wrap = (
  message: cf.ForwardableEmailMessage,
): ForwardableEmailMessage => ({
  from: message.from,
  to: message.to,
  headers: message.headers,
  raw: message.raw,
  rawSize: message.rawSize,
  setReject: (reason) => Effect.sync(() => message.setReject(reason)),
  forward: (rcptTo, headers) =>
    Effect.tryPromise({
      try: () => message.forward(rcptTo, headers),
      catch: (cause) => new EmailError("forward", cause),
    }),
  reply: (msg) =>
    Effect.tryPromise({
      try: () => message.reply(msg),
      catch: (cause) => new EmailError("reply", cause),
    }),
});

/**
 * Subscribe to Cloudflare Email Worker events with an Effect handler.
 *
 * Cloudflare routes inbound mail to your Worker when an
 * [`EmailRule`](/providers/cloudflare/emailrule) with an action of
 * type `"worker"` targets it. Exporting an `email` handler is
 * sufficient — no extra binding metadata is required on the Worker.
 *
 * The handler runs once per message (no streaming or batching) and
 * receives a {@link ForwardableEmailMessage} whose action methods are
 * `Effect`-returning — `forward`, `reply`, and `setReject` are
 * composable with the rest of your effect program.
 *
 * @binding Cloudflare.Workers.EmailEventSource
 *
 * @section Subscribing to Inbound Mail
 * @example Log inbound mail
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 *
 * export default Cloudflare.Worker(
 *   "Inbox",
 *   { main: import.meta.path },
 *   Effect.gen(function* () {
 *     yield* Cloudflare.Email.subscribe((message) =>
 *       Effect.log(`from ${message.from} to ${message.to}`),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(Cloudflare.EmailEventSourceLive)),
 * );
 * ```
 *
 * @example Forward to a verified destination
 * ```typescript
 * yield* Cloudflare.Email.subscribe((message) =>
 *   message.forward("ops@example.com"),
 * );
 * ```
 *
 * @example Reject (bounce) a message
 * ```typescript
 * yield* Cloudflare.Email.subscribe((message) =>
 *   message.setReject("Mailbox closed"),
 * );
 * ```
 *
 * @section Routing Mail to the Worker
 * @example Send all mail on a zone to the Worker
 * ```typescript
 * yield* Cloudflare.EmailRouting({ zone: "example.com", enabled: true });
 *
 * yield* Cloudflare.EmailRule("CatchAll", {
 *   zone: "example.com",
 *   matchers: [{ type: "all" }],
 *   actions: [{ type: "worker", value: [worker.name] }],
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/email-routing/email-workers/
 */
export const Email = {
  subscribe: <E = never, Req = never>(
    process: (message: ForwardableEmailMessage) => Effect.Effect<void, E, Req>,
  ) => EmailEventSource.use((source) => source(process)),
};

export type EmailEventSourceService = <E = never, Req = never>(
  process: (message: ForwardableEmailMessage) => Effect.Effect<void, E, Req>,
) => Effect.Effect<void, never, never>;

export class EmailEventSource extends Context.Service<
  EmailEventSource,
  EmailEventSourceService
>()("Cloudflare.Workers.EmailEventSource") {}

export const EmailEventSourceLive = Layer.effect(
  EmailEventSource,
  Effect.gen(function* () {
    return Effect.fn(function* <E, Req>(
      process: (
        message: ForwardableEmailMessage,
      ) => Effect.Effect<void, E, Req>,
    ) {
      const ctx = (yield* RuntimeContext) as unknown as FunctionContext;
      yield* ctx.listen<void, Req>((event) => {
        if (!isWorkerEvent(event) || event.type !== "email") return;

        const message = wrap(event.input as cf.ForwardableEmailMessage);
        return process(message).pipe(Effect.catchCause(() => Effect.void));
      });
    }) as EmailEventSourceService;
  }),
);
