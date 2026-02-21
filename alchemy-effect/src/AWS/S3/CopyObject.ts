import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface CopyObjectRequest
  extends Omit<S3.CopyObjectRequest, "Bucket"> {}

export const CopyObject = Binding.make(
  "AWS.S3.CopyObject",
  <B extends Bucket>(bucket: B) =>
    Binding.fn(bucket, function* (request: CopyObjectRequest) {
      return yield* S3.copyObject({
        ...request,
        Bucket: yield* bucket.bucketName(),
      });
    }),
);

export const CopyObjectLambda = Binding.effect(
  [Lambda.Function, CopyObject],
  (func, bucket) =>
    Effect.succeed({
      policyStatements: [
        {
          Sid: "CopyObject",
          Effect: "Allow",
          Action: ["s3:PutObject", "s3:GetObject"],
          Resource: [Output.interpolate`${bucket.bucketArn()}/*`],
        },
      ],
    }),
);
