import * as Kinesis from "distilled-aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Stream } from "./Stream.ts";

export interface PutRecordRequest<S extends Stream>
  extends Omit<Kinesis.PutRecordRequest, "StreamName" | "Data"> {
  Data: S["props"]["schema"]["Type"];
}

export const PutRecord = Binding.make(
  "AWS.Kinesis.PutRecord",
  <S extends Stream>(stream: S) =>
    Binding.fn(stream, function* (request: PutRecordRequest<S>) {
      return yield* Kinesis.putRecord({
        ...request,
        StreamName: yield* stream.streamName(),
        Data: new TextEncoder().encode(JSON.stringify(request.Data)),
      });
    }),
);

export const PutRecordLambda = Binding.effect(
  [Lambda.Function, PutRecord],
  (func, stream) =>
    Effect.succeed({
      policyStatements: [
        {
          Sid: "PutRecord",
          Effect: "Allow",
          Action: ["kinesis:PutRecord"],
          Resource: [Output.interpolate`${stream.streamArn()}`],
        },
      ],
    }),
);
