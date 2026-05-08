import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * Reference to a GitHub repository: either an `"owner/repository"` string
 * or an explicit object.
 */
export type RepoRef = string | { owner: string; repository: string };

export interface ParsedRepoRef {
  owner: string;
  repository: string;
}

/**
 * Stable slug for a `(owner, repository)` pair used as a prefix for
 * resource LogicalIds and URL paths.
 */
export const repoSlug = (repo: ParsedRepoRef): string =>
  `${repo.owner}-${repo.repository}`;

/**
 * Default URL path the runtime layer hosts the webhook receiver at.
 * Each repo gets its own path so a single worker can host receivers
 * for many repos without collision.
 */
export const defaultWebhookPath = (repo: ParsedRepoRef): string =>
  `/__alchemy/github/${repo.owner}/${repo.repository}/webhook`;

export const parseRepo = (repo: RepoRef): ParsedRepoRef => {
  if (typeof repo === "string") {
    const [owner, repository, ...rest] = repo.split("/");
    if (!owner || !repository || rest.length > 0) {
      throw new Error(
        `Invalid repository reference '${repo}'. Expected format 'owner/repository'.`,
      );
    }
    return { owner, repository };
  }
  return repo;
};

/**
 * The set of webhook event names alchemy ships fine-grained payload types
 * for. `"*"` subscribes to every event GitHub fires; the payload is typed
 * as `unknown` so user code can narrow it.
 *
 * This is intentionally a loose `string` union so users can pass any GitHub
 * event name without us shipping the full `@octokit/webhooks-types` table.
 * Payloads default to `unknown` and can be cast/parsed in the handler.
 */
export type WebhookEventName =
  | "*"
  | "push"
  | "pull_request"
  | "pull_request_review"
  | "pull_request_review_comment"
  | "issues"
  | "issue_comment"
  | "release"
  | "workflow_run"
  | "workflow_job"
  | "check_run"
  | "check_suite"
  | "create"
  | "delete"
  | "fork"
  | "star"
  | "watch"
  | "ping"
  | (string & {});

/**
 * Map from event name to its payload type. Without an additional type
 * package each payload is `unknown`; user handlers can narrow as needed.
 */
export type WebhookPayloads = {
  [K in WebhookEventName]: unknown;
};

export interface EventsProps {
  /**
   * GitHub event names this subscription receives.
   * @default ["*"]
   */
  events?: ReadonlyArray<WebhookEventName>;

  /**
   * Whether the webhook is delivered events.
   * @default true
   */
  active?: boolean;

  /**
   * Override the URL path the worker listens on. Useful when multiple
   * `events()` subscriptions share a worker. If omitted, a deterministic
   * path is derived from `owner` and `repository`.
   */
  path?: string;
}

/**
 * Map of event-name -> handler. Each handler receives a single GitHub
 * webhook event payload. Handlers may yield other Effect services (`Req`).
 */
export type EventHandlers<Req> = {
  [K in WebhookEventName]?: (
    event: WebhookPayloads[K],
  ) => Effect.Effect<void, never, Req>;
};

/**
 * Internal callable shape implemented by per-runtime layers (e.g. the
 * Cloudflare-Workers `WebhookEventSource` Layer in
 * `packages/alchemy/src/Cloudflare/GitHub/Webhooks.ts`). Each call wires
 * the per-host webhook + secret + listen handler.
 */
export type WebhookEventSourceService = <Req = never>(
  repo: ParsedRepoRef,
  props: EventsProps,
  handlers: EventHandlers<Req>,
) => Effect.Effect<void, never, Req>;

/**
 * Runtime-agnostic event source for GitHub webhooks. Concrete runtimes
 * provide a `Layer.effect(WebhookEventSource, ...)` that knows how to
 * stand up the webhook resource, host the HMAC-verifying receiver, and
 * dispatch events to user handlers. See
 * `packages/alchemy/src/Cloudflare/GitHub/Webhooks.ts` for the
 * Cloudflare-Workers implementation.
 */
export class WebhookEventSource extends Context.Service<
  WebhookEventSource,
  WebhookEventSourceService
>()("GitHub.WebhookEventSource") {}

/**
 * Subscribe to GitHub webhook events on a repository.
 *
 * The runtime layer creates the webhook resource on GitHub, stores the
 * webhook secret in the runtime's secret store, and registers an HTTP
 * receiver that verifies the `X-Hub-Signature-256` HMAC and dispatches
 * the parsed payload to the matching handler.
 *
 * @example
 * ```typescript
 * yield* GitHub.events("alchemy-run/alchemy-effect", {
 *   events: ["push", "pull_request"],
 * }).on({
 *   push: Effect.fn(function* (event) {
 *     yield* Effect.log("push", event);
 *   }),
 *   pull_request: Effect.fn(function* (event) {
 *     yield* Effect.log("pull_request", event);
 *   }),
 * });
 * ```
 */
export const events = (repo: RepoRef, props: EventsProps = {}) => {
  const parsed = parseRepo(repo);
  return {
    on: <Req>(handlers: EventHandlers<Req>) =>
      WebhookEventSource.use((source) => source(parsed, props, handlers)),
  };
};
