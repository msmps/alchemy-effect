import * as Lambda from "distilled-aws/lambda";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import type { Function } from "./Function.ts";
import * as LambdaModule from "./index.ts";

export interface InvokeRequest extends Omit<
  Lambda.InvocationRequest,
  "FunctionName"
> {}

export const InvokeFunction = Binding.make(
  "AWS.Lambda.InvokeFunction",
  <F extends Function>(func: F) =>
    Binding.fn(func, function* (request?: InvokeRequest) {
      return yield* Lambda.invoke({
        ...request,
        FunctionName: yield* func.functionArn(),
      });
    }),
);

export const InvokeFunctionLambda = Binding.effect(
  [LambdaModule.Function, InvokeFunction],
  (caller, target) =>
    Effect.succeed({
      policyStatements: [
        {
          Sid: "InvokeFunction",
          Effect: "Allow",
          Action: ["lambda:InvokeFunction"],
          Resource: [Output.interpolate`${target.functionArn()}`],
        },
      ],
    }),
);
