import * as S from "alchemy-effect/Schema";
import { JobId } from "../Job.ts";

export class InvalidJobId extends S.TaggedErrorClass<InvalidJobId>()(
  "InvalidJobId",
  {
    message: S.String,
    jobId: JobId,
  },
) {}
