import type * as lambda from "aws-lambda";
import { Region } from "distilled-aws/Region";
import * as sqs from "distilled-aws/sqs";
import * as SQS from "distilled-aws/sqs";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as S from "effect/Schema";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import * as Lambda from "../Lambda/index.ts";

import { createPhysicalName } from "../../PhysicalName.ts";
import { Resource } from "../../Resource.ts";
import { Account } from "../Account.ts";

export type QueueRecord<Data> = Omit<lambda.SQSRecord, "body"> & {
  body: Data;
};

export type QueueEvent<Data> = Omit<lambda.SQSEvent, "Records"> & {
  Records: QueueRecord<Data>[];
};

export const Consume = Binding.make(
  "AWS.SQS.Consume",
  <Q extends Queue>(queue: Q) =>
    Binding.fn(queue, function* () {
      return yield* SQS.receiveMessage({
        QueueUrl: yield* queue.queueUrl(),
      });
    }),
);

export const ConsumeFromLambdaFunction = Binding.effect(
  [Lambda.Function, Consume],
  (func, queue) =>
    Effect.succeed({
      policyStatements: [
        {
          Sid: "Consume",
          Effect: "Allow",
          Action: ["sqs:ReceiveMessage"],
          Resource: [Output.interpolate`${queue.queueArn()}/*`],
        },
      ],
    }),
);

export const Queue = Resource<{
  <const ID extends string, const Props extends QueueProps>(
    id: ID,
    props: Props,
  ): Effect.Effect<Queue<ID, Props>>;
}>("AWS.SQS.Queue");

export interface Queue<
  ID extends string = string,
  Props extends QueueProps = QueueProps,
> extends Resource<"AWS.SQS.Queue", ID, Props, QueueAttrs<Props>> {}

export type QueueAttrs<Props extends QueueProps> = {
  queueName: Props["queueName"] extends string ? Props["queueName"] : string;
  queueUrl: Props["fifo"] extends true ? `${string}.fifo` : string;
  queueArn: `arn:aws:sqs:${string}:${string}:${Props["queueName"]}`;
};

export type QueueProps<Msg = any> = {
  /**
   * Schema for the message body.
   */
  schema: S.Schema<Msg>;
  /**
   * Name of the queue.
   * @default ${app}-${stage}-${id}?.fifo
   */
  queueName?: string;
  /**
   * Delay in seconds for all messages in the queue (`0` - `900`).
   * @default 0
   */
  delaySeconds?: number;
  /**
   * Maximum message size in bytes (`1,024` - `1,048,576`).
   * @default 1048576
   */
  maximumMessageSize?: number;
  /**
   * Message retention period in seconds (`60` - `1,209,600`).
   * @default 345600
   */
  messageRetentionPeriod?: number;
  /**
   * Time in seconds for `ReceiveMessage` to wait for a message (`0` - `20`).
   * @default 0
   */
  receiveMessageWaitTimeSeconds?: number;
  /**
   * Visibility timeout in seconds (`0` - `43,200`).
   * @default 30
   */
  visibilityTimeout?: number;
} & (
  | {
      fifo?: false;
      contentBasedDeduplication?: undefined;
      deduplicationScope?: undefined;
      fifoThroughputLimit?: undefined;
    }
  | {
      fifo: true;
      /**
       * Enables content-based deduplication for FIFO queues. Only valid when `fifo` is `true`.
       * @default false
       */
      contentBasedDeduplication?: boolean;
      /**
       * Specifies whether message deduplication occurs at the message group or queue level.
       * Valid values are `messageGroup` and `queue`. Only valid when `fifo` is `true`.
       */
      deduplicationScope?: "messageGroup" | "queue";
      /**
       * Specifies whether the FIFO queue throughput quota applies to the entire queue or per message group.
       * Valid values are `perQueue` and `perMessageGroupId`. Only valid when `fifo` is `true`.
       */
      fifoThroughputLimit?: "perQueue" | "perMessageGroupId";
    }
);

export const QueueProvider = () =>
  Queue.provider.effect(
    Effect.gen(function* () {
      const region = yield* Region;
      const accountId = yield* Account;
      const createQueueName = (
        id: string,
        props: {
          queueName?: string | undefined;
          fifo?: boolean;
        },
      ) =>
        Effect.gen(function* () {
          if (props.queueName) {
            return props.queueName;
          }
          const baseName = yield* createPhysicalName({
            id,
            maxLength: props.fifo ? 80 - ".fifo".length : 80,
          });
          return props.fifo ? `${baseName}.fifo` : baseName;
        });
      const createAttributes = (props: QueueProps) => {
        const baseAttributes: Record<string, string | undefined> = {
          DelaySeconds: props.delaySeconds?.toString(),
          MaximumMessageSize: props.maximumMessageSize?.toString(),
          MessageRetentionPeriod: props.messageRetentionPeriod?.toString(),
          ReceiveMessageWaitTimeSeconds:
            props.receiveMessageWaitTimeSeconds?.toString(),
          VisibilityTimeout: props.visibilityTimeout?.toString(),
        };

        if (props.fifo) {
          return {
            ...baseAttributes,
            FifoQueue: "true",
            FifoThroughputLimit: props.fifoThroughputLimit,
            ContentBasedDeduplication: props.contentBasedDeduplication
              ? "true"
              : "false",
            DeduplicationScope: props.deduplicationScope,
          };
        }

        return baseAttributes;
      };
      return {
        stables: ["queueName", "queueUrl", "queueArn"],
        diff: Effect.fn(function* ({ id, news, olds }) {
          const oldFifo = olds.fifo ?? false;
          const newFifo = news.fifo ?? false;
          if (oldFifo !== newFifo) {
            return { action: "replace" } as const;
          }
          const oldQueueName = yield* createQueueName(id, olds);
          const newQueueName = yield* createQueueName(id, news);
          if (oldQueueName !== newQueueName) {
            return { action: "replace" } as const;
          }
          // Return undefined to allow update function to be called for other attribute changes
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const queueName = yield* createQueueName(id, news);
          const response = yield* sqs
            .createQueue({
              QueueName: queueName,
              Attributes: createAttributes(news),
            })
            .pipe(
              Effect.retry({
                while: (e) => e.name === "QueueDeletedRecently",
                schedule: Schedule.fixed(1000).pipe(
                  Schedule.tapOutput((i) =>
                    session.note(
                      `Queue was deleted recently, retrying... ${i + 1}s`,
                    ),
                  ),
                ),
              }),
            );
          const queueArn =
            `arn:aws:sqs:${region}:${accountId}:${queueName}` as const;
          const queueUrl = response.QueueUrl!;
          yield* session.note(queueUrl);
          return {
            queueName,
            queueUrl,
            queueArn: queueArn,
          };
        }),
        update: Effect.fn(function* ({ news, output, session }) {
          yield* sqs.setQueueAttributes({
            QueueUrl: output.queueUrl,
            Attributes: createAttributes(news),
          });
          yield* session.note(output.queueUrl);
          return output;
        }),
        delete: Effect.fn(function* (input) {
          yield* sqs
            .deleteQueue({
              QueueUrl: input.output.queueUrl,
            })
            .pipe(Effect.catchTag("QueueDoesNotExist", () => Effect.void));
        }),
      };
    }),
  );
