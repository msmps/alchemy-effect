import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { GitHubCredentials } from "./Credentials.ts";
import type * as GitHub from "./Providers.ts";

export type WebhookEvent =
  | "push"
  | "pull_request"
  | "pull_request_review"
  | "pull_request_review_comment"
  | "issues"
  | "issue_comment"
  | "release"
  | "workflow_run"
  | "check_run"
  | "check_suite"
  | "create"
  | "delete"
  | "deployment"
  | "deployment_status"
  | "fork"
  | "star"
  | "watch"
  // catch-all so callers can subscribe to other event names without a
  // patch to the union
  | (string & {});

export interface WebhookProps {
  /**
   * Repository owner (user or organization).
   */
  owner: string;

  /**
   * Repository name.
   */
  repository: string;

  /**
   * Public HTTPS URL the webhook delivers to. For Cloudflare Workers this
   * is typically the `workers.dev` URL plus a path (e.g. `/__github/webhook`).
   */
  url: string;

  /**
   * GitHub event names the webhook subscribes to.
   */
  events: WebhookEvent[];

  /**
   * Shared secret for `X-Hub-Signature-256`. The receiving Worker uses the
   * same secret to verify deliveries.
   */
  secret: Redacted.Redacted<string>;

  /**
   * Whether the webhook is active (delivers events).
   * @default true
   */
  active?: boolean;

  /**
   * Content type GitHub posts with.
   * @default "json"
   */
  contentType?: "json" | "form";
}

export interface Webhook extends Resource<
  "GitHub.Webhook",
  WebhookProps,
  {
    /**
     * Numeric ID of the webhook in GitHub.
     */
    hookId: number;
    /**
     * Final URL recorded by GitHub.
     */
    url: string;
  },
  never,
  GitHub.Providers
> {}

/**
 * A repository webhook on GitHub.
 *
 * Installs (and keeps in sync) one webhook on the target repository. The
 * receiving Worker is expected to verify `X-Hub-Signature-256` against
 * `secret` and dispatch by `X-GitHub-Event`.
 *
 * @section Installing a Webhook
 * @example Install a webhook with a generated secret
 * ```typescript
 * const secret = yield* Alchemy.Random("webhook-secret");
 * yield* GitHub.Webhook("ci", {
 *   owner: repo.owner,
 *   repository: repo.name,
 *   url: Output.interpolate`${worker.url}/__github/webhook`,
 *   events: ["pull_request", "issue_comment", "push"],
 *   secret,
 * });
 * ```
 */
export const Webhook = Resource<Webhook>("GitHub.Webhook");

const sameStringSet = (a: readonly string[], b: readonly string[]) => {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((v) => set.has(v));
};

export const WebhookProvider = () =>
  Provider.effect(
    Webhook,
    Effect.gen(function* () {
      const octokit = (yield* GitHubCredentials).octokit();
      return {
        stables: ["hookId"],

        reconcile: Effect.fn(function* ({ news, output }) {
          const config = {
            url: news.url,
            content_type: news.contentType ?? "json",
            secret: Redacted.value(news.secret),
            insecure_ssl: "0",
          } as const;

          // Observe — when we have a cached hookId, refresh from GitHub. A 404
          // means the webhook was deleted out-of-band, so we fall back to
          // (re)creating one.
          const observed = output?.hookId
            ? yield* Effect.tryPromise({
                try: async () => {
                  try {
                    const { data } = await octokit.rest.repos.getWebhook({
                      owner: news.owner,
                      repo: news.repository,
                      hook_id: output.hookId,
                    });
                    return data;
                  } catch (e: any) {
                    if (e.status === 404) return undefined;
                    throw e;
                  }
                },
                catch: (e) => e as Error,
              })
            : undefined;

          if (observed === undefined) {
            // Ensure — POST creates the hook. GitHub tolerates duplicate
            // webhooks pointing at the same URL; we accept that risk because
            // we always cache the hookId and reconcile in place afterwards.
            const { data } = yield* Effect.tryPromise(() =>
              octokit.rest.repos.createWebhook({
                owner: news.owner,
                repo: news.repository,
                events: news.events,
                active: news.active ?? true,
                config,
              }),
            );
            return {
              hookId: data.id,
              url: (data.config?.url as string) ?? news.url,
            };
          }

          // Sync — patch when any observed field drifted from desired.
          const eventsDrift = !sameStringSet(
            observed.events ?? [],
            news.events,
          );
          const activeDrift =
            (observed.active ?? true) !== (news.active ?? true);
          const urlDrift =
            (observed.config?.url as string | undefined) !== news.url;
          const contentTypeDrift =
            (observed.config?.content_type as string | undefined) !==
            config.content_type;

          if (eventsDrift || activeDrift || urlDrift || contentTypeDrift) {
            const { data } = yield* Effect.tryPromise(() =>
              octokit.rest.repos.updateWebhook({
                owner: news.owner,
                repo: news.repository,
                hook_id: observed.id,
                events: news.events,
                active: news.active ?? true,
                config,
              }),
            );
            return {
              hookId: data.id,
              url: (data.config?.url as string) ?? news.url,
            };
          }

          return {
            hookId: observed.id,
            url: (observed.config?.url as string) ?? news.url,
          };
        }),

        delete: Effect.fn(function* ({ olds, output }) {
          yield* Effect.tryPromise(async () => {
            try {
              await octokit.rest.repos.deleteWebhook({
                owner: olds.owner,
                repo: olds.repository,
                hook_id: output.hookId,
              });
            } catch (e: any) {
              if (e.status !== 404) throw e;
            }
          });
        }),
      };
    }),
  );
