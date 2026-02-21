import { Bus } from "alchemy-effect";
import * as S3 from "alchemy-effect/AWS/S3";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { decodeJob, Job } from "./Job.ts";
import { JobsBucket } from "./JobsBucket.ts";

// declare an Event Source containing Job events
export class JobQueue extends Bus.EventSource("JobQueue", {
  schema: Job,
}) {}

// Implement the Event Source (consume from S3 and emit Job events)
export const S3JobQueue = JobQueue.layer(
  Effect.gen(function* () {
    // this only runs at runtime, but it projects a S3.Consume<Jobs> capability requirement
    return S3.consumeBucketNotifications(JobsBucket).pipe(
      Stream.flatMap((item) =>
        Stream.fromIterable(item.Records.map((record) => record.s3.object)),
      ),
      Stream.mapEffect((object) =>
        S3.getObject(JobsBucket, {
          key: object.key,
          ifMatch: object.eTag,
        }).pipe(Effect.orDie),
      ),
      Stream.mapEffect((object) =>
        object.Body
          ? object.Body.pipe(
              Stream.decodeText(),
              Stream.mkString,
              Effect.flatMap((body) =>
                Effect.try({
                  try: () => JSON.parse(body),
                  catch: (error) => Effect.fail(error),
                }),
              ),
              Effect.flatMap(decodeJob),
            )
          : Effect.die("Invalid job body"),
      ),
      Stream.orDie,
    );
  }),
);
