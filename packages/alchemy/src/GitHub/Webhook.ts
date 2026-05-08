import { Octokit } from "@octokit/rest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  GitHubCredentials,
  type GitHubCredentialsService,
} from "./Credentials.ts";
import * as GitHub from "./Providers.ts";

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
   * The webhook payload URL. GitHub will POST events to this URL.
   */
  url: string;

  /**
   * Shared secret used to compute the HMAC `X-Hub-Signature-256` header on
   * each delivery. Treated as redacted and never logged.
   */
  secret: Redacted.Redacted<string>;

  /**
   * GitHub event names this webhook subscribes to. Use `["*"]` to receive
   * every event, or pass a specific list (e.g. `["push", "pull_request"]`).
   * @default ["*"]
   */
  events?: ReadonlyArray<string>;

  /**
   * Whether the webhook is active and should deliver events.
   * @default true
   */
  active?: boolean;

  /**
   * Content type GitHub uses for the request body.
   * @default "json"
   */
  contentType?: "json" | "form";

  /**
   * Whether to verify TLS certificates when delivering events.
   * @default false (`insecure_ssl: "0"`)
   */
  insecureSsl?: boolean;

  /**
   * GitHub API token. If omitted, falls back to `GITHUB_ACCESS_TOKEN` /
   * `GITHUB_TOKEN` env vars and finally the resolved `GitHubCredentials`.
   */
  token?: string;
}

export type Webhook = Resource<
  "GitHub.Webhook",
  WebhookProps,
  {
    /**
     * The numeric ID GitHub assigns to this webhook within the repository.
     */
    hookId: number;

    /**
     * Repository owner (user or organization).
     */
    owner: string;

    /**
     * Repository name.
     */
    repository: string;

    /**
     * The active payload URL configured on GitHub.
     */
    url: string;
  },
  never,
  GitHub.Providers
>;

/**
 * A GitHub repository webhook.
 *
 * `Webhook` owns the lifecycle of a single webhook on a repository. The
 * webhook is created on first deploy, updated in place when `url`,
 * `events`, `secret`, or `active` change, and deleted on teardown.
 *
 * Authentication is resolved in order: explicit `token` prop,
 * `GITHUB_ACCESS_TOKEN`, `GITHUB_TOKEN`, then the configured
 * `GitHubCredentials` layer.
 *
 * Most users do not instantiate `Webhook` directly; the
 * `GitHub.events(repo).on(handlers)` helper running inside a Cloudflare
 * Worker creates one automatically and wires its secret into the worker.
 *
 * @section Creating Webhooks
 * @example Webhook on a repository
 * ```typescript
 * const webhook = yield* GitHub.Webhook("RepoWebhook", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   url: "https://example.com/github/webhook",
 *   secret: Redacted.make(process.env.WEBHOOK_SECRET!),
 *   events: ["push", "pull_request"],
 * });
 * ```
 */
export const Webhook = Resource<Webhook>("GitHub.Webhook");

const resolveToken = (
  props: WebhookProps,
  creds: GitHubCredentialsService,
): string => {
  return (
    props.token ??
    process.env.GITHUB_ACCESS_TOKEN ??
    process.env.GITHUB_TOKEN ??
    Redacted.value(creds.token)
  );
};

const createClient = (
  props: WebhookProps,
  creds: GitHubCredentialsService,
): Octokit => new Octokit({ auth: resolveToken(props, creds) });

const insecureSslValue = (insecureSsl: boolean | undefined): "0" | "1" =>
  insecureSsl ? "1" : "0";

const arraysEqual = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
};

