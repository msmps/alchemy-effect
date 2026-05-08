import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import { type RepoRef } from "./Webhooks.ts";

export interface UpdateCommentRequest {
  /**
   * Numeric ID of the comment to update.
   */
  commentId: number;

  /**
   * New comment body (GitHub Markdown).
   */
  body: string;
}

export interface UpdateCommentResult {
  commentId: number;
  htmlUrl: string;
  updatedAt: string;
}

export class UpdateCommentError extends Data.TaggedError(
  "GitHub.UpdateCommentError",
)<{
  message: string;
  status?: number;
  cause: unknown;
}> {}

/**
 * Runtime binding that updates an existing issue or pull-request comment
 * in the given repository. Paired with {@link UpdateCommentPolicy} which
 * is provided by a runtime-specific layer.
 *
 * @example
 * ```typescript
 * const updateComment = yield* GitHub.UpdateComment.bind(
 *   "alchemy-run/alchemy-effect",
 * );
 * yield* updateComment({ commentId: 12345, body: "edited" });
 * ```
 */
export class UpdateComment extends Binding.Service<
  UpdateComment,
  (
    repo: RepoRef,
  ) => Effect.Effect<
    (
      request: UpdateCommentRequest,
    ) => Effect.Effect<UpdateCommentResult, UpdateCommentError, any>
  >
>()("GitHub.UpdateComment") {}

/**
 * Deploy-time policy paired with {@link UpdateComment}.
 */
export class UpdateCommentPolicy extends Binding.Policy<
  UpdateCommentPolicy,
  (repo: RepoRef) => Effect.Effect<void>
>()("GitHub.UpdateComment") {}
