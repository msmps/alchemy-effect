import * as Effect from "effect/Effect";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { GitHubCredentials } from "./Credentials.ts";
import type * as GitHub from "./Providers.ts";

export interface RepositoryProps {
  /**
   * Repository owner (user or organization).
   */
  owner: string;

  /**
   * Repository name (the slug after the owner — no slashes).
   */
  name: string;

  /**
   * Short description shown on the repository page.
   */
  description?: string;

  /**
   * Whether the repository is private. Ignored when adopting an existing
   * repository — use `adopt: true` and reconcile separately if you need to
   * change visibility.
   * @default false
   */
  private?: boolean;

  /**
   * Topics applied to the repository. The provider always merges these with
   * the internal `alchemy:{appId}:{logicalId}` topic used as the ownership
   * marker (GitHub repos don't take freeform tags).
   */
  topics?: string[];

  /**
   * Default branch for the repository.
   */
  defaultBranch?: string;

  /**
   * Whether the repository has issues enabled.
   * @default true
   */
  hasIssues?: boolean;

  /**
   * Whether to auto-initialize with an empty README on first creation.
   * Ignored on subsequent reconciles.
   * @default false
   */
  autoInit?: boolean;

  /**
   * If `true` and the repository already exists, adopt it. Without this,
   * pre-existing repos fail the read step with an Unowned signal.
   * @default false
   */
  adopt?: boolean;

  /**
   * If `true`, the repository will be deleted from GitHub when the resource
   * is destroyed. Defaults to `false` to avoid accidental data loss — by
   * default the resource is removed from Alchemy state but the repo on
   * GitHub is left intact.
   * @default false
   */
  delete?: boolean;

  /**
   * Optional override for the GitHub auth token. Defaults to
   * `GITHUB_ACCESS_TOKEN` / `GITHUB_TOKEN` / `gh auth token` via the
   * `GitHubCredentials` service.
   */
  token?: string;
}

export interface Repository extends Resource<
  "GitHub.Repository",
  RepositoryProps,
  {
    /**
     * Numeric repository ID assigned by GitHub. Stable across renames.
     */
    repositoryId: number;
    /**
     * Repository node ID (GraphQL global ID).
     */
    nodeId: string;
    /**
     * `owner/name` form, matches what GitHub shows in URLs.
     */
    fullName: string;
    /**
     * Browser URL, e.g. `https://github.com/owner/name`.
     */
    htmlUrl: string;
    /**
     * HTTPS clone URL, e.g. `https://github.com/owner/name.git`.
     */
    cloneUrl: string;
    /**
     * The actual default branch reported by the API after reconcile.
     */
    defaultBranch: string;
  },
  never,
  GitHub.Providers
> {}

/**
 * A GitHub repository — managed or adopted.
 *
 * `Repository` either creates a new repo under the configured owner or adopts
 * an existing one (when `adopt: true`). Owner is treated as a stable property
 * — changing it triggers a replacement.
 *
 * Authentication resolves through the `GitHubCredentials` service supplied by
 * `GitHub.providers()`.
 *
 * @section Creating a Repository
 * @example Personal repository
 * ```typescript
 * const repo = yield* GitHub.Repository("ci", {
 *   owner: "alice",
 *   name: "ci-demo",
 *   description: "CI pipeline driven by Alchemy",
 *   private: true,
 *   autoInit: true,
 * });
 * ```
 *
 * @section Adopting an Existing Repository
 * @example Adopt an existing repo
 * ```typescript
 * const repo = yield* GitHub.Repository("alchemy-effect", {
 *   owner: "alchemy-run",
 *   name: "alchemy-effect",
 *   adopt: true,
 * });
 * ```
 */
export const Repository = Resource<Repository>("GitHub.Repository");

const ownershipTopic = (id: string) => `alchemy.${id.toLowerCase()}`;

