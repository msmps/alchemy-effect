import type { HttpClient } from "@effect/platform/HttpClient";
import type {
  DynamoDBBatchResponse,
  DynamoDBStreamEvent,
  Context as LambdaContext,
} from "aws-lambda";
import type { Credentials } from "distilled-aws/Credentials";
import * as dynamodb from "distilled-aws/dynamodb";
import type { CommonAwsError } from "distilled-aws/Errors";
import type * as Lambda from "distilled-aws/lambda";
import * as lambda from "distilled-aws/lambda";
import { Region } from "distilled-aws/Region";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import { declare } from "../../../lib/Capability.ts";
import type { App } from "../../App.ts";
import { Binding } from "../../Binding.ts";
import type { From } from "../../Capability.ts";
import type { Input } from "../../Input.ts";
import { createInternalTags, hasTags } from "../../Tags.ts";
import { Account } from "../Account.ts";
import type { TableEvent } from "../DynamoDB/index.ts";
import type { Consume } from "../DynamoDB/Table.ts";
import * as DynamoDB from "../DynamoDB/Table.ts";
import {
  type AnyTable,
  type TableAttrs,
  type TableProps,
} from "../DynamoDB/Table.ts";
import {
  Function,
  type FunctionBinding,
  type FunctionProps,
} from "./Function.ts";

type StartingPosition = "TRIM_HORIZON" | "LATEST";

type StreamViewType =
  | "KEYS_ONLY"
  | "NEW_IMAGE"
  | "OLD_IMAGE"
  | "NEW_AND_OLD_IMAGES";

export interface TableEventSourceProps {
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
  startingPosition?: StartingPosition;
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
  scalingConfig?: Lambda.ScalingConfig;
  /**
   * The type of data from the table stream to return.
   * @default "NEW_AND_OLD_IMAGES"
   */
  streamViewType?: StreamViewType;
}

export interface TableEventSourceAttr extends FunctionBinding {
  uuid: string;
  streamArn: string;
}

export interface TableEventSource<
  T extends AnyTable,
  Props extends TableEventSourceProps,
> extends Binding<
  Function,
  Consume<From<T>>,
  Props,
  TableEventSourceAttr,
  "TableEventSource"
> {}

export const TableEventSource = Binding<
  <T extends AnyTable, const Props extends TableEventSourceProps>(
    table: T,
    props?: Props,
  ) => TableEventSource<T, Props>
>(Function, "AWS.DynamoDB.Consume", "TableEventSource");

