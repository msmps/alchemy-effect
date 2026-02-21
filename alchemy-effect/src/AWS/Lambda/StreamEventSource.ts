import type { HttpClient } from "@effect/platform/HttpClient";
import type {
  KinesisStreamBatchResponse,
  KinesisStreamEvent,
  Context as LambdaContext,
} from "aws-lambda";
import type { Credentials } from "distilled-aws/Credentials";
import type { CommonAwsError } from "distilled-aws/Errors";
import * as lambda from "distilled-aws/lambda";
import { Region } from "distilled-aws/Region";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as S from "effect/Schema";

import { declare, type From } from "../../../lib/Capability.ts";
import type { App } from "../../App.ts";
import { Binding } from "../../Binding.ts";
import { createInternalTags, hasTags } from "../../Tags.ts";
import { Account } from "../Account.ts";
import type { Consume, Stream, StreamEvent } from "../Kinesis/Stream.ts";
import { type StreamAttrs, type StreamProps } from "../Kinesis/Stream.ts";
import {
  Function,
  type FunctionBinding,
  type FunctionProps,
} from "./Function.ts";

export type StreamStartingPosition = "TRIM_HORIZON" | "LATEST" | "AT_TIMESTAMP";

export interface StreamEventSourceProps {
  /**
   * The number of records to send to the function in each batch.
   * @default 100
   */
  batchSize?: number;
  /**
   * The maximum amount of time to gather records before invoking the function, in seconds.
   * @default 0
   */
  maxBatchingWindow?: number;
  /**
   * The position in the stream where Lambda starts reading.
   * @default "TRIM_HORIZON"
   */
  startingPosition?: StreamStartingPosition;
  /**
   * The timestamp to start reading from (only used when startingPosition is AT_TIMESTAMP).
   */
  startingPositionTimestamp?: Date;
  /**
   * The number of batches to process from each shard concurrently.
   * @default 1
   */
  parallelizationFactor?: number;
  /**
   * Split a batch on function error and retry the remaining records.
   * @default false
   */
  bisectBatchOnFunctionError?: boolean;
  /**
   * The maximum age of a record that Lambda sends to a function for processing.
   * @default -1 (infinite)
   */
  maximumRecordAgeInSeconds?: number;
  /**
   * The maximum number of times to retry when the function returns an error.
   * @default -1 (infinite)
   */
  maximumRetryAttempts?: number;
  /**
   * The duration of a processing window in seconds for tumbling windows.
   */
  tumblingWindowInSeconds?: number;
  /**
   * Scaling configuration for the event source.
   */
  scalingConfig?: lambda.ScalingConfig;
}

export interface StreamEventSourceAttr extends FunctionBinding {
  uuid: string;
}

export interface StreamEventSource<
  S extends Stream,
  Props extends StreamEventSourceProps,
> extends Binding<
  Function,
  Consume<From<S>>,
  Props,
  StreamEventSourceAttr,
  "StreamEventSource"
> {}

export const StreamEventSource = Binding<
  <S extends Stream, const Props extends StreamEventSourceProps>(
    stream: S,
    props?: Props,
  ) => StreamEventSource<S, Props>
>(Function, "AWS.Kinesis.Consume", "StreamEventSource");

