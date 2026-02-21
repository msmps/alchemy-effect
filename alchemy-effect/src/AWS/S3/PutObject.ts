import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface PutObjectRequest
  extends Omit<S3.PutObjectRequest, "Bucket"> {}

export const PutObject = Binding.make(
  "AWS.S3.PutObject",
  <B extends Bucket>(bucket: B) =>
    Binding.fn(bucket, function* (request: PutObjectRequest) {
      return yield* S3.putObject({
        ...request,
        Bucket: yield* bucket.bucketName(),
      });
    }),
);

export const PutObjectLambda = Binding.effect(
  [Lambda.Function, PutObject],
  (func, bucket) =>
    Effect.succeed({
      policyStatements: [
        {
          Sid: "PutObject",
          Effect: "Allow",
          Action: ["s3:PutObject"],
          Resource: [Output.interpolate`${bucket.bucketArn()}/*`],
        },
      ],
    }),
);