export const TableEventSourceProvider = () =>
  TableEventSource.provider.effect(
    Effect.gen(function* () {
      const accountId = yield* Account;
      const region = yield* Region;

      const waitForTableActive = (tableName: string) =>
        Effect.gen(function* () {
          while (true) {
            const description = yield* dynamodb
              .describeTable({ TableName: tableName })
              .pipe(Effect.orDie);
            if (description.Table?.TableStatus === "ACTIVE") {
              return description;
            }
            yield* Effect.sleep(1000);
          }
        });

      const enableStreamsOnTable = (
        tableName: string,
        streamViewType: StreamViewType,
      ) =>
        Effect.gen(function* () {
          // First check if streams are already enabled
          const description = yield* dynamodb
            .describeTable({ TableName: tableName })
            .pipe(Effect.orDie);

          if (description.Table?.StreamSpecification?.StreamEnabled) {
            // Streams already enabled, return existing stream ARN
            return description.Table.LatestStreamArn!;
          }

          // Enable streams on the table
          yield* dynamodb
            .updateTable({
              TableName: tableName,
              StreamSpecification: {
                StreamEnabled: true,
                StreamViewType: streamViewType,
              },
            })
            .pipe(
              Effect.retry({
                while: (e) => e.name === "ResourceInUseException",
                schedule: Schedule.exponential(100),
              }),
              Effect.orDie,
            );

          // Wait for table to be active and get stream ARN
          const updated = yield* waitForTableActive(tableName);
          return updated.Table?.LatestStreamArn!;
        });

      const findEventSourceMapping: (
        table: {
          id: string;
          attr: TableAttrs<Input.Resolve<TableProps>>;
          props: TableProps;
        },
        streamArn: string,
        functionName: string,
        marker?: string,
      ) => Effect.Effect<
        Lambda.EventSourceMappingConfiguration | undefined,
        never,
        App | Credentials | Region | HttpClient
      > = Effect.fn(function* (table, streamArn, functionName, marker) {
        const retry = Effect.retry({
          while: (
            e:
              | Lambda.InvalidParameterValueException
              | Lambda.ResourceNotFoundException
              | Lambda.ServiceException
              | Lambda.TooManyRequestsException
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
          (mapping) => mapping.EventSourceArn === streamArn,
        );

        if (mapping?.EventSourceArn) {
          const { Tags } = yield* lambda
            .listTags({
              Resource: `arn:aws:lambda:${region}:${accountId}:event-source-mapping:${mapping.UUID!}`,
            })
            .pipe(retry, Effect.orDie);
          if (hasTags(yield* createInternalTags(table.id), Tags)) {
            return mapping;
          }
          return undefined;
        }
        if (mappings.NextMarker) {
          return yield* findEventSourceMapping(
            table,
            streamArn,
            functionName,
            mappings.NextMarker,
          );
        }
        return undefined;
      });

      return {
        attach: ({ source: table, attr }) => ({
          uuid: attr?.uuid ?? undefined!,
          streamArn: attr?.streamArn ?? undefined!,
          policyStatements: [
            {
              Sid: "AWSDynamoDBConsume",
              Effect: "Allow" as const,
              Action: [
                "dynamodb:GetRecords",
                "dynamodb:GetShardIterator",
                "dynamodb:DescribeStream",
                "dynamodb:ListStreams",
              ],
              Resource: [`${table.attr.tableArn}/stream/*`],
            },
          ],
        }),
        postattach: Effect.fn(function* ({
          source: table,
          props = {},
          attr,
          target: {
            attr: { functionName },
          },
        }) {
          const {
            batchSize,
            maxBatchingWindow,
            startingPosition,
            parallelizationFactor,
            bisectBatchOnFunctionError,
            maximumRecordAgeInSeconds,
            maximumRetryAttempts,
            tumblingWindowInSeconds,
            scalingConfig,
          } = props;
          const streamViewType: StreamViewType =
            props.streamViewType ?? "NEW_AND_OLD_IMAGES";

          // Enable streams on the table and get the stream ARN
          const streamArn = yield* enableStreamsOnTable(
            table.attr.tableName,
            streamViewType,
          );

          const config:
            | Lambda.CreateEventSourceMappingRequest
            | Lambda.UpdateEventSourceMappingRequest = {
            FunctionName: functionName,
            EventSourceArn: streamArn,
            BatchSize: batchSize ?? 100,
            MaximumBatchingWindowInSeconds: maxBatchingWindow,
            StartingPosition: startingPosition ?? "TRIM_HORIZON",
            ParallelizationFactor: parallelizationFactor,
            BisectBatchOnFunctionError: bisectBatchOnFunctionError,
            MaximumRecordAgeInSeconds: maximumRecordAgeInSeconds,
            MaximumRetryAttempts: maximumRetryAttempts,
            TumblingWindowInSeconds: tumblingWindowInSeconds,
            ScalingConfig: scalingConfig,
            Enabled: true,
            FunctionResponseTypes: ["ReportBatchItemFailures"],
            MetricsConfig: { Metrics: ["EventCount"] },
            Tags: yield* createInternalTags(table.id),
          };

          const findOrDie = findEventSourceMapping(
            table,
            streamArn,
            functionName,
          ).pipe(
            Effect.flatMap((mapping) =>
              mapping
                ? Effect.succeed(mapping)
                : Effect.die(
                    new Error(
                      `TableEventSource(${table.id}) not found on function ${functionName}`,
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
              // It takes a few seconds for IAM policies to propagate
              while: (e) =>
                e.name === "InvalidParameterValueException" &&
                (e.message?.includes(
                  "The function execution role does not have permissions to call",
                ) ||
                  e.message?.includes("Cannot access stream") ||
                  e.message?.includes(
                    "Please ensure the role can perform the GetRecords",
                  )),
              schedule: Schedule.exponential(100).pipe(
                Schedule.both(Schedule.recurs(30)),
              ),
            }),
            Effect.orDie,
          );

          return {
            ...attr,
            uuid: eventSourceMapping.UUID!,
            streamArn,
          };
        }),
        detach: Effect.fn(function* ({
          source: table,
          target: {
            attr: { functionName },
          },
          attr,
        }) {
          if (attr?.uuid) {
            yield* lambda
              .deleteEventSourceMapping({
                UUID: attr.uuid,
              })
              .pipe(Effect.catch(() => Effect.void));
          } else if (attr?.streamArn) {
            const mapping = yield* findEventSourceMapping(
              table,
              attr.streamArn,
              functionName,
            );
            if (mapping?.UUID) {
              yield* lambda
                .deleteEventSourceMapping({
                  UUID: mapping.UUID,
                })
                .pipe(Effect.catch(() => Effect.void));
            }
          }
        }),
      };
    }),
  );

export const consumeTable =
  <T extends DynamoDB.AnyTable, ID extends string, Req>(
    id: ID,
    {
      table,
      handle,
      ...eventSourceProps
    }: {
      table: T;
      handle: (
        event: TableEvent<InstanceType<T["props"]["items"]>>,
        context: LambdaContext,
      ) => Effect.Effect<DynamoDBBatchResponse | void, never, Req>;
    } & TableEventSourceProps,
  ) =>
  <const Props extends FunctionProps<Req>>({ bindings, ...props }: Props) =>
    Function(id, {
      handle: Effect.fn(function* (
        event: DynamoDBStreamEvent,
        context: LambdaContext,
      ) {
        yield* declare<Consume<From<T>>>();

        // Pass the event directly to the handler
        // The DynamoDB stream records contain dynamodb.NewImage and dynamodb.OldImage
        // which are already in the correct format (AttributeValue maps)
        // The user's handle function receives typed records based on the table's items type
        const response = yield* handle(
          event as unknown as TableEvent<InstanceType<T["props"]["items"]>>,
          context,
        );

        return {
          batchItemFailures: response?.batchItemFailures ?? [],
        } satisfies DynamoDBBatchResponse;
      }),
    })({
      ...props,
      bindings: bindings.and(TableEventSource(table, eventSourceProps)),
    });