export const StreamEventSourceProvider = () =>
  StreamEventSource.provider.effect(
    Effect.gen(function* () {
      const accountId = yield* Account;
      const region = yield* Region;

      const findEventSourceMapping: (
        stream: {
          id: string;
          attr: StreamAttrs<StreamProps<any>>;
          props: StreamProps<any>;
        },
        functionName: string,
        marker?: string,
      ) => Effect.Effect<
        lambda.EventSourceMappingConfiguration | undefined,
        never,
        App | Credentials | Region | HttpClient
      > = Effect.fn(function* (stream, functionName, marker) {
        const retry = Effect.retry({
          while: (
            e:
              | lambda.InvalidParameterValueException
              | lambda.ResourceNotFoundException
              | lambda.ServiceException
              | lambda.TooManyRequestsException
              | CommonAwsError
              | any,
          ) =>
            e._tag === "InternalFailure" ||
            e._tag === "RequestExpired" ||
            e._tag === "ServiceException" ||
            e._tag === "ServiceUnavailable" ||
            e._tag === "ThrottlingException" ||
            e._tag === "TooManyRequestsException",
          schedule: Schedule.exponential(100),
        });

        const mappings = yield* lambda
          .listEventSourceMappings({
            FunctionName: functionName,
            Marker: marker,
          })
          .pipe(retry, Effect.orDie);
        const mapping = mappings.EventSourceMappings?.find(
          (mapping) => mapping.EventSourceArn === stream.attr.streamArn,
        );
        if (mapping?.EventSourceArn) {
          const { Tags } = yield* lambda
            .listTags({
              Resource: `arn:aws:lambda:${region}:${accountId}:event-source-mapping:${mapping.UUID!}`,
            })
            .pipe(retry, Effect.orDie);
          if (hasTags(yield* createInternalTags(stream.id), Tags)) {
            return mapping;
          }
          return undefined;
        }
        if (mappings.NextMarker) {
          return yield* findEventSourceMapping(
            stream,
            functionName,
            mappings.NextMarker,
          );
        }
        return undefined;
      });

      return {
        attach: ({ source: stream, attr }) => ({
          uuid: attr?.uuid ?? undefined!,
          policyStatements: [
            {
              Sid: "AWS.Kinesis.Consume",
              Effect: "Allow" as const,
              Action: [
                "kinesis:GetRecords",
                "kinesis:GetShardIterator",
                "kinesis:DescribeStream",
                "kinesis:DescribeStreamSummary",
                "kinesis:ListShards",
                "kinesis:ListStreams",
                "kinesis:SubscribeToShard",
              ],
              Resource: [stream.attr.streamArn],
            },
          ],
        }),
        postattach: Effect.fn(function* ({
          source: stream,
          props: {
            batchSize,
            maxBatchingWindow,
            startingPosition,
            startingPositionTimestamp,
            parallelizationFactor,
            bisectBatchOnFunctionError,
            maximumRecordAgeInSeconds,
            maximumRetryAttempts,
            tumblingWindowInSeconds,
            scalingConfig,
          } = {},
          attr,
          target: {
            attr: { functionName },
          },
        }) {
          const config:
            | lambda.CreateEventSourceMappingRequest
            | lambda.UpdateEventSourceMappingRequest = {
            FunctionName: functionName,
            EventSourceArn: stream.attr.streamArn,
            BatchSize: batchSize ?? 100,
            MaximumBatchingWindowInSeconds: maxBatchingWindow,
            StartingPosition: startingPosition ?? "TRIM_HORIZON",
            StartingPositionTimestamp: startingPositionTimestamp,
            ParallelizationFactor: parallelizationFactor,
            BisectBatchOnFunctionError: bisectBatchOnFunctionError,
            MaximumRecordAgeInSeconds: maximumRecordAgeInSeconds,
            MaximumRetryAttempts: maximumRetryAttempts,
            TumblingWindowInSeconds: tumblingWindowInSeconds,
            ScalingConfig: scalingConfig,
            Enabled: true,
            FunctionResponseTypes: ["ReportBatchItemFailures"],
            MetricsConfig: { Metrics: ["EventCount"] },
            Tags: yield* createInternalTags(stream.id),
          };

          const findOrDie = findEventSourceMapping(stream, functionName).pipe(
            Effect.flatMap((mapping) =>
              mapping
                ? Effect.succeed(mapping)
                : Effect.die(
                    new Error(
                      `StreamEventSource(${stream.id}) not found on function ${functionName}`,
                    ),
                  ),
            ),
          );

          const eventSourceMapping = yield* (
            attr?.uuid
              ? lambda.updateEventSourceMapping({
                  ...config,
                  UUID: attr.uuid,
                })
              : lambda.createEventSourceMapping(config)
          ).pipe(
            Effect.catchTags({
              ResourceConflictException: () => findOrDie,
              ResourceNotFoundException: () => findOrDie,
            }),
            Effect.retry({
              while: (e) =>
                e.name === "InvalidParameterValueException" &&
                e.message?.includes(
                  "The function execution role does not have permissions to call",
                ),
              schedule: Schedule.exponential(100),
            }),
            Effect.orDie,
          );
          return {
            ...attr,
            uuid: eventSourceMapping.UUID!,
          };
        }),
        detach: Effect.fn(function* ({
          source: stream,
          target: {
            attr: { functionName },
          },
          attr,
        }) {
          const uuid =
            attr?.uuid ??
            (yield* findEventSourceMapping(stream, functionName))?.UUID;
          if (uuid) {
            yield* lambda
              .deleteEventSourceMapping({
                UUID: uuid,
              })
              .pipe(Effect.catch(() => Effect.void));
          }
        }),
      };
    }),
  );

export const consumeStream =
  <K extends Stream, ID extends string, Req>(
    id: ID,
    {
      stream,
      handle,
      ...eventSourceProps
    }: {
      stream: K;
      handle: (
        event: StreamEvent<K["props"]["schema"]["Type"]>,
        context: LambdaContext,
      ) => Effect.Effect<KinesisStreamBatchResponse | void, never, Req>;
    } & StreamEventSourceProps,
  ) =>
  <const Props extends FunctionProps<Req>>({ bindings, ...props }: Props) =>
    Function(id, {
      handle: Effect.fn(function* (
        event: KinesisStreamEvent,
        context: LambdaContext,
      ) {
        yield* declare<Consume<From<K>>>();
        const records = yield* Effect.all(
          event.Records.map(
            Effect.fn(function* (record) {
              // Decode the Kinesis data from base64
              const decodedData = Buffer.from(
                record.kinesis.data,
                "base64",
              ).toString("utf-8");
              let parsedData: unknown;
              try {
                parsedData = JSON.parse(decodedData);
              } catch {
                // If not JSON, use raw string
                parsedData = decodedData;
              }

              const validatedData = yield* S.validate(stream.props.schema)(
                parsedData,
              ).pipe(Effect.catch(() => Effect.succeed(undefined)));

              return {
                ...record,
                kinesis: {
                  ...record.kinesis,
                  data: validatedData,
                },
              };
            }),
          ),
        );

        const validRecords = records.filter(
          (record) => record.kinesis.data !== undefined,
        );
        const invalidRecords = records.filter(
          (record) => record.kinesis.data === undefined,
        );

        const response = yield* handle(
          {
            Records: validRecords as StreamEvent<
              K["props"]["schema"]["Type"]
            >["Records"],
          },
          context,
        );

        return {
          batchItemFailures: [
            ...(response?.batchItemFailures ?? []),
            ...invalidRecords.map((failed) => ({
              itemIdentifier: failed.kinesis.sequenceNumber,
            })),
          ],
        } satisfies KinesisStreamBatchResponse;
      }),
    })({
      ...props,
      bindings: bindings.and(StreamEventSource(stream, eventSourceProps)),
    });
