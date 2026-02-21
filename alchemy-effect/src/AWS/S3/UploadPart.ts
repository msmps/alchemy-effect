import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface UploadPartRequest
  extends Omit<S3.UploadPartRequest, "Bucket"> {}

export const UploadPart = Binding.make(
  "AWS.S3.UploadPart",
  <B extends Bucket>(bucket: B) =>
    Binding.fn(bucket, function* (request: UploadPartRequest) {
      return yield* S3.uploadPart({
        ...request,
        Bucket: yield* bucket.bucketName(),
      });
    }),
);

export const UploadPartLambda = Binding.effect(
  [Lambda.Function, UploadPart],
  (func, bucket) =>
    Effect.succeed({
      policyStatements: [
        {
          Sid: "UploadPart",
          Effect: "Allow",
          Action: ["s3:PutObject"],
          Resource: [Output.interpolate`${bucket.bucketArn()}/*`],
        },
      ],
    }),
);
