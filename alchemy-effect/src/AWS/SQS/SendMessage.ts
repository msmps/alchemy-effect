import * as sqs from "distilled-aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Queue } from "./Queue.ts";

export interface SendMessageRequest<Q extends Queue>
  extends Omit<sqs.SendMessageRequest, "QueueUrl" | "MessageBody"> {
  MessageBody: Q["props"]["schema"]["Type"];
}

export const SendMessage = Binding.make(
  "AWS.SQS.SendMessage",
  <Q extends Queue>(queue: Q) =>
    Binding.fn(queue, function* (request: SendMessageRequest<Q>) {
      return yield* sqs.sendMessage({
        ...request,
        QueueUrl: yield* queue.queueUrl(),
        MessageBody: JSON.stringify(request.MessageBody),
      });
    }),
);

export const SendMessageLambda = Binding.effect(
  [Lambda.Function, SendMessage],
  (func, queue) =>
    Effect.succeed({
      policyStatements: [
        {
          Sid: "SendMessage",
          Effect: "Allow",
          Action: ["sqs:SendMessage"],
          Resource: [Output.interpolate`${queue.queueArn()}`],
        },
      ],
    }),
);
