import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface ListObjectsV2Request
  extends Omit<S3.ListObjectsV2Request, "Bucket"> {}

export const ListObjectsV2 = Binding.make(
  "AWS.S3.ListObjectsV2",
  <B extends Bucket>(bucket: B) =>
    Binding.fn(bucket, function* (request?: ListObjectsV2Request) {
      return yield* S3.listObjectsV2({
        ...request,
        Bucket: yield* bucket.bucketName(),
      });
    }),
);

export const ListObjectsV2Lambda = Binding.effect(
  [Lambda.Function, ListObjectsV2],
  (func, bucket) =>
    Effect.succeed({
      policyStatements: [
        {
          Sid: "ListObjectsV2",
          Effect: "Allow",
          Action: ["s3:ListBucket"],
          Resource: [Output.interpolate`${bucket.bucketArn()}`],
        },
      ],
    }),
);