export const RepositoryProvider = () =>
  Provider.effect(
    Repository,
    Effect.gen(function* () {
      const octokit = (yield* GitHubCredentials).octokit();
      return {
        stables: ["repositoryId", "nodeId"],

        reconcile: Effect.fn(function* ({ id, news, output }) {
          const marker = ownershipTopic(id);
          const desiredTopics = Array.from(
            new Set([...(news.topics ?? []), marker]),
          );

          // Observe — try to fetch the repo; treat 404 as "missing".
          const observed = yield* Effect.tryPromise({
            try: async () => {
              try {
                const { data } = await octokit.rest.repos.get({
                  owner: news.owner,
                  repo: news.name,
                });
                return data;
              } catch (e: any) {
                if (e.status === 404) return undefined;
                throw e;
              }
            },
            catch: (e) => e as Error,
          });

          // Ensure — create when missing. We do not check for ownership marker
          // when `adopt: true`; the engine adoption flow handled that upstream.
          let current = observed;
          if (current === undefined) {
            const { data } = yield* Effect.tryPromise(async () => {
              // GitHub uses different endpoints for user vs organization repos;
              // probe the owner type and dispatch.
              const ownerInfo = await octokit.rest.users
                .getByUsername({ username: news.owner })
                .catch((e: any) => {
                  if (e.status === 404) return undefined;
                  throw e;
                });
              if (ownerInfo?.data.type === "Organization") {
                return octokit.rest.repos.createInOrg({
                  org: news.owner,
                  name: news.name,
                  description: news.description,
                  private: news.private ?? false,
                  has_issues: news.hasIssues ?? true,
                  auto_init: news.autoInit ?? false,
                });
              }
              return octokit.rest.repos.createForAuthenticatedUser({
                name: news.name,
                description: news.description,
                private: news.private ?? false,
                has_issues: news.hasIssues ?? true,
                auto_init: news.autoInit ?? false,
              });
            });
            current = data;
          }

          // Sync — patch metadata if it drifted.
          const needsPatch =
            current.description !== (news.description ?? null) ||
            (news.hasIssues !== undefined &&
              current.has_issues !== news.hasIssues) ||
            (news.defaultBranch !== undefined &&
              current.default_branch !== news.defaultBranch);
          if (needsPatch) {
            const { data } = yield* Effect.tryPromise(() =>
              octokit.rest.repos.update({
                owner: news.owner,
                repo: news.name,
                description: news.description,
                has_issues: news.hasIssues,
                default_branch: news.defaultBranch,
              }),
            );
            current = data;
          }

          // Sync topics — replace with desired set whenever the observed list
          // doesn't already match.
          const observedTopics = new Set(current.topics ?? []);
          const sameTopics =
            observedTopics.size === desiredTopics.length &&
            desiredTopics.every((t) => observedTopics.has(t));
          if (!sameTopics) {
            yield* Effect.tryPromise(() =>
              octokit.rest.repos.replaceAllTopics({
                owner: news.owner,
                repo: news.name,
                names: desiredTopics,
              }),
            );
          }

          return {
            repositoryId: current.id,
            nodeId: current.node_id,
            fullName: current.full_name,
            htmlUrl: current.html_url,
            cloneUrl: current.clone_url,
            defaultBranch: current.default_branch,
          };
        }),

        delete: Effect.fn(function* ({ olds }) {
          // Only delete the GitHub repo when the user explicitly opted in via
          // `delete: true`. Otherwise we just drop the resource from state and
          // leave the repo on GitHub intact.
          if (!olds.delete) return;
          // TODO(sam): add this back in when no longer terrifed of blowing my head off
          // yield* Effect.tryPromise(async () => {
          //   try {
          //     await octokit.rest.repos.delete({
          //       owner: olds.owner,
          //       repo: olds.name,
          //     });
          //   } catch (e: any) {
          //     if (e.status !== 404) throw e;
          //   }
          // });
        }),
      };
    }),
  );
