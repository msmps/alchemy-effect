import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface HeadObjectRequest
  extends Omit<S3.HeadObjectRequest, "Bucket"> {}

export const HeadObject = Binding.make(
  "AWS.S3.HeadObject",
  <B extends Bucket>(bucket: B) =>
    Binding.fn(bucket, function* (request: HeadObjectRequest) {
      return yield* S3.headObject({
        ...request,
        Bucket: yield* bucket.bucketName(),
      });
    }),
);

export const HeadObjectLambda = Binding.effect(
  [Lambda.Function, HeadObject],
  (func, bucket) =>
    Effect.succeed({
      policyStatements: [
        {
          Sid: "HeadObject",
          Effect: "Allow",
          Action: ["s3:GetObject"],
          Resource: [Output.interpolate`${bucket.bucketArn()}/*`],
        },
      ],
    }),
);
