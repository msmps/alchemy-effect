import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";

import * as S3 from "alchemy-effect/AWS/S3";

import type { Job } from "./Job.ts";

export class JobStorage extends ServiceMap.Service<
  JobStorage,
  {
    bucket: S3.Bucket;
    putJob(job: Job): Effect.Effect<void>;
    getJob(jobId: string): Effect.Effect<Job | undefined>;
  }
>()("JobStorage") {}

export const jobStorage = Layer.effect(
  JobStorage,
  Effect.gen(function* () {
    const bucket = yield* S3.Bucket("JobsBucket");
    const putObject = yield* S3.PutObject(bucket);
    const getObject = yield* S3.GetObject(bucket);

    return JobStorage.of({
      bucket,
      putJob: (job) =>
        putObject({
          Key: job.id,
          Body: JSON.stringify(job),
        }).pipe(
          Effect.flatMap(() => Effect.void),
          Effect.orDie,
        ),
      getJob: (jobId) =>
        getObject({
          Key: jobId,
        }).pipe(
          Effect.map((item) => item.Body as any),
          Effect.orDie,
        ),
    });
  }),
);
