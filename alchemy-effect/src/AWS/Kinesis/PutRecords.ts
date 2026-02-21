import * as Kinesis from "distilled-aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Stream } from "./Stream.ts";

export interface PutRecordsRequestEntry<S extends Stream>
  extends Omit<Kinesis.PutRecordsRequestEntry, "Data"> {
  Data: S["props"]["schema"]["Type"];
}

export interface PutRecordsRequest<S extends Stream>
  extends Omit<Kinesis.PutRecordsRequest, "StreamName" | "Records"> {
  Records: PutRecordsRequestEntry<S>[];
}

export const PutRecords = Binding.make(
  "AWS.Kinesis.PutRecords",
  <S extends Stream>(stream: S) =>
    Binding.fn(stream, function* (request: PutRecordsRequest<S>) {
      return yield* Kinesis.putRecords({
        ...request,
        StreamName: yield* stream.streamName(),
        Records: request.Records.map((r) => ({
          ...r,
          Data: new TextEncoder().encode(JSON.stringify(r.Data)),
        })),
      });
    }),
);

export const PutRecordsLambda = Binding.effect(
  [Lambda.Function, PutRecords],
  (func, stream) =>
    Effect.succeed({
      policyStatements: [
        {
          Sid: "PutRecords",
          Effect: "Allow",
          Action: ["kinesis:PutRecords"],
          Resource: [Output.interpolate`${stream.streamArn()}`],
        },
      ],
    }),
);
