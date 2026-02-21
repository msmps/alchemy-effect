import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import type { Input } from "../../Input.ts";
import { Resource } from "../../Resource.ts";
import type { PolicyDocument } from "../IAM/index.ts";
import type { BucketName } from "./Bucket.ts";

export interface BucketPolicyProps {
  /**
   * Name of the bucket to attach the policy to.
   */
  bucket: Input<BucketName>;
  /**
   * The policy document to apply.
   */
  policy: Input<PolicyDocument>;
}

export interface BucketPolicyAttrs<
  Props extends Input.Resolve<BucketPolicyProps>,
> {
  /**
   * Name of the bucket the policy is attached to.
   */
  bucket: Props["bucket"];
}

export const BucketPolicy = Resource<{
  <const ID extends string, const Props extends BucketPolicyProps>(
    id: ID,
    props: Props,
  ): Effect.Effect<BucketPolicy<ID, Props>>;
}>("AWS.S3.BucketPolicy");

export interface BucketPolicy<
  ID extends string = string,
  Props extends BucketPolicyProps = BucketPolicyProps,
> extends Resource<
  "AWS.S3.BucketPolicy",
  ID,
  Props,
  BucketPolicyAttrs<Input.Resolve<Props>>
> {}

export const BucketPolicyProvider = () =>
  BucketPolicy.provider.effect(
    Effect.gen(function* () {
      return {
        stables: ["bucket"],
        diff: Effect.fn(function* ({ news, olds }) {
          // Bucket change requires replacement
          if (olds.bucket !== news.bucket) {
            return { action: "replace" } as const;
          }
        }),
        create: Effect.fn(function* ({ news, session }) {
          const bucket = news.bucket as string;

          yield* S3.putBucketPolicy({
            Bucket: bucket,
            Policy: JSON.stringify(news.policy),
          }).pipe(Effect.orDie);

          yield* session.note(`Applied policy to bucket: ${bucket}`);

          return {
            bucket,
          };
        }),
        update: Effect.fn(function* ({ news, output, session }) {
          yield* S3.putBucketPolicy({
            Bucket: output.bucket,
            Policy: JSON.stringify(news.policy),
          }).pipe(Effect.orDie);

          yield* session.note(`Updated policy on bucket: ${output.bucket}`);
          return output;
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* S3.deleteBucketPolicy({
            Bucket: output.bucket,
          }).pipe(
            Effect.catchTag("NoSuchBucket", () => Effect.void),
            Effect.orDie,
          );

          yield* session.note(`Removed policy from bucket: ${output.bucket}`);
        }),
      };
    }),
  );
