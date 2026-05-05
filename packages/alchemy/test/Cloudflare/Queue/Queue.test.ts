import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { Queue, QueueConsumer } from "@/Cloudflare/Queue";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as queues from "@distilled.cloud/cloudflare/queues";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("create and delete queue with default props", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const queue = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Queue("DefaultQueue");
      }),
    );

    expect(queue.queueId).toBeDefined();
    expect(queue.queueName).toBeDefined();
    expect(queue.accountId).toEqual(accountId);

    const fetched = yield* queues.getQueue({
      accountId,
      queueId: queue.queueId,
    });
    expect(fetched.queueId).toEqual(queue.queueId);
    expect(fetched.queueName).toEqual(queue.queueName);

    yield* stack.destroy();
    yield* waitForQueueToBeDeleted(queue.queueId, accountId);
  }).pipe(logLevel),
);

test.provider("create queue with explicit name", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const name = `alchemy-test-cf-queue-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    const queue = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Queue("NamedQueue", { name });
      }),
    );

    expect(queue.queueName).toEqual(name);

    yield* stack.destroy();
    yield* waitForQueueToBeDeleted(queue.queueId, accountId);
  }).pipe(logLevel),
);

// ─────────────────────────────────────────────────────────────────────
// Lifecycle convergence
//
// Reconcile must converge from any starting state — pristine, drifted,
// out-of-band-deleted, or replaced — without leaning on `olds` as a
// source of truth.
// ─────────────────────────────────────────────────────────────────────

test.provider(
  "redeploy with same props is a no-op — queueId preserved",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const v1 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Queue("IdempotentQueue");
        }),
      );

      const v2 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Queue("IdempotentQueue");
        }),
      );

      expect(v2.queueId).toEqual(v1.queueId);
      expect(v2.queueName).toEqual(v1.queueName);

      yield* stack.destroy();
      yield* waitForQueueToBeDeleted(v1.queueId, accountId);
    }).pipe(logLevel),
);

test.provider(
  "reconcile re-creates a queue that was deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const name = `alchemy-test-cf-queue-recreate-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const v1 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Queue("RecreateQueue", { name });
        }),
      );
      expect(v1.queueName).toEqual(name);

      // Delete the queue out-of-band — local state still says it
      // exists, but Cloudflare disagrees.
      yield* queues.deleteQueue({
        accountId,
        queueId: v1.queueId,
      });
      yield* waitForQueueToBeDeleted(v1.queueId, accountId);

      // Reconcile must observe the missing queue (`getQueue` returns
      // `QueueNotFound`, the catch swallows it, the name scan also
      // misses), then call `createQueue` and converge.
      const v2 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Queue("RecreateQueue", { name });
        }),
      );
      expect(v2.queueName).toEqual(name);
      expect(v2.queueId).not.toEqual(v1.queueId);

      const fetched = yield* queues.getQueue({
        accountId,
        queueId: v2.queueId,
      });
      expect(fetched.queueId).toEqual(v2.queueId);

      yield* stack.destroy();
      yield* waitForQueueToBeDeleted(v2.queueId, accountId);
    }).pipe(logLevel),
);

test.provider(
  "changing physical name triggers replace; old queue is deleted",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const nameA = `alchemy-test-cf-queue-replace-a-${suffix}`;
      const nameB = `alchemy-test-cf-queue-replace-b-${suffix}`;

      const a = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Queue("RenameQueue", { name: nameA });
        }),
      );
      expect(a.queueName).toEqual(nameA);

      const b = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Queue("RenameQueue", { name: nameB });
        }),
      );
      expect(b.queueName).toEqual(nameB);
      expect(b.queueId).not.toEqual(a.queueId);

      // The previous queue must be gone after replace.
      yield* waitForQueueToBeDeleted(a.queueId, accountId);

      // The new queue exists.
      const fetched = yield* queues.getQueue({
        accountId,
        queueId: b.queueId,
      });
      expect(fetched.queueName).toEqual(nameB);

      yield* stack.destroy();
      yield* waitForQueueToBeDeleted(b.queueId, accountId);
    }).pipe(logLevel),
);

test.provider("destroying an already-deleted queue is a no-op", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const queue = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Queue("DoubleDestroyQueue");
      }),
    );

    // Delete the queue out-of-band so the next destroy hits the
    // `QueueNotFound` path inside provider.delete. It must succeed.
    yield* queues.deleteQueue({
      accountId,
      queueId: queue.queueId,
    });
    yield* waitForQueueToBeDeleted(queue.queueId, accountId);

    yield* stack.destroy();
  }).pipe(logLevel),
);

