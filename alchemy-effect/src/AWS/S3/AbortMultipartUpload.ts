import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface AbortMultipartUploadRequest
  extends Omit<S3.AbortMultipartUploadRequest, "Bucket"> {}

export const AbortMultipartUpload = Binding.make(
  "AWS.S3.AbortMultipartUpload",
  <B extends Bucket>(bucket: B) =>
    Binding.fn(bucket, function* (request: AbortMultipartUploadRequest) {
      return yield* S3.abortMultipartUpload({
        ...request,
        Bucket: yield* bucket.bucketName(),
      });
    }),
);

export const AbortMultipartUploadLambda = Binding.effect(
  [Lambda.Function, AbortMultipartUpload],
  (func, bucket) =>
    Effect.succeed({
      policyStatements: [
        {
          Sid: "AbortMultipartUpload",
          Effect: "Allow",
          Action: ["s3:AbortMultipartUpload"],
          Resource: [Output.interpolate`${bucket.bucketArn()}/*`],
        },
      ],
    }),
);
