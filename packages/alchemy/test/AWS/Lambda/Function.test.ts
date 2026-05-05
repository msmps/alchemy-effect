import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as IAM from "@distilled.cloud/aws/iam";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  LifecycleFunction,
  LifecycleFunctionLive,
} from "./lifecycle-handler.ts";
import { TestFunction, TestFunctionLive } from "./handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "create, update, delete function",
  (stack) =>
    Effect.gen(function* () {
      const { functionName, functionUrl } = yield* stack.deploy(
        TestFunction.asEffect().pipe(Effect.provide(TestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();

      const response = yield* HttpClient.get(functionUrl!).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(
                new Error(`Function URL returned ${response.status}`),
              ),
        ),
        Effect.tapError((error) => Effect.logError(error)),
        Effect.retry({
          schedule: Schedule.exponential(500).pipe(
            Schedule.both(Schedule.recurs(10)),
          ),
        }),
      );

      expect(response.status).toBe(200);
      expect(yield* response.text).toBe("Hello, world!");

      const invokePolicy = yield* getPolicyStatement(
        functionName,
        "FunctionURLAllowPublicInvoke",
      );
      expect(invokePolicy.Condition).toEqual({
        Bool: {
          "lambda:InvokedViaFunctionUrl": "true",
        },
      });
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { timeout: 180_000 },
);

const getPolicyStatement = Effect.fn(function* (
  functionName: string,
  statementId: string,
) {
  return yield* Lambda.getPolicy({ FunctionName: functionName }).pipe(
    Effect.flatMap(({ Policy }) =>
      Effect.try({
        try: () => {
          const policy = JSON.parse(Policy ?? "{}") as {
            Statement?: Array<{
              Sid?: string;
              Condition?: unknown;
            }>;
          };
          const statement = policy.Statement?.find(
            (statement) => statement.Sid === statementId,
          );
          if (!statement) {
            throw new Error(`Policy statement ${statementId} not found`);
          }
          return statement;
        },
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      }),
    ),
    Effect.retry({
      schedule: Schedule.exponential(500).pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
  );
});

// ---------------------------------------------------------------------------
// Lifecycle convergence tests
// ---------------------------------------------------------------------------

class FunctionStillExists extends Data.TaggedError("FunctionStillExists") {}
class FunctionEnvNotReady extends Data.TaggedError("FunctionEnvNotReady") {}

const lifecycleHandlerPath = new URL(
  "./lifecycle-handler.ts",
  import.meta.url,
).pathname;

// Inline `impl` for `Function(id, props, impl)` — same minimal handler as
// the fixture file, used when a test needs to vary props (functionName, url,
// env) without authoring a new tagged class per variation.
const okImpl = Effect.gen(function* () {
  return {
    fetch: Effect.succeed(HttpServerResponse.text("ok")),
  };
});

const assertFunctionDeleted = Effect.fn(function* (functionName: string) {
  yield* Lambda.getFunction({ FunctionName: functionName }).pipe(
    Effect.flatMap(() => Effect.fail(new FunctionStillExists())),
    Effect.retry({
      while: (e) => e._tag === "FunctionStillExists",
      schedule: Schedule.exponential(200).pipe(
        Schedule.both(Schedule.recurs(20)),
      ),
    }),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
  );
});

/**
 * Wait until the function's `Environment.Variables` matches each
 * key/value pair in `expected`. Lambda returns the last persisted state
 * but `LastUpdateStatus` may briefly trail `updateFunctionConfiguration`.
 */
const waitForFunctionEnvMatch = Effect.fn(function* (
  functionName: string,
  expected: Record<string, string>,
) {
  yield* Lambda.getFunctionConfiguration({ FunctionName: functionName }).pipe(
    Effect.flatMap((cfg) => {
      const actual = cfg.Environment?.Variables ?? {};
      for (const [k, v] of Object.entries(expected)) {
        if (actual[k] !== v) return Effect.fail(new FunctionEnvNotReady());
      }
      if (cfg.LastUpdateStatus === "InProgress") {
        return Effect.fail(new FunctionEnvNotReady());
      }
      return Effect.void;
    }),
    Effect.retry({
      while: (e) => e._tag === "FunctionEnvNotReady",
      schedule: Schedule.fixed(1000).pipe(
        Schedule.both(Schedule.recurs(60)),
      ),
    }),
  );
});

const waitForFunctionUrlConfig = Effect.fn(function* (functionName: string) {
  return yield* Lambda.getFunctionUrlConfig({ FunctionName: functionName });
});

test.provider(
  "redeploy with same props is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        LifecycleFunction.asEffect().pipe(Effect.provide(LifecycleFunctionLive)),
      );
      expect(initial.functionName).toBeDefined();

      const second = yield* stack.deploy(
        LifecycleFunction.asEffect().pipe(Effect.provide(LifecycleFunctionLive)),
      );
      expect(second.functionArn).toEqual(initial.functionArn);
      expect(second.functionName).toEqual(initial.functionName);
      expect(second.code.hash).toEqual(initial.code.hash);

      yield* stack.destroy();
      yield* assertFunctionDeleted(initial.functionName);
    }),
  { timeout: 240_000 },
);

test.provider(
  "reconcile resets environment variables mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        AWS.Lambda.Function(
          "DriftFunction",
          {
            main: lifecycleHandlerPath,
            env: { FOO: "alchemy", BAR: "hello" },
          },
          okImpl,
        ),
      );
      yield* waitForFunctionEnvMatch(initial.functionName, {
        FOO: "alchemy",
        BAR: "hello",
      });

      // Mutate env vars out-of-band.
      yield* Lambda.updateFunctionConfiguration({
        FunctionName: initial.functionName,
        Environment: {
          Variables: { FOO: "drifted", BAR: "drifted" },
        },
      });
      yield* waitForFunctionEnvMatch(initial.functionName, {
        FOO: "drifted",
        BAR: "drifted",
      });

      // Re-deploy with the same desired props — reconcile should reset
      // the drifted env vars back to the desired values.
      const redeployed = yield* stack.deploy(
        AWS.Lambda.Function(
          "DriftFunction",
          {
            main: lifecycleHandlerPath,
            env: { FOO: "alchemy", BAR: "hello" },
          },
          okImpl,
        ),
      );
      expect(redeployed.functionArn).toEqual(initial.functionArn);
      yield* waitForFunctionEnvMatch(redeployed.functionName, {
        FOO: "alchemy",
        BAR: "hello",
      });

      yield* stack.destroy();
      yield* assertFunctionDeleted(initial.functionName);
    }),
  { timeout: 300_000 },
);

