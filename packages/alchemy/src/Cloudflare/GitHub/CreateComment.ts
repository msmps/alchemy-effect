import { Octokit } from "@octokit/rest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  CreateComment,
  CreateCommentError,
  CreateCommentPolicy,
  type CreateCommentRequest,
} from "../../GitHub/CreateComment.ts";
import { GitHubCredentials } from "../../GitHub/Credentials.ts";
import { parseRepo, type RepoRef } from "../../GitHub/Webhooks.ts";
import * as Cloudflare from "../SecretsStore/index.ts";
import { isWorker } from "../Workers/Worker.ts";
import {
  GITHUB_ACCESS_TOKEN_SECRET_ID,
  GITHUB_SECRETS_STORE_ID,
  readGitHubAccessToken,
} from "./Token.ts";

/**
 * Cloudflare-Workers runtime implementation of {@link CreateComment}.
 * Reads the GitHub access token bound by {@link CreateCommentPolicyLive}
 * at runtime, then issues a `POST /repos/{owner}/{repo}/issues/{n}/comments`.
 */
export const CreateCommentLive = Layer.effect(
  CreateComment,
  Effect.gen(function* () {
    const Policy = yield* CreateCommentPolicy;
    return Effect.fn(function* (repo: RepoRef) {
      const parsed = parseRepo(repo);
      yield* Policy(parsed);
      return Effect.fn(function* (request: CreateCommentRequest) {
        const token = yield* readGitHubAccessToken;
        return yield* Effect.tryPromise({
          try: async () => {
            const octokit = new Octokit({ auth: token });
            const { data } = await octokit.rest.issues.createComment({
              owner: parsed.owner,
              repo: parsed.repository,
              issue_number: request.issueNumber,
              body: request.body,
            });
            return {
              commentId: data.id,
              htmlUrl: data.html_url,
              updatedAt: data.updated_at,
            };
          },
          catch: (cause: any) =>
            new CreateCommentError({
              message: cause?.message ?? "Failed to create comment",
              status: cause?.status,
              cause,
            }),
        });
      });
    });
  }),
);

/**
 * Deploy-time policy: provisions the shared GitHub access-token secret
 * in the per-account Secrets Store and binds it into the host worker.
 * Resources dedupe by stable LogicalId so multiple GitHub bindings on
 * the same worker share one Store + Secret.
 */
export const CreateCommentPolicyLive = CreateCommentPolicy.layer.effect(
  Effect.gen(function* () {
    const bindSecret = yield* Cloudflare.SecretBindingPolicy;
    const credentials = yield* GitHubCredentials;
    const Store = yield* Cloudflare.SecretsStore;
    const Secret = yield* Cloudflare.Secret;
    return Effect.fn(function* (host, _repo) {
      if (!isWorker(host)) {
        return yield* Effect.die(
          new Error(
            `GitHub.CreateCommentPolicy does not support runtime '${host.Type}'.`,
          ),
        );
      }
      const store = yield* Store(GITHUB_SECRETS_STORE_ID);
      const secret = yield* Secret(GITHUB_ACCESS_TOKEN_SECRET_ID, {
        store,
        value: credentials.token,
      });
      yield* bindSecret(secret);
    });
  }),
);
