import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import { WorkerEnvironment } from "../Workers/Worker.ts";

/**
 * Stable LogicalIds for the per-account Secrets Store and the shared
 * GitHub access-token Secret created by the GitHub binding policies.
 *
 * Cloudflare enforces a one-Secrets-Store-per-account limit, so the
 * webhook event-source and the comment bindings share a single Store
 * resource (deduped by LogicalId). Stable IDs also let multiple GitHub
 * bindings on the same worker share a single access-token Secret.
 */
export const GITHUB_SECRETS_STORE_ID = "GitHubSecretsStore";
export const GITHUB_ACCESS_TOKEN_SECRET_ID = "GitHubAccessToken";

/**
 * Read the GitHub access token at runtime from the Cloudflare Secrets
 * Store binding wired by the comment-binding policies. Dies if the
 * binding is missing (i.e. the user forgot to provide one of the
 * `*PolicyLive` layers).
 */
export const readGitHubAccessToken = Effect.gen(function* () {
  const env = (yield* WorkerEnvironment) as Record<
    string,
    cf.SecretsStoreSecret | undefined
  >;
  const binding = env[GITHUB_ACCESS_TOKEN_SECRET_ID];
  if (!binding) {
    return yield* Effect.die(
      new Error(
        `GitHub access token secret binding '${GITHUB_ACCESS_TOKEN_SECRET_ID}' missing on worker. Did you forget to provide CreateCommentPolicyLive / UpdateCommentPolicyLive?`,
      ),
    );
  }
  return yield* Effect.tryPromise({
    try: () => binding.get(),
    catch: (cause) =>
      new Error(`Failed to read GitHub access token: ${String(cause)}`),
  }).pipe(Effect.orDie);
});