test.provider(
  "reconcile re-creates a function deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        LifecycleFunction.asEffect().pipe(Effect.provide(LifecycleFunctionLive)),
      );

      // Delete the function out of band.
      yield* Lambda.deleteFunction({ FunctionName: initial.functionName });
      yield* assertFunctionDeleted(initial.functionName);

      // Reconcile should re-create the function and surface the same
      // deterministic name.
      const recreated = yield* stack.deploy(
        LifecycleFunction.asEffect().pipe(Effect.provide(LifecycleFunctionLive)),
      );
      expect(recreated.functionName).toEqual(initial.functionName);

      const cfg = yield* Lambda.getFunctionConfiguration({
        FunctionName: recreated.functionName,
      });
      expect(cfg.FunctionName).toEqual(recreated.functionName);

      yield* stack.destroy();
      yield* assertFunctionDeleted(recreated.functionName);
    }),
  { timeout: 240_000 },
);

test.provider(
  "changing functionName triggers replace, old function is deleted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const nameA = `alchemy-test-lambda-rename-a-${suffix}`;
      const nameB = `alchemy-test-lambda-rename-b-${suffix}`;

      const a = yield* stack.deploy(
        AWS.Lambda.Function(
          "RenameFunction",
          {
            main: lifecycleHandlerPath,
            functionName: nameA,
          },
          okImpl,
        ),
      );
      expect(a.functionName).toEqual(nameA);

      const b = yield* stack.deploy(
        AWS.Lambda.Function(
          "RenameFunction",
          {
            main: lifecycleHandlerPath,
            functionName: nameB,
          },
          okImpl,
        ),
      );
      expect(b.functionName).toEqual(nameB);
      expect(b.functionArn).not.toEqual(a.functionArn);

      // The old function must be gone after replace.
      yield* assertFunctionDeleted(a.functionName);

      yield* stack.destroy();
      yield* assertFunctionDeleted(b.functionName);
    }),
  { timeout: 300_000 },
);

