import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { WebhookDelivery, WebhookEventName } from "./Events.ts";
import type * as GitHubProviders from "./Providers.ts";
import type { RepoRef } from "./Webhooks.ts";

/**
 * Per-event handler used by {@link on}. The payload is narrowed to the
 * matching `WebhookEventMap[E]`, so destructuring is fully typed.
 */
export type EventHandlers = {
  [E in WebhookEventName]?: (
    delivery: WebhookDelivery<E>,
  ) => Effect.Effect<void, any, any>;
};

/**
 * Service-level abstraction for subscribing to GitHub webhook events.
 *
 * Mirrors the {@link AWS.SQS.QueueEventSource} pattern: this file declares
 * the contract (`WebhookEventSource` Context.Service + the `on` helper),
 * and a runtime-specific layer provides the implementation. The
 * Cloudflare implementation lives in `Cloudflare/GitHub/Webhooks.ts` and
 * does two things on each `on(repo, handlers)` call:
 *
 *   1. Registers each handler on the repo dispatcher so verified
 *      deliveries are routed at runtime.
 *   2. Yields a `GitHub.Webhook` resource pointed at the host worker so
 *      GitHub actually starts delivering those event names — no need to
 *      declare the webhook separately in `alchemy.run.ts`.
 *
 * @example
 * ```typescript
 * yield* GitHub.on(repo, {
 *   push: ({ payload }) =>
 *     Effect.gen(function* () {
 *       if (payload.deleted) return;
 *       yield* buildSha(payload.after, payload.ref);
 *     }),
 *   pull_request_review: ({ payload }) =>
 *     Effect.gen(function* () {
 *       if (payload.review.state !== "changes_requested") return;
 *       yield* respondToReview(payload);
 *     }),
 *   release: ({ payload }) =>
 *     Effect.gen(function* () {
 *       if (payload.action !== "published") return;
 *       yield* releaseBlog(payload.release.tag_name);
 *     }),
 * });
 * ```
 */
export class WebhookEventSource extends Context.Service<
  WebhookEventSource,
  WebhookEventSourceService
>()("GitHub.WebhookEventSource") {}

export type WebhookEventSourceService = (
  repo: RepoRef,
  handlers: EventHandlers,
) => Effect.Effect<void, never, GitHubProviders.Providers>;

/**
 * Subscribe to a set of webhook events for a repository. The keys of
 * `handlers` both pick which events to subscribe to and declare a typed
 * handler per event. Requires a {@link WebhookEventSource} layer to be
 * provided — typically via the runtime layer for the host platform
 * (e.g. `Cloudflare.GitHub.Webhooks.live(secret)`).
 */
export const on = (repo: RepoRef, handlers: EventHandlers) =>
  WebhookEventSource.use((source) => source(repo, handlers));
