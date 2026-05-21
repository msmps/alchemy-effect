import type * as cf from "@cloudflare/workers-types";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RuntimeContext } from "../../RuntimeContext.ts";
import type { FunctionContext } from "../../Serverless/Function.ts";
import { isWorkerEvent } from "./Worker.ts";

/**
 * Subscribe to Cloudflare Email Worker events with an Effect handler.
 *
 * Cloudflare routes inbound mail to your Worker when an
 * [`EmailRule`](/providers/cloudflare/emailrule) with an action of
 * type `"worker"` targets it. Exporting an `email` handler is
 * sufficient — no extra binding metadata is required on the Worker.
 *
 * Unlike queue or stream sources, the `email` handler is invoked
 * once per message — there is no streaming or batching API. The
 * handler receives a `ForwardableEmailMessage` and returns
 * `Effect<void, _, _>`. Failures are caught and logged; to bounce
 * a message, call `message.setReject(reason)` inside the handler.
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
 * @example Forward via `message.forward`
 * ```typescript
 * yield* Cloudflare.Email.subscribe((message) =>
 *   Effect.tryPromise(() => message.forward("ops@example.com")),
 * );
 * ```
 *
 * @example Reject (bounce) a message
 * ```typescript
 * yield* Cloudflare.Email.subscribe((message) =>
 *   Effect.sync(() => message.setReject("Mailbox closed")),
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
  subscribe: <Req = never>(
    process: (
      message: cf.ForwardableEmailMessage,
    ) => Effect.Effect<void, unknown, Req>,
  ) => EmailEventSource.use((source) => source(process)),
};

export type EmailEventSourceService = <Req = never>(
  process: (
    message: cf.ForwardableEmailMessage,
  ) => Effect.Effect<void, unknown, Req>,
) => Effect.Effect<void, never, never>;

export class EmailEventSource extends Context.Service<
  EmailEventSource,
  EmailEventSourceService
>()("Cloudflare.Workers.EmailEventSource") {}

export const EmailEventSourceLive = Layer.effect(
  EmailEventSource,
  Effect.gen(function* () {
    return Effect.fn(function* <Req>(
      process: (
        message: cf.ForwardableEmailMessage,
      ) => Effect.Effect<void, unknown, Req>,
    ) {
      const ctx = (yield* RuntimeContext) as unknown as FunctionContext;
      yield* ctx.listen<void, Req>((event) => {
        if (!isWorkerEvent(event) || event.type !== "email") return;

        const message = event.input as cf.ForwardableEmailMessage;
        return process(message).pipe(Effect.catchCause(() => Effect.void));
      });
    }) as EmailEventSourceService;
  }),
);
