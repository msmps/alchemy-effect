import * as S3 from "alchemy-effect/AWS/S3";
import * as Effect from "effect/Effect";

import { SLayer } from "alchemy-effect";
import type { Job } from "./Job.ts";
import { JobsBucket } from "./JobsBucket.ts";

export class JobStorage extends Context.Tag("JobStorage")<
  JobStorage,
  {
    putJob: (job: Job) => Effect.Effect<void>;
    getJob: (jobId: string) => Effect.Effect<Job | undefined>;
  }
>() {}

export const S3JobStorage = SLayer.effect(
  JobStorage,
  Effect.gen(function* () {
    return {
      putJob: (job) =>
        S3.putObject(JobsBucket, {
          key: job.id,
          body: JSON.stringify(job),
        }).pipe(
          Effect.flatMap(() => Effect.void),
          Effect.orDie,
        ),
      getJob: (jobId) =>
        S3.getObject(JobsBucket, {
          key: jobId,
        }).pipe(
          Effect.map((item) => item.Body as any),
          Effect.orDie,
        ),
    };
  }),
);
