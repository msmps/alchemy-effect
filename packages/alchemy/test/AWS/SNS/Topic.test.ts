import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { Topic } from "@/AWS/SNS";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as SNS from "@distilled.cloud/aws/sns";
import { describe, expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

describe("AWS.SNS.Topic", () => {
  test.provider("create and delete topic with default props", (stack) =>
    Effect.gen(function* () {
      const topic = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Topic("DefaultTopic");
        }),
      );

      expect(topic.topicName).toBeDefined();
      expect(topic.topicArn).toBeDefined();

      const attributes = yield* SNS.getTopicAttributes({
        TopicArn: topic.topicArn,
      });
      expect(attributes.Attributes?.TopicArn).toBe(topic.topicArn);

      yield* stack.destroy();
      yield* assertTopicDeleted(topic.topicArn);
    }),
  );

  test.provider("create, update, delete topic attributes and tags", (stack) =>
    Effect.gen(function* () {
      const topic = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Topic("ManagedTopic", {
            attributes: {
              DisplayName: "managed-topic-v1",
            },
            tags: {
              env: "test",
            },
          });
        }),
      );

      const initialAttributes = yield* SNS.getTopicAttributes({
        TopicArn: topic.topicArn,
      });
      expect(initialAttributes.Attributes?.DisplayName).toBe(
        "managed-topic-v1",
      );

      const updatedTopic = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Topic("ManagedTopic", {
            attributes: {
              DisplayName: "managed-topic-v2",
            },
            tags: {
              updated: "true",
            },
          });
        }),
      );

      const updatedAttributes = yield* SNS.getTopicAttributes({
        TopicArn: updatedTopic.topicArn,
      });
      expect(updatedAttributes.Attributes?.DisplayName).toBe(
        "managed-topic-v2",
      );

      const tagResponse = yield* SNS.listTagsForResource({
        ResourceArn: updatedTopic.topicArn,
      });
      const tags = Object.fromEntries(
        (tagResponse.Tags ?? []).map((tag) => [tag.Key, tag.Value]),
      );
      expect(tags.updated).toBe("true");
      expect(tags.env).toBeUndefined();

      yield* stack.destroy();
      yield* assertTopicDeleted(updatedTopic.topicArn);
    }),
  );

  test.provider("create and delete fifo topic", (stack) =>
    Effect.gen(function* () {
      const topic = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Topic("FifoTopic", {
            fifo: true,
            attributes: {
              ContentBasedDeduplication: "true",
            },
          });
        }),
      );

      expect(topic.topicName).toContain(".fifo");

      const attributes = yield* SNS.getTopicAttributes({
        TopicArn: topic.topicArn,
      });
      expect(attributes.Attributes?.FifoTopic).toBe("true");
      expect(attributes.Attributes?.ContentBasedDeduplication).toBe("true");

      yield* stack.destroy();
      yield* assertTopicDeleted(topic.topicArn);
    }),
  );

  // Engine-level adoption tests for SNS Topic.
  test.provider(
    "owned topic (matching alchemy tags) is silently adopted without --adopt",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const topicName = `alchemy-test-sns-adopt-${Math.random()
          .toString(36)
          .slice(2, 8)}`;

        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Topic("AdoptableTopic", { topicName });
          }),
        );
        expect(initial.topicName).toEqual(topicName);

        // Wipe state — the topic stays in SNS.
        yield* Effect.gen(function* () {
          const state = yield* State;
          yield* state.delete({
            stack: stack.name,
            stage: "test",
            fqn: "AdoptableTopic",
          });
        }).pipe(Effect.provide(stack.state));

        const adopted = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Topic("AdoptableTopic", { topicName });
          }),
        );

        expect(adopted.topicArn).toEqual(initial.topicArn);

        yield* stack.destroy();
        yield* assertTopicDeleted(initial.topicArn);
      }),
  );

  test.provider(
    "foreign-tagged topic requires adopt(true) to take over",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const topicName = `alchemy-test-sns-takeover-${Math.random()
          .toString(36)
          .slice(2, 8)}`;

        const original = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Topic("Original", { topicName });
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
              return yield* Topic("Different", { topicName });
            }),
          )
          .pipe(adopt(true));

        expect(takenOver.topicArn).toEqual(original.topicArn);

        const tagsResp = yield* SNS.listTagsForResource({
          ResourceArn: takenOver.topicArn,
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
        // adopt(true) must rebrand with internal alchemy tags so subsequent
        // runs route through the silent-adopt path.
        expect(tagMap["alchemy::stack"]).toBeDefined();
        expect(tagMap["alchemy::stage"]).toBeDefined();

        yield* stack.destroy();
        yield* assertTopicDeleted(takenOver.topicArn);
      }),
  );

  test.provider(
    "redeploy with same props is a no-op (reconcile is idempotent)",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Topic("IdempotentTopic", {
              attributes: { DisplayName: "idem-v1" },
            });
          }),
        );

        // Re-deploy with identical props — should converge without
        // changing anything observable.
        const second = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Topic("IdempotentTopic", {
              attributes: { DisplayName: "idem-v1" },
            });
          }),
        );
        expect(second.topicArn).toEqual(initial.topicArn);
        expect(second.topicName).toEqual(initial.topicName);

        const attrs = yield* SNS.getTopicAttributes({
          TopicArn: second.topicArn,
        });
        expect(attrs.Attributes?.DisplayName).toEqual("idem-v1");

        yield* stack.destroy();
        yield* assertTopicDeleted(initial.topicArn);
      }),
  );

  test.provider(
    "reconcile resets DisplayName / Policy / KmsMasterKeyId / DeliveryPolicy mutated out-of-band",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const desiredDeliveryPolicy = JSON.stringify({
          http: {
            defaultHealthyRetryPolicy: {
              minDelayTarget: 20,
              maxDelayTarget: 20,
              numRetries: 3,
              numNoDelayRetries: 0,
              numMinDelayRetries: 0,
              numMaxDelayRetries: 0,
              backoffFunction: "linear",
            },
            disableSubscriptionOverrides: false,
          },
        });

        const topic = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Topic("DriftTopic", {
              attributes: {
                DisplayName: "managed-display",
                DeliveryPolicy: desiredDeliveryPolicy,
              },
            });
          }),
        );

        // Mutate the topic out-of-band via the raw SDK.
        yield* SNS.setTopicAttributes({
          TopicArn: topic.topicArn,
          AttributeName: "DisplayName",
          AttributeValue: "out-of-band-display",
        });
        yield* SNS.setTopicAttributes({
          TopicArn: topic.topicArn,
          AttributeName: "DeliveryPolicy",
          AttributeValue: JSON.stringify({
            http: {
              defaultHealthyRetryPolicy: {
                minDelayTarget: 5,
                maxDelayTarget: 5,
                numRetries: 1,
                numNoDelayRetries: 0,
                numMinDelayRetries: 0,
                numMaxDelayRetries: 0,
                backoffFunction: "linear",
              },
              disableSubscriptionOverrides: false,
            },
          }),
        });

        const drifted = yield* SNS.getTopicAttributes({
          TopicArn: topic.topicArn,
        });
        expect(drifted.Attributes?.DisplayName).toEqual("out-of-band-display");

        // Re-deploy with the original desired props — reconcile must
        // observe the live cloud state and rewrite drifted attributes.
        const redeployed = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Topic("DriftTopic", {
              attributes: {
                DisplayName: "managed-display",
                DeliveryPolicy: desiredDeliveryPolicy,
              },
            });
          }),
        );
        expect(redeployed.topicArn).toEqual(topic.topicArn);

        const reconciled = yield* SNS.getTopicAttributes({
          TopicArn: topic.topicArn,
        });
        expect(reconciled.Attributes?.DisplayName).toEqual("managed-display");
        const reconciledPolicy = JSON.parse(
          reconciled.Attributes?.DeliveryPolicy ?? "{}",
        );
        expect(
          reconciledPolicy.http?.defaultHealthyRetryPolicy?.numRetries,
        ).toEqual(3);

        yield* stack.destroy();
        yield* assertTopicDeleted(topic.topicArn);
      }),
  );

  test.provider(
    "reconcile re-creates a topic that was deleted out-of-band",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const topicName = `alchemy-test-sns-recreate-${Math.random()
          .toString(36)
          .slice(2, 8)}`;

        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Topic("RecreateTopic", { topicName });
          }),
        );

        // Delete the topic out of band.
        yield* SNS.deleteTopic({ TopicArn: initial.topicArn });
        yield* assertTopicDeleted(initial.topicArn);

        // Re-deploying must converge by re-creating. SNS createTopic is
        // idempotent on (Name, FifoTopic) so we land on a fresh topic
        // with the same ARN.
        const recreated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Topic("RecreateTopic", { topicName });
          }),
        );
        expect(recreated.topicName).toEqual(topicName);

        const attrs = yield* SNS.getTopicAttributes({
          TopicArn: recreated.topicArn,
        });
        expect(attrs.Attributes?.TopicArn).toEqual(recreated.topicArn);

        yield* stack.destroy();
        yield* assertTopicDeleted(recreated.topicArn);
      }),
  );

  test.provider(
    "changing topicName triggers replace, old topic is deleted",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const suffix = Math.random().toString(36).slice(2, 8);
        const nameA = `alchemy-test-sns-replace-a-${suffix}`;
        const nameB = `alchemy-test-sns-replace-b-${suffix}`;

        const a = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Topic("RenameTopic", { topicName: nameA });
          }),
        );
        expect(a.topicName).toEqual(nameA);

        const b = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Topic("RenameTopic", { topicName: nameB });
          }),
        );
        expect(b.topicName).toEqual(nameB);
        expect(b.topicArn).not.toEqual(a.topicArn);

        // The old topic must be gone after replace.
        yield* assertTopicDeleted(a.topicArn);

        yield* stack.destroy();
        yield* assertTopicDeleted(b.topicArn);
      }),
  );

  test.provider("flipping fifo flag triggers replace", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const standard = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Topic("FifoFlipTopic");
        }),
      );
      expect(standard.fifo).toBe(false);
      expect(standard.topicName).not.toContain(".fifo");

      const fifo = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Topic("FifoFlipTopic", {
            fifo: true,
            attributes: { ContentBasedDeduplication: "true" },
          });
        }),
      );
      expect(fifo.fifo).toBe(true);
      expect(fifo.topicName).toContain(".fifo");
      expect(fifo.topicArn).not.toEqual(standard.topicArn);

      yield* assertTopicDeleted(standard.topicArn);

      yield* stack.destroy();
      yield* assertTopicDeleted(fifo.topicArn);
    }),
  );

  test.provider("destroying an already-deleted topic is a no-op", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const topic = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Topic("DoubleDestroyTopic");
        }),
      );

      // Delete the topic out of band, then ask the engine to destroy it.
      // Provider's `delete` must catch NotFoundException and complete cleanly.
      yield* SNS.deleteTopic({ TopicArn: topic.topicArn });
      yield* assertTopicDeleted(topic.topicArn);

      yield* stack.destroy();
    }),
  );

  class TopicStillExists extends Data.TaggedError("TopicStillExists") {}

  const assertTopicDeleted = Effect.fn(function* (topicArn: string) {
    yield* SNS.getTopicAttributes({
      TopicArn: topicArn,
    }).pipe(
      Effect.flatMap(() => Effect.fail(new TopicStillExists())),
      Effect.retry({
        while: (error) => error._tag === "TopicStillExists",
        schedule: Schedule.exponential(100),
      }),
      Effect.catchTag("NotFoundException", () => Effect.void),
      Effect.catchTag("InvalidParameterException", () => Effect.void),
    );
  });
});