// Engine-level adoption: Cloudflare Queues have no ownership tags, so a
// name match in `read` is treated as silent adoption. Wipe local state
// mid-run while leaving the queue on Cloudflare to simulate a fresh
// state store seeing an existing resource with the same physical name.
test.provider(
  "existing queue (matching name) is silently adopted without --adopt",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const name = `alchemy-test-cf-queue-adopt-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Queue("AdoptableQueue", { name });
        }),
      );
      expect(initial.queueName).toEqual(name);
      const initialId = initial.queueId;
      expect(initialId).toBeDefined();

      // Wipe local state — the queue stays on Cloudflare.
      yield* Effect.gen(function* () {
        const state = yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableQueue",
        });
      }).pipe(Effect.provide(stack.state));

      // Redeploy without `adopt(true)`. The engine calls `provider.read`,
      // which scans by name and returns plain attrs — silent adoption.
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Queue("AdoptableQueue", { name });
        }),
      );

      expect(adopted.queueId).toEqual(initialId);
      expect(adopted.queueName).toEqual(name);

      yield* stack.destroy();
      yield* waitForQueueToBeDeleted(initialId, accountId);
    }).pipe(logLevel),
);

test.provider(
  "adopt(true) re-claims a queue under a different logical id",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const name = `alchemy-test-cf-queue-takeover-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const original = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Queue("Original", { name });
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
            return yield* Queue("Different", { name });
          }),
        )
        .pipe(adopt(true));

      expect(takenOver.queueName).toEqual(name);
      expect(takenOver.queueId).toEqual(original.queueId);

      yield* stack.destroy();
      yield* waitForQueueToBeDeleted(original.queueId, accountId);
    }).pipe(logLevel),
);

// ─────────────────────────────────────────────────────────────────────
// QueueConsumer lifecycle
// ─────────────────────────────────────────────────────────────────────

