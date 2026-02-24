import * as sqs from "distilled-aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import { Runtime } from "../../Runtime.ts";
import * as AWS from "../index.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Queue } from "./Queue.ts";

export interface SendMessageRequest extends Omit<
  sqs.SendMessageRequest,
  "QueueUrl"
> {}

export const SendMessage = Effect.fn(function* <Q extends Queue>(queue: Q) {
  yield* bindSendMessage(queue);
  const QueueUrl = yield* queue.queueUrl();
  return yield* AWS.withContext(
    Effect.fn(function* (request: SendMessageRequest) {
      return yield* sqs.sendMessage({
        ...request,
        QueueUrl: yield* QueueUrl,
        MessageBody: request.MessageBody,
      });
    }),
  );
});

export const bindSendMessage = Binding.fn<SendMessageBinding>(
  "AWS.SQS.SendMessage",
);

export class SendMessageBinding extends Binding.Service(
  "AWS.SQS.SendMessage",
  Effect.fn(function* <Q extends Queue>(queue: Q) {
    const runtime = yield* Runtime;
    if (Lambda.isFunction(runtime)) {
      yield* runtime.bind({
        policyStatements: [
          {
            Sid: "SendMessage",
            Effect: "Allow",
            Action: ["sqs:SendMessage"],
            Resource: [Output.interpolate`${queue.queueArn()}`],
          },
        ],
      });
    }
    return yield* Effect.die(
      `SendMessageBinding does not support runtime '${runtime.type}'`,
    );
  }),
) {}
