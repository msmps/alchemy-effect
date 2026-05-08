import { Octokit } from "@octokit/rest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { GitHubCredentials } from "../../GitHub/Credentials.ts";
import {
  UpdateComment,
  UpdateCommentError,
  UpdateCommentPolicy,
  type UpdateCommentRequest,
} from "../../GitHub/UpdateComment.ts";
import { parseRepo, type RepoRef } from "../../GitHub/Webhooks.ts";
import * as Cloudflare from "../SecretsStore/index.ts";
import { isWorker } from "../Workers/Worker.ts";
import {
  GITHUB_ACCESS_TOKEN_SECRET_ID,
  GITHUB_SECRETS_STORE_ID,
  readGitHubAccessToken,
} from "./Token.ts";

/**
 * Cloudflare-Workers runtime implementation of {@link UpdateComment}.
 * Reads the GitHub access token bound by {@link UpdateCommentPolicyLive}
 * at runtime, then issues a `PATCH /repos/{owner}/{repo}/issues/comments/{id}`.
 */
export const UpdateCommentLive = Layer.effect(
  UpdateComment,
  Effect.gen(function* () {
    const Policy = yield* UpdateCommentPolicy;
    return Effect.fn(function* (repo: RepoRef) {
      const parsed = parseRepo(repo);
      yield* Policy(parsed);
      return Effect.fn(function* (request: UpdateCommentRequest) {
        const token = yield* readGitHubAccessToken;
        return yield* Effect.tryPromise({
          try: async () => {
            const octokit = new Octokit({ auth: token });
            const { data } = await octokit.rest.issues.updateComment({
              owner: parsed.owner,
              repo: parsed.repository,
              comment_id: request.commentId,
              body: request.body,
            });
            return {
              commentId: data.id,
              htmlUrl: data.html_url,
              updatedAt: data.updated_at,
            };
          },
          catch: (cause: any) =>
            new UpdateCommentError({
              message: cause?.message ?? "Failed to update comment",
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
 * (deduped with {@link CreateCommentPolicyLive} via stable LogicalId)
 * and binds it into the host worker.
 */
export const UpdateCommentPolicyLive = UpdateCommentPolicy.layer.effect(
  Effect.gen(function* () {
    const bindSecret = yield* Cloudflare.SecretBindingPolicy;
    const credentials = yield* GitHubCredentials;
    const Store = yield* Cloudflare.SecretsStore;
    const Secret = yield* Cloudflare.Secret;
    return Effect.fn(function* (host, _repo) {
      if (!isWorker(host)) {
        return yield* Effect.die(
          new Error(
            `GitHub.UpdateCommentPolicy does not support runtime '${host.Type}'.`,
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