test.provider(
  "consumer add / remove churn against a stable queue + worker",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const queueName = `alchemy-test-cf-queue-churn-${suffix}`;
      const workerName = `alchemy-test-cf-queue-churn-worker-${suffix}`;
      const main = pathe.resolve(import.meta.dirname, "../Workers/worker.ts");

      // Phase 1: deploy queue + worker, no consumer attached.
      const v1 = yield* stack.deploy(
        Effect.gen(function* () {
          const queue = yield* Queue("ChurnQueue", { name: queueName });
          yield* Cloudflare.Worker("ChurnWorker", {
            main,
            name: workerName,
            url: false,
            compatibility: { date: "2024-01-01" },
          });
          return queue;
        }),
      );

      const consumersV1 = yield* listConsumersForQueue(accountId, v1.queueId);
      expect(consumersV1).toHaveLength(0);

      // Phase 2: attach a consumer.
      yield* stack.deploy(
        Effect.gen(function* () {
          const queue = yield* Queue("ChurnQueue", { name: queueName });
          yield* Cloudflare.Worker("ChurnWorker", {
            main,
            name: workerName,
            url: false,
            compatibility: { date: "2024-01-01" },
          });
          yield* QueueConsumer("ChurnConsumer", {
            queueId: queue.queueId,
            scriptName: workerName,
          });
          return queue;
        }),
      );

      const consumersV2 = yield* listConsumersForQueue(accountId, v1.queueId);
      expect(consumersV2).toHaveLength(1);
      expect(
        consumersV2[0] && "script" in consumersV2[0] && consumersV2[0].script,
      ).toEqual(workerName);

      // Phase 3: drop the consumer. Reconcile of the stack must remove
      // it from the live queue.
      yield* stack.deploy(
        Effect.gen(function* () {
          const queue = yield* Queue("ChurnQueue", { name: queueName });
          yield* Cloudflare.Worker("ChurnWorker", {
            main,
            name: workerName,
            url: false,
            compatibility: { date: "2024-01-01" },
          });
          return queue;
        }),
      );

      const consumersV3 = yield* listConsumersForQueue(accountId, v1.queueId);
      expect(consumersV3).toHaveLength(0);

      yield* stack.destroy();
      yield* waitForQueueToBeDeleted(v1.queueId, accountId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "consumer settings update propagates without replacing the consumer",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const queueName = `alchemy-test-cf-queue-settings-${suffix}`;
      const workerName = `alchemy-test-cf-queue-settings-worker-${suffix}`;
      const main = pathe.resolve(import.meta.dirname, "../Workers/worker.ts");

      const deploy = (settings: { batchSize: number; maxRetries: number }) =>
        stack.deploy(
          Effect.gen(function* () {
            const queue = yield* Queue("SettingsQueue", { name: queueName });
            yield* Cloudflare.Worker("SettingsWorker", {
              main,
              name: workerName,
              url: false,
              compatibility: { date: "2024-01-01" },
            });
            const consumer = yield* QueueConsumer("SettingsConsumer", {
              queueId: queue.queueId,
              scriptName: workerName,
              settings,
            });
            return { queue, consumer };
          }),
        );

      const v1 = yield* deploy({ batchSize: 10, maxRetries: 3 });
      const v2 = yield* deploy({ batchSize: 25, maxRetries: 5 });

      // Settings update — consumer identity stable, no replace.
      expect(v2.consumer.consumerId).toEqual(v1.consumer.consumerId);

      const live = yield* queues.getConsumer({
        accountId,
        queueId: v2.queue.queueId,
        consumerId: v2.consumer.consumerId,
      });
      const liveSettings =
        "settings" in live && live.settings
          ? (live.settings as { batchSize?: number; maxRetries?: number })
          : {};
      expect(liveSettings.batchSize).toEqual(25);
      expect(liveSettings.maxRetries).toEqual(5);

      yield* stack.destroy();
      yield* waitForQueueToBeDeleted(v1.queue.queueId, accountId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "DLQ chaining: consumer points at a separate DLQ that survives redeploy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const mainName = `alchemy-test-cf-queue-dlq-main-${suffix}`;
      const dlqName = `alchemy-test-cf-queue-dlq-letter-${suffix}`;
      const workerName = `alchemy-test-cf-queue-dlq-worker-${suffix}`;
      const main = pathe.resolve(import.meta.dirname, "../Workers/worker.ts");

      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            const dlq = yield* Queue("DLQ", { name: dlqName });
            const mainQueue = yield* Queue("MainQueue", { name: mainName });
            yield* Cloudflare.Worker("DLQWorker", {
              main,
              name: workerName,
              url: false,
              compatibility: { date: "2024-01-01" },
            });
            yield* QueueConsumer("DLQConsumer", {
              queueId: mainQueue.queueId,
              scriptName: workerName,
              deadLetterQueue: dlq.queueName,
            });
            return { dlq, mainQueue };
          }),
        );

      const v1 = yield* deploy();
      const v2 = yield* deploy();

      // Both queues stable across redeploy — no replace, no churn from
      // the DLQ chain. (The DLQ field on a consumer is not surfaced on
      // any get/list response, so we verify the topology by observing
      // that both queues, the worker, and exactly one consumer remain
      // in place after a re-reconcile.)
      expect(v2.mainQueue.queueId).toEqual(v1.mainQueue.queueId);
      expect(v2.dlq.queueId).toEqual(v1.dlq.queueId);

      const consumers = yield* listConsumersForQueue(
        accountId,
        v1.mainQueue.queueId,
      );
      expect(consumers).toHaveLength(1);
      expect(
        consumers[0] && "script" in consumers[0] && consumers[0].script,
      ).toEqual(workerName);

      yield* stack.destroy();
      yield* waitForQueueToBeDeleted(v1.mainQueue.queueId, accountId);
      yield* waitForQueueToBeDeleted(v1.dlq.queueId, accountId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "destroying an already-deleted consumer is a no-op",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const queueName = `alchemy-test-cf-queue-cdd-${suffix}`;
      const workerName = `alchemy-test-cf-queue-cdd-worker-${suffix}`;
      const main = pathe.resolve(import.meta.dirname, "../Workers/worker.ts");

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const queue = yield* Queue("CDDQueue", { name: queueName });
          yield* Cloudflare.Worker("CDDWorker", {
            main,
            name: workerName,
            url: false,
            compatibility: { date: "2024-01-01" },
          });
          const consumer = yield* QueueConsumer("CDDConsumer", {
            queueId: queue.queueId,
            scriptName: workerName,
          });
          return { queue, consumer };
        }),
      );

      // Delete the consumer out-of-band.
      yield* queues.deleteConsumer({
        accountId,
        queueId: deployed.queue.queueId,
        consumerId: deployed.consumer.consumerId,
      });

      // Destroy must not raise — `ConsumerNotFound` is the idempotent path.
      yield* stack.destroy();
      yield* waitForQueueToBeDeleted(deployed.queue.queueId, accountId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

class QueueStillExists extends Data.TaggedError("QueueStillExists") {}

const waitForQueueToBeDeleted = Effect.fn(function* (
  queueId: string,
  accountId: string,
) {
  yield* queues
    .getQueue({
      accountId,
      queueId,
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new QueueStillExists())),
      Effect.retry({
        while: (e): e is QueueStillExists => e instanceof QueueStillExists,
        schedule: Schedule.exponential(100).pipe(Schedule.both(Schedule.recurs(15))),
      }),
      Effect.catchTag("QueueNotFound", () => Effect.void),
    );
});

const listConsumersForQueue = Effect.fn(function* (
  accountId: string,
  queueId: string,
) {
  const result = yield* queues.listConsumers({ accountId, queueId });
  return result.result;
});
