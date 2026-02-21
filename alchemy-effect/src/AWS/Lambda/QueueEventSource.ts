import type { HttpClient } from "@effect/platform/HttpClient";
import type {
  Context as LambdaContext,
  SQSBatchResponse,
  SQSEvent,
} from "aws-lambda";
import type { Credentials } from "distilled-aws/Credentials";
import type { CommonAwsError } from "distilled-aws/Errors";
import type * as Lambda from "distilled-aws/lambda";
import * as lambda from "distilled-aws/lambda";
import { Region } from "distilled-aws/Region";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as S from "effect/Schema";

import type { App } from "../../App.ts";
import { Binding } from "../../Binding.ts";
import type { From } from "../../Capability.ts";
import { declare } from "../../Capability.ts";
import { createInternalTags, hasTags } from "../../Tags.ts";
import { Account } from "../Account.ts";
import type { Consume, QueueEvent } from "../SQS/Queue.ts";
import * as Queue from "../SQS/Queue.ts";
import {
  Function,
  type FunctionBinding,
  type FunctionProps,
} from "./Function.ts";

export interface QueueEventSourceProps {
  batchSize?: number;
  maxBatchingWindow?: number;
  scalingConfig?: Lambda.ScalingConfig;
}

export interface QueueEventSourceAttr extends FunctionBinding {
  uuid: string;
}

export interface QueueEventSource<
  Q extends Queue.Queue,
  Props extends QueueEventSourceProps,
> extends Binding<
  Function,
  Queue.Consume<From<Q>>,
  Props,
  QueueEventSourceAttr,
  "QueueEventSource"
> {}

export const QueueEventSource = Binding<
  <Q extends Queue.Queue, const Props extends QueueEventSourceProps>(
    queue: Q,
    props?: Props,
  ) => QueueEventSource<Q, Props>
>(Function, "AWS.SQS.Consume", "QueueEventSource");

export const QueueEventSourceProvider = () =>
  QueueEventSource.provider.effect(
    Effect.gen(function* () {
      const accountId = yield* Account;
      const region = yield* Region;

      const findEventSourceMapping: (
        queue: {
          id: string;
          attr: Queue.QueueAttrs<Queue.QueueProps<any>>;
          props: Queue.QueueProps<any>;
        },
        functionName: string,
        marker?: string,
      ) => Effect.Effect<
        Lambda.EventSourceMappingConfiguration | undefined,
        never,
        App | Credentials | Region | HttpClient
      > = Effect.fn(function* (queue, functionName, marker) {
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
            // TODO(sam): figure out how to write a function that generalizes this or upstream into distilled-aws
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
          (mapping) => mapping.EventSourceArn === queue.attr.queueArn,
        );
        if (mapping?.EventSourceArn) {
          const { Tags } = yield* lambda
            .listTags({
              Resource: `arn:aws:lambda:${region}:${accountId}:event-source-mapping:${mapping.UUID!}`,
            })
            .pipe(retry, Effect.orDie);
          if (hasTags(yield* createInternalTags(queue.id), Tags)) {
            return mapping;
          }
          return undefined;
        }
        if (mappings.NextMarker) {
          return yield* findEventSourceMapping(
            queue,
            functionName,
            mappings.NextMarker,
          );
        }
        return undefined;
      });

      return {
        attach: ({ source: queue, attr }) => ({
          // TODO(sam): bit of a broken model here - we can't know the UUID until post-attach
          uuid: attr?.uuid ?? undefined!,
          // we need the policies to be present before the event source mapping is created
          policyStatements: [
            {
              Sid: "AWS.SQS.Consume",
              Effect: "Allow" as const,
              Action: [
                "sqs:ReceiveMessage",
                "sqs:DeleteMessage",
                "sqs:ChangeMessageVisibility",
                "sqs:GetQueueAttributes",
                "sqs:GetQueueUrl",
              ],
              Resource: [queue.attr.queueArn],
            },
          ],
        }),
        postattach: Effect.fn(function* ({
          source: queue,
          props: { batchSize, maxBatchingWindow, scalingConfig } = {},
          attr,
          target: {
            attr: { functionName },
          },
        }) {
          const config:
            | Lambda.CreateEventSourceMappingRequest
            | Lambda.UpdateEventSourceMappingRequest = {
            FunctionName: functionName,
            EventSourceArn: queue.attr.queueArn,
            BatchSize: batchSize,
            MaximumBatchingWindowInSeconds: maxBatchingWindow,
            ScalingConfig: scalingConfig,
            Enabled: true,
            FunctionResponseTypes: ["ReportBatchItemFailures"],
            // https://docs.aws.amazon.com/lambda/latest/dg/monitoring-metrics-types.html#event-source-mapping-metrics
            MetricsConfig: { Metrics: ["EventCount"] },
            // KMSKeyArn: (encrypted FilterCriteria)

            // See: https://docs.aws.amazon.com/lambda/latest/dg/invocation-eventfiltering.html
            // FilterCriteria: {
            //   Filters: [{Pattern: ""}]
            // }
            Tags: yield* createInternalTags(queue.id),
          };

          const findOrDie = findEventSourceMapping(queue, functionName).pipe(
            Effect.flatMap((mapping) =>
              mapping
                ? Effect.succeed(mapping)
                : Effect.die(
                    // how the fuck did we get here?
                    new Error(
                      `QueueEventSource(${queue.id}) not found on function ${functionName}`,
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
              // It takes a few seconds for the IAM policy to propagate, so retry the following error
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
          source: queue,
          target: {
            attr: { functionName },
          },
          attr,
        }) {
          const uuid =
            attr?.uuid ??
            (yield* findEventSourceMapping(queue, functionName))?.UUID;
          if (uuid) {
            // we found (or were aware of) the event source mapping, so we can delete it
            yield* lambda
              .deleteEventSourceMapping({
                UUID: uuid,
              })
              // TODO(sam): handle errors properly
              .pipe(Effect.catch(() => Effect.void));
          }
        }),
      };
    }),
  );

export const consumeQueue =
  <Q extends Queue.Queue, ID extends string, Req>(
    id: ID,
    {
      queue,
      handle,
    }: {
      queue: Q;
      handle: (
        event: QueueEvent<Q["props"]["schema"]["Type"]>,
        context: LambdaContext,
      ) => Effect.Effect<SQSBatchResponse | void, never, Req>;
    },
  ) =>
  <const Props extends FunctionProps<Req>>({ bindings, ...props }: Props) =>
    Function(id, {
      handle: Effect.fn(function* (event: SQSEvent, context: LambdaContext) {
        yield* declare<Consume<From<Q>>>();
        const records = yield* Effect.all(
          event.Records.map(
            Effect.fn(function* (record) {
              return {
                ...record,
                body: yield* S.validate(queue.props.schema)(record.body).pipe(
                  Effect.catch(() => Effect.void),
                ),
              };
            }),
          ),
        );
        const response = yield* handle(
          {
            Records: records.filter((record) => record.body !== undefined),
          },
          context,
        );
        return {
          batchItemFailures: [
            ...(response?.batchItemFailures ?? []),
            ...records
              .filter((record) => record.body === undefined)
              .map((failed) => ({
                itemIdentifier: failed.messageId,
              })),
          ],
        } satisfies SQSBatchResponse;
      }),
    })({ ...props, bindings: bindings.and(QueueEventSource(queue)) });
