import * as s3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import * as ServiceMap from "effect/ServiceMap";
import * as Stream from "effect/Stream";

import * as Lambda from "./AWS/Lambda/index.ts";
import * as Binding from "./Binding.ts";
import * as Construct from "./Construct.ts";
import type { Input } from "./Input.ts";
import * as Output from "./Output/index.ts";
import { Resource } from "./Resource.ts";
import { Stage } from "./Stage.ts";

export interface BucketProps {
  bucketName?: string;
}

export interface Bucket<
  Id extends string = string,
  Props extends BucketProps = BucketProps,
> extends Resource<
  "AWS.S3.Bucket",
  Id,
  Props,
  {
    bucketName: Props["bucketName"] extends undefined
      ? string
      : Props["bucketName"];
    bucketArn: `arn:aws:s3:::${Props["bucketName"] extends undefined
      ? string
      : Props["bucketName"]}`;
  }
> {}

export const Bucket = Resource<{
  <const Id extends string, const Props extends BucketProps = BucketProps>(
    id: Id,
    props?: Props,
  ): Effect.Effect<Bucket<Id, Props>>;
}>("AWS.S3.Bucket");

export interface GetObjectRequest extends Omit<s3.GetObjectRequest, "Bucket"> {}

export const GetObject = Binding.make(
  "AWS.S3.GetObject",
  <B extends Bucket>(bucket: B) =>
    Binding.fn(bucket, function* (request: GetObjectRequest) {
      return yield* s3.getObject({
        Bucket: yield* bucket.bucketName(),
        ...request,
      });
    }),
);

export const GetObjectLambda = Binding.effect(
  [Lambda.Function, GetObject],
  (func, bucket, props) =>
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

export interface PutObjectRequest<
  B extends Bucket<string, BucketProps>,
> extends Omit<s3.PutObjectRequest, "Bucket"> {
  Bucket: B;
}

export const PutObject = Binding.make(
  "AWS.S3.PutObject",
  <B extends Bucket>(bucket: B) =>
    Binding.fn(bucket, function* (input: PutObjectRequest<B>) {
      return yield* s3.putObject({
        ...input,
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
          Action: ["s3:PutObject", "s3:PutObjectVersion"],
          Resource: [Output.interpolate`${bucket.bucketArn()}/*`],
        },
      ],
    }),
);

export interface EventSourceMappingProps {
  FunctionName: Input<string>;
}

export interface EventSourceMapping<
  Id extends string = string,
  Props extends EventSourceMappingProps = never,
> extends Resource<
  "AWS.Lambda.EventSourceMapping",
  Id,
  Props,
  {
    uuid: string;
  }
> {}

export const EventSourceMapping = Resource<{
  <
    const Id extends string,
    const Props extends EventSourceMappingProps = never,
  >(
    id: Id,
    props?: Props,
  ): Effect.Effect<EventSourceMapping<Id, Props>>;
}>("AWS.Lambda.EventSourceMapping");

export class JobsService extends ServiceMap.Service<
  JobsService,
  {
    get(key: string): Effect.Effect<string>;
  }
>()("Jobs") {}

const JobServiceAWS = Construct.effect(
  JobsService,
  Effect.gen(function* () {
    const _stage = yield* Stage;

    const bucket = yield* Bucket("Jobs");

    // Declare GetObject policy upfront
    const getObject = yield* GetObject(bucket);

    return {
      get: (key: string) =>
        // use the getObject accessor
        getObject({
          Key: key,
        }).pipe(
          Effect.flatMap(
            (output) =>
              output.Body?.pipe(Stream.decodeText(), Stream.mkString) ??
              Effect.die("Invalid job body"),
          ),
          Effect.orDie,
        ),
    };
  }),
);

export class Job extends S.Class<Job>("Job")({
  id: S.String,
  name: S.String,
  description: S.String,
}) {}

const JobFunction = Lambda.Function(
  "JobFunction",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    const { get } = yield* JobsService;

    return (event: any) => get(event.key);
  }),
).pipe(Layer.provide(JobServiceAWS));