export const WebhookProvider = () =>
  Provider.effect(
    Webhook,
    Effect.gen(function* () {
      const credentials = yield* GitHubCredentials;

      return Webhook.Provider.of({
        stables: ["hookId", "owner", "repository"],

        diff: Effect.fn(function* ({ news, olds = {} as WebhookProps }) {
          if (!isResolved(news)) return undefined;
          if (
            news.owner !== olds.owner ||
            news.repository !== olds.repository
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ olds, output }) {
          if (!output?.hookId) return undefined;
          const octokit = createClient(olds, credentials);
          const observed = yield* Effect.tryPromise({
            try: async () => {
              try {
                const { data } = await octokit.rest.repos.getWebhook({
                  owner: output.owner,
                  repo: output.repository,
                  hook_id: output.hookId,
                });
                return data;
              } catch (error: any) {
                if (error.status === 404) return undefined;
                throw error;
              }
            },
            catch: (e) => e as Error,
          });
          if (!observed) return undefined;
          return {
            hookId: observed.id,
            owner: output.owner,
            repository: output.repository,
            url: (observed.config?.url as string) ?? output.url,
          };
        }),

        reconcile: Effect.fn(function* ({ news, output }) {
          const octokit = createClient(news, credentials);
          const events = news.events ?? ["*"];
          const active = news.active ?? true;
          const contentType = news.contentType ?? "json";
          const insecure_ssl = insecureSslValue(news.insecureSsl);
          const secret = Redacted.value(news.secret);

          // Observe — probe the cached hookId; on 404 (deleted out-of-band)
          // we fall through to the create branch.
          let observed:
            | {
                id: number;
                config: {
                  url?: string | null;
                  content_type?: string | null;
                  insecure_ssl?: string | null;
                };
                events: string[];
                active: boolean;
              }
            | undefined;
          if (output?.hookId) {
            observed = yield* Effect.tryPromise({
              try: async () => {
                try {
                  const { data } = await octokit.rest.repos.getWebhook({
                    owner: news.owner,
                    repo: news.repository,
                    hook_id: output.hookId,
                  });
                  return data as any;
                } catch (error: any) {
                  if (error.status === 404) return undefined;
                  throw error;
                }
              },
              catch: (e) => e as Error,
            });
          }

          // Ensure — POST to create when missing. GitHub returns 422 if a
          // webhook with the same URL already exists; we adopt it via a
          // listWebhooks scan in that case.
          if (!observed) {
            observed = yield* Effect.tryPromise({
              try: async () => {
                try {
                  const { data } = await octokit.rest.repos.createWebhook({
                    owner: news.owner,
                    repo: news.repository,
                    name: "web",
                    active,
                    events: [...events],
                    config: {
                      url: news.url,
                      content_type: contentType,
                      insecure_ssl,
                      secret,
                    },
                  });
                  return data as any;
                } catch (error: any) {
                  // 422 = "Hook already exists on this repository" — adopt.
                  if (error.status === 422) {
                    const list = await octokit.paginate(
                      octokit.rest.repos.listWebhooks,
                      {
                        owner: news.owner,
                        repo: news.repository,
                        per_page: 100,
                      },
                    );
                    const match = list.find(
                      (h: any) => h.config?.url === news.url,
                    );
                    if (!match) {
                      throw new Error(
                        `Webhook for url '${news.url}' on ${news.owner}/${news.repository} already exists but could not be located via listWebhooks.`,
                      );
                    }
                    return match;
                  }
                  throw error;
                }
              },
              catch: (e) => e as Error,
            });
          }

          // Sync — diff observed config against desired and PATCH only
          // the delta. Note: GitHub never returns the secret, so we
          // can't diff it. The secret value is sourced from a
          // `Random` resource (deterministic-in-state), so it doesn't
          // change between reconciles unless the user explicitly
          // rotates it; in that case the upstream resource id changes
          // and reconcile re-runs naturally.
          const observedConfig = observed!.config ?? {};
          const needsConfigUpdate =
            observedConfig.url !== news.url ||
            observedConfig.content_type !== contentType ||
            observedConfig.insecure_ssl !== insecure_ssl;
          const needsEventsUpdate = !arraysEqual(observed!.events, events);
          const needsActiveUpdate = observed!.active !== active;

          if (needsConfigUpdate || needsEventsUpdate || needsActiveUpdate) {
            const updated = yield* Effect.tryPromise(() =>
              octokit.rest.repos.updateWebhook({
                owner: news.owner,
                repo: news.repository,
                hook_id: observed!.id,
                active,
                events: [...events],
                config: {
                  url: news.url,
                  content_type: contentType,
                  insecure_ssl,
                  secret,
                },
              }),
            );
            return {
              hookId: updated.data.id,
              owner: news.owner,
              repository: news.repository,
              url: (updated.data.config?.url as string) ?? news.url,
            };
          }

          return {
            hookId: observed!.id,
            owner: news.owner,
            repository: news.repository,
            url: (observedConfig.url as string) ?? news.url,
          };
        }),

        delete: Effect.fn(function* ({ olds, output }) {
          const octokit = createClient(olds, credentials);
          yield* Effect.tryPromise(async () => {
            try {
              await octokit.rest.repos.deleteWebhook({
                owner: output.owner,
                repo: output.repository,
                hook_id: output.hookId,
              });
            } catch (error: any) {
              if (error.status !== 404) throw error;
            }
          });
        }),
      });
    }),
  );
