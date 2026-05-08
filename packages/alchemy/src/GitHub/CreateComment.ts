import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import { type RepoRef } from "./Webhooks.ts";

export interface CreateCommentRequest {
  /**
   * Issue or pull-request number to comment on.
   */
  issueNumber: number;

  /**
   * Comment body (GitHub Markdown).
   */
  body: string;
}

export interface CreateCommentResult {
  commentId: number;
  htmlUrl: string;
  updatedAt: string;
}

export class CreateCommentError extends Data.TaggedError(
  "GitHub.CreateCommentError",
)<{
  message: string;
  status?: number;
  cause: unknown;
}> {}

/**
 * Runtime binding that posts a comment on an issue or pull request in the
 * given repository. Provided by a runtime-specific layer (e.g. the
 * Cloudflare-Workers Live in `Cloudflare/GitHub/Bindings.ts`) that reads
 * the GitHub access token from a runtime-managed secret.
 *
 * @example
 * ```typescript
 * const createComment = yield* GitHub.CreateComment.bind(
 *   "alchemy-run/alchemy-effect",
 * );
 * yield* createComment({ issueNumber: 123, body: "hi" });
 * ```
 */
export class CreateComment extends Binding.Service<
  CreateComment,
  (
    repo: RepoRef,
  ) => Effect.Effect<
    (
      request: CreateCommentRequest,
    ) => Effect.Effect<CreateCommentResult, CreateCommentError, any>
  >
>()("GitHub.CreateComment") {}

/**
 * Deploy-time policy paired with {@link CreateComment}. Each runtime
 * provides a Live implementation that wires the deploy-time GitHub access
 * token into the host (e.g. Cloudflare Worker) via the runtime's secret
 * store. The Policy is consulted via `Effect.serviceOption` at runtime
 * and gracefully no-ops when not provided.
 */
export class CreateCommentPolicy extends Binding.Policy<
  CreateCommentPolicy,
  (repo: RepoRef) => Effect.Effect<void>
>()("GitHub.CreateComment") {}