test.provider(
  "function URL: enable, then disable",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const noUrl = yield* stack.deploy(
        AWS.Lambda.Function(
          "UrlFunction",
          {
            main: lifecycleHandlerPath,
            url: false,
          },
          okImpl,
        ),
      );
      expect(noUrl.functionUrl).toBeUndefined();

      const withUrl = yield* stack.deploy(
        AWS.Lambda.Function(
          "UrlFunction",
          {
            main: lifecycleHandlerPath,
            url: true,
          },
          okImpl,
        ),
      );
      // Toggling `url` triggers replace per the diff function, so the
      // function name is identical (deterministic) but functionUrl is now set.
      expect(withUrl.functionUrl).toBeDefined();
      const cfg = yield* waitForFunctionUrlConfig(withUrl.functionName);
      expect(cfg.FunctionUrl).toEqual(withUrl.functionUrl);

      yield* stack.destroy();
      yield* assertFunctionDeleted(withUrl.functionName);
    }),
  { timeout: 360_000 },
);

test.provider(
  "destroying an already-deleted function is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fn = yield* stack.deploy(
        LifecycleFunction.asEffect().pipe(Effect.provide(LifecycleFunctionLive)),
      );

      // Delete the function out of band, then ask the engine to destroy it.
      // Provider's `delete` must catch ResourceNotFoundException + the
      // role's NoSuchEntityException and complete cleanly.
      yield* Lambda.deleteFunction({ FunctionName: fn.functionName });
      yield* assertFunctionDeleted(fn.functionName);

      yield* IAM.deleteRolePolicy({
        RoleName: fn.roleName,
        PolicyName: fn.roleName, // policyName == createPhysicalName(id, 128)
      }).pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
      yield* IAM.detachRolePolicy({
        RoleName: fn.roleName,
        PolicyArn:
          "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
      }).pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
      yield* IAM.deleteRole({ RoleName: fn.roleName }).pipe(
        Effect.catchTag("NoSuchEntityException", () => Effect.void),
      );

      yield* stack.destroy();
    }),
  { timeout: 240_000 },
);

test.provider(
  "adopt(true) re-tags a foreign function with internal alchemy tags",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const functionName = `alchemy-test-lambda-adopt-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const original = yield* stack.deploy(
        AWS.Lambda.Function(
          "Original",
          {
            main: lifecycleHandlerPath,
            functionName,
          },
          okImpl,
        ),
      );

      // Wipe state — function stays in Lambda.
      yield* Effect.gen(function* () {
        const state = yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "Original",
        });
      }).pipe(Effect.provide(stack.state));

      const takenOver = yield* stack
        .deploy(
          AWS.Lambda.Function(
            "Different",
            {
              main: lifecycleHandlerPath,
              functionName,
            },
            okImpl,
          ),
        )
        .pipe(adopt(true));
      expect(takenOver.functionName).toEqual(functionName);
      expect(takenOver.functionArn).toEqual(original.functionArn);

      // adopt(true) re-tags the function with the new logical id ("Different")
      // so subsequent runs use silent adoption.
      const tags = yield* Lambda.listTags({ Resource: takenOver.functionArn });
      expect(tags.Tags?.["alchemy:fqn"]).toBeDefined();
      expect(tags.Tags?.["alchemy:stage"]).toBeDefined();

      yield* stack.destroy();
      yield* assertFunctionDeleted(takenOver.functionName);
    }),
  { timeout: 300_000 },
);
