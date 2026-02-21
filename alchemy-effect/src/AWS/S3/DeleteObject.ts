import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface DeleteObjectRequest
  extends Omit<S3.DeleteObjectRequest, "Bucket"> {}

export const DeleteObject = Binding.make(
  "AWS.S3.DeleteObject",
  <B extends Bucket>(bucket: B) =>
    Binding.fn(bucket, function* (request: DeleteObjectRequest) {
      return yield* S3.deleteObject({
        ...request,
        Bucket: yield* bucket.bucketName(),
      });
    }),
);

export const DeleteObjectLambda = Binding.effect(
  [Lambda.Function, DeleteObject],
  (func, bucket) =>
    Effect.succeed({
      policyStatements: [
        {
          Sid: "DeleteObject",
          Effect: "Allow",
          Action: ["s3:DeleteObject", "s3:DeleteObjectVersion"],
          Resource: [Output.interpolate`${bucket.bucketArn()}/*`],
        },
      ],
    }),
);
