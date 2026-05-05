import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { Rule } from "@/AWS/EventBridge";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import { describe, expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const randomSuffix = () => Math.random().toString(36).slice(2, 8);

describe("AWS.EventBridge.Rule", () => {
  test.provider(
    "create and delete a scheduled rule with default props",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rule = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Rule("DefaultRule", {
              scheduleExpression: "rate(1 hour)",
            });
          }),
        );

        expect(rule.ruleName).toBeDefined();
        expect(rule.ruleArn).toMatch(/^arn:aws:events:/);
        expect(rule.eventBusName).toEqual("default");

        const described = yield* eventbridge.describeRule({
          Name: rule.ruleName,
        });
        expect(described.ScheduleExpression).toEqual("rate(1 hour)");
        expect(described.State).toEqual("ENABLED");

        yield* stack.destroy();
        yield* assertRuleDeleted(rule.ruleName);
      }),
  );

  test.provider(
    "redeploy with same props is a no-op (reconcile is idempotent)",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Rule("IdempotentRule", {
              scheduleExpression: "rate(10 minutes)",
              description: "first deploy",
            });
          }),
        );

        // Deploy again with identical props — must converge without
        // changing the underlying rule.
        const second = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Rule("IdempotentRule", {
              scheduleExpression: "rate(10 minutes)",
              description: "first deploy",
            });
          }),
        );

        expect(second.ruleName).toEqual(initial.ruleName);
        expect(second.ruleArn).toEqual(initial.ruleArn);

        const described = yield* eventbridge.describeRule({
          Name: second.ruleName,
        });
        expect(described.ScheduleExpression).toEqual("rate(10 minutes)");
        expect(described.Description).toEqual("first deploy");

        yield* stack.destroy();
        yield* assertRuleDeleted(initial.ruleName);
      }),
  );

  test.provider(
    "reconcile resets ScheduleExpression / State / Description mutated out-of-band",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rule = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Rule("DriftRule", {
              scheduleExpression: "rate(15 minutes)",
              description: "managed by alchemy",
              state: "ENABLED",
            });
          }),
        );

        // Mutate every mutable field via the raw SDK.
        yield* eventbridge.putRule({
          Name: rule.ruleName,
          ScheduleExpression: "rate(2 hours)",
          Description: "drifted manually",
          State: "DISABLED",
        });
        yield* waitForRuleMatch(rule.ruleName, {
          ScheduleExpression: "rate(2 hours)",
          Description: "drifted manually",
          State: "DISABLED",
        });

        // Re-deploy with the original desired props — reconcile should
        // converge each drifted field back to the desired value.
        const redeployed = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Rule("DriftRule", {
              scheduleExpression: "rate(15 minutes)",
              description: "managed by alchemy",
              state: "ENABLED",
            });
          }),
        );
        expect(redeployed.ruleName).toEqual(rule.ruleName);

        yield* waitForRuleMatch(rule.ruleName, {
          ScheduleExpression: "rate(15 minutes)",
          Description: "managed by alchemy",
          State: "ENABLED",
        });

        yield* stack.destroy();
        yield* assertRuleDeleted(rule.ruleName);
      }),
  );

  test.provider(
    "reconcile resets EventPattern mutated out-of-band",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const desiredPattern = {
          source: ["alchemy.test"],
          "detail-type": ["alchemy.original"],
        };
        const rule = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Rule("PatternDriftRule", {
              eventPattern: desiredPattern,
            });
          }),
        );

        // Drift the pattern via the SDK.
        yield* eventbridge.putRule({
          Name: rule.ruleName,
          EventPattern: JSON.stringify({
            source: ["alchemy.test"],
            "detail-type": ["alchemy.drifted"],
          }),
        });

        // Re-deploy must reset the pattern to the alchemy-managed value.
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Rule("PatternDriftRule", {
              eventPattern: desiredPattern,
            });
          }),
        );

        yield* waitForEventPatternMatch(rule.ruleName, desiredPattern);

        yield* stack.destroy();
        yield* assertRuleDeleted(rule.ruleName);
      }),
  );

  test.provider(
    "reconcile re-creates a rule that was deleted out-of-band",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const ruleName = `alchemy-test-rule-recreate-${randomSuffix()}`;
        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Rule("RecreateRule", {
              name: ruleName,
              scheduleExpression: "rate(30 minutes)",
            });
          }),
        );
        expect(initial.ruleName).toEqual(ruleName);

        // Delete the rule out-of-band. EventBridge requires removing
        // targets first; this rule has none.
        yield* eventbridge.deleteRule({ Name: ruleName });
        yield* assertRuleDeleted(ruleName);

        // Re-deploy must converge by re-creating the rule.
        const recreated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Rule("RecreateRule", {
              name: ruleName,
              scheduleExpression: "rate(30 minutes)",
            });
          }),
        );
        expect(recreated.ruleName).toEqual(ruleName);
        const described = yield* eventbridge.describeRule({ Name: ruleName });
        expect(described.ScheduleExpression).toEqual("rate(30 minutes)");

        yield* stack.destroy();
        yield* assertRuleDeleted(ruleName);
      }),
  );

  test.provider(
    "changing rule name triggers replace, old rule is deleted",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const suffix = randomSuffix();
        const nameA = `alchemy-test-rule-replace-a-${suffix}`;
        const nameB = `alchemy-test-rule-replace-b-${suffix}`;

        const a = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Rule("RenameRule", {
              name: nameA,
              scheduleExpression: "rate(1 hour)",
            });
          }),
        );
        expect(a.ruleName).toEqual(nameA);

        const b = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Rule("RenameRule", {
              name: nameB,
              scheduleExpression: "rate(1 hour)",
            });
          }),
        );
        expect(b.ruleName).toEqual(nameB);
        expect(b.ruleArn).not.toEqual(a.ruleArn);

        // Old rule must be gone after the replace.
        yield* assertRuleDeleted(nameA);

        yield* stack.destroy();
        yield* assertRuleDeleted(nameB);
      }),
  );

  test.provider(
    "targets diff: add, remove, and update converge",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const suffix = randomSuffix();
        const queueA = `https://sqs.us-east-1.amazonaws.com/000000000000/dummy-a-${suffix}`;
        // We only need ARN-shaped strings; EventBridge accepts the ARN
        // even if the target doesn't exist yet (validation happens on
        // event delivery, not on PutTargets).
        const arnA = `arn:aws:sqs:us-east-1:000000000000:dummy-a-${suffix}`;
        const arnB = `arn:aws:sqs:us-east-1:000000000000:dummy-b-${suffix}`;
        const arnC = `arn:aws:sqs:us-east-1:000000000000:dummy-c-${suffix}`;
        // queueA is unused below; the underscore-prefix keeps tsc happy.
        void queueA;

        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Rule("TargetsRule", {
              eventPattern: { source: ["alchemy.test.targets"] },
              targets: [
                { Id: "TargetA", Arn: arnA },
                { Id: "TargetB", Arn: arnB },
              ],
            });
          }),
        );
        const observedInitial = yield* eventbridge.listTargetsByRule({
          Rule: initial.ruleName,
        });
        expect(
          (observedInitial.Targets ?? []).map((t) => t.Id).sort(),
        ).toEqual(["TargetA", "TargetB"]);

        // Update: drop TargetB, change TargetA's input, add TargetC.
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Rule("TargetsRule", {
              eventPattern: { source: ["alchemy.test.targets"] },
              targets: [
                { Id: "TargetA", Arn: arnA, Input: '{"updated":true}' },
                { Id: "TargetC", Arn: arnC },
              ],
            });
          }),
        );
        expect(updated.ruleName).toEqual(initial.ruleName);

        const observedUpdated = yield* eventbridge.listTargetsByRule({
          Rule: updated.ruleName,
        });
        const updatedById = new Map(
          (observedUpdated.Targets ?? []).map((t) => [t.Id, t]),
        );
        expect([...updatedById.keys()].sort()).toEqual([
          "TargetA",
          "TargetC",
        ]);
        expect(updatedById.get("TargetA")?.Input).toEqual('{"updated":true}');

        yield* stack.destroy();
        yield* assertRuleDeleted(initial.ruleName);
      }),
  );

  test.provider(
    "destroying an already-deleted rule is a no-op",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rule = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Rule("DoubleDestroyRule", {
              scheduleExpression: "rate(1 hour)",
            });
          }),
        );

        // Delete the rule out of band, then ask the engine to destroy it.
        // Provider's `delete` must catch ResourceNotFoundException and
        // complete cleanly.
        yield* eventbridge.deleteRule({ Name: rule.ruleName });
        yield* assertRuleDeleted(rule.ruleName);

        yield* stack.destroy();
      }),
  );

  test.provider(
    "owned rule (matching alchemy tags) is silently adopted without --adopt",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const ruleName = `alchemy-test-rule-adopt-${randomSuffix()}`;
        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Rule("AdoptableRule", {
              name: ruleName,
              scheduleExpression: "rate(1 hour)",
            });
          }),
        );
        expect(initial.ruleName).toEqual(ruleName);

        // Wipe state — rule remains in EventBridge.
        yield* Effect.gen(function* () {
          const state = yield* State;
          yield* state.delete({
            stack: stack.name,
            stage: "test",
            fqn: "AdoptableRule",
          });
        }).pipe(Effect.provide(stack.state));

        const adopted = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Rule("AdoptableRule", {
              name: ruleName,
              scheduleExpression: "rate(1 hour)",
            });
          }),
        );
        expect(adopted.ruleArn).toEqual(initial.ruleArn);

        yield* stack.destroy();
        yield* assertRuleDeleted(initial.ruleName);
      }),
  );

  test.provider(
    "foreign-tagged rule requires adopt(true) to take over and gets re-tagged",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const ruleName = `alchemy-test-rule-takeover-${randomSuffix()}`;
        const original = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Rule("Original", {
              name: ruleName,
              scheduleExpression: "rate(1 hour)",
            });
          }),
        );

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
            Effect.gen(function* () {
              return yield* Rule("Different", {
                name: ruleName,
                scheduleExpression: "rate(1 hour)",
              });
            }),
          )
          .pipe(adopt(true));

        expect(takenOver.ruleArn).toEqual(original.ruleArn);

        // Adopting with `adopt(true)` must re-tag the rule with the
        // internal alchemy tags so subsequent runs route through silent
        // adoption.
        const tagsResp = yield* eventbridge.listTagsForResource({
          ResourceARN: takenOver.ruleArn,
        });
        const tagMap = Object.fromEntries(
          (tagsResp.Tags ?? [])
            .filter(
              (t): t is { Key: string; Value: string } =>
                typeof t.Value === "string",
            )
            .map((t) => [t.Key, t.Value]),
        );
        expect(tagMap["alchemy::id"]).toEqual("Different");
        expect(tagMap["alchemy::stage"]).toBeDefined();

        yield* stack.destroy();
        yield* assertRuleDeleted(takenOver.ruleName);
      }),
  );

  class RuleStillExists extends Data.TaggedError("RuleStillExists") {}
  class RuleNotConverged extends Data.TaggedError("RuleNotConverged") {}
  class EventPatternNotConverged extends Data.TaggedError(
    "EventPatternNotConverged",
  ) {}

  /** Poll until describeRule reflects the desired props (EventBridge is eventually consistent). */
  const waitForRuleMatch = Effect.fn(function* (
    ruleName: string,
    expected: {
      ScheduleExpression?: string;
      Description?: string;
      State?: "ENABLED" | "DISABLED";
    },
  ) {
    yield* Effect.gen(function* () {
      const described = yield* eventbridge.describeRule({ Name: ruleName });
      for (const [key, value] of Object.entries(expected)) {
        if ((described as any)[key] !== value) {
          return yield* Effect.fail(new RuleNotConverged());
        }
      }
    }).pipe(
      Effect.retry({
        while: (e) => e._tag === "RuleNotConverged",
        schedule: Schedule.fixed("500 millis").pipe(
          Schedule.both(Schedule.recurs(40)),
        ),
      }),
    );
  });

  const waitForEventPatternMatch = Effect.fn(function* (
    ruleName: string,
    expected: Record<string, unknown>,
  ) {
    const expectedJson = JSON.stringify(expected);
    yield* Effect.gen(function* () {
      const described = yield* eventbridge.describeRule({ Name: ruleName });
      const parsed = described.EventPattern
        ? JSON.parse(described.EventPattern)
        : undefined;
      if (JSON.stringify(parsed) !== expectedJson) {
        return yield* Effect.fail(new EventPatternNotConverged());
      }
    }).pipe(
      Effect.retry({
        while: (e) => e._tag === "EventPatternNotConverged",
        schedule: Schedule.fixed("500 millis").pipe(
          Schedule.both(Schedule.recurs(40)),
        ),
      }),
    );
  });

  const assertRuleDeleted = Effect.fn(function* (ruleName: string) {
    yield* eventbridge
      .describeRule({ Name: ruleName })
      .pipe(
        Effect.flatMap(() => Effect.fail(new RuleStillExists())),
        Effect.retry({
          while: (e) => e._tag === "RuleStillExists",
          schedule: Schedule.exponential(100).pipe(
            Schedule.both(Schedule.recurs(8)),
          ),
        }),
        Effect.catchTag("ResourceNotFoundException", () => Effect.void),
      );
  });
});
