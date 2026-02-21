import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface CompleteMultipartUploadRequest
  extends Omit<S3.CompleteMultipartUploadRequest, "Bucket"> {}

export const CompleteMultipartUpload = Binding.make(
  "AWS.S3.CompleteMultipartUpload",
  <B extends Bucket>(bucket: B) =>
    Binding.fn(bucket, function* (request: CompleteMultipartUploadRequest) {
      return yield* S3.completeMultipartUpload({
        ...request,
        Bucket: yield* bucket.bucketName(),
      });
    }),
);

export const CompleteMultipartUploadLambda = Binding.effect(
  [Lambda.Function, CompleteMultipartUpload],
  (func, bucket) =>
    Effect.succeed({
      policyStatements: [
        {
          Sid: "CompleteMultipartUpload",
          Effect: "Allow",
          Action: ["s3:PutObject"],
          Resource: [Output.interpolate`${bucket.bucketArn()}/*`],
        },
      ],
    }),
);
