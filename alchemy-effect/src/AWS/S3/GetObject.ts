import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface GetObjectRequest
  extends Omit<S3.GetObjectRequest, "Bucket"> {}

export const GetObject = Binding.make(
  "AWS.S3.GetObject",
  <B extends Bucket>(bucket: B) =>
    Binding.fn(bucket, function* (request: GetObjectRequest) {
      return yield* S3.getObject({
        ...request,
        Bucket: yield* bucket.bucketName(),
      });
    }),
);

export const GetObjectLambda = Binding.effect(
  [Lambda.Function, GetObject],
  (func, bucket) =>
    Effect.succeed({
      policyStatements: [
        {
          Sid: "GetObject",
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:GetObjectVersion"],
          Resource: [Output.interpolate`${bucket.bucketArn()}/*`],
        },
      ],
    }),
);
