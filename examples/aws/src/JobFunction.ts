import * as Lambda from "alchemy-effect/AWS/Lambda";
import * as S3 from "alchemy-effect/AWS/S3";
import * as SQS from "alchemy-effect/AWS/SQS";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { JobStorage, jobStorage } from "./JobStorage.ts";

export default Lambda.Function(
  "JobFunction",
  Effect.gen(function* () {
    const { bucket, getJob } = yield* JobStorage;
    const queue = yield* SQS.Queue("JobsQueue");
    const sink = yield* SQS.sink(queue);

    yield* S3.notifications(bucket).subscribe((stream) =>
      stream.pipe(
        Stream.flatMap((item) =>
          Stream.fromEffect(getJob(item.key).pipe(Effect.orDie)),
        ),
        Stream.map((msg) => JSON.stringify(msg)),
        Stream.tapSink(sink),
        Stream.runDrain,
      ),
    );

    return {
      main: import.meta.filename,
      memory: 1024,
      runtime: "nodejs22.x",
    };
  }).pipe(Effect.provide(jobStorage)),
);
