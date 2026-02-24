import * as S from "alchemy-effect/Schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Server } from "alchemy-effect";
import { Job } from "../Job.ts";
import { JobStorage } from "../JobStorage.ts";
import { InvalidJobId } from "./InvalidJobId.ts";

export class PutJobRequest extends S.Class<PutJobRequest>("PutJobRequest")({
  content: S.String,
}) {}

export class PutJobResponse extends S.Class<PutJobResponse>("PutJobResponse")({
  job: Job,
}) {}

export class PutJob extends Server.Operation("PutJob", {
  input: PutJobRequest,
  output: PutJobResponse,
  errors: [InvalidJobId],
}) {}

export const putJob = Layer.effect(
  PutJob,
  Effect.gen(function* () {
    const jobStorage = yield* JobStorage;
    return Effect.fn(function* (request: PutJobRequest) {
      yield* jobStorage.putJob(request.job);
    });
  }),
);
