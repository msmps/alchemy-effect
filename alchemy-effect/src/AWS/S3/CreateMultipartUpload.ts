import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface CreateMultipartUploadRequest
  extends Omit<S3.CreateMultipartUploadRequest, "Bucket"> {}

export const CreateMultipartUpload = Binding.make(
  "AWS.S3.CreateMultipartUpload",
  <B extends Bucket>(bucket: B) =>
    Binding.fn(bucket, function* (request: CreateMultipartUploadRequest) {
      return yield* S3.createMultipartUpload({
        ...request,
        Bucket: yield* bucket.bucketName(),
      });
    }),
);

export const CreateMultipartUploadLambda = Binding.effect(
  [Lambda.Function, CreateMultipartUpload],
  (func, bucket) =>
    Effect.succeed({
      policyStatements: [
        {
          Sid: "CreateMultipartUpload",
          Effect: "Allow",
          Action: ["s3:PutObject"],
          Resource: [Output.interpolate`${bucket.bucketArn()}/*`],
        },
      ],
    }),
);
