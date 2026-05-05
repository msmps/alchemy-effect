import * as AWS from "@/AWS";
import { EIP } from "@/AWS/EC2";
import * as Test from "@/Test/Vitest";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider(
  "redeploy with same props is a no-op (reconcile is idempotent)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EIP("EipIdempotent", {});
        }),
      );

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EIP("EipIdempotent", {});
        }),
      );
      expect(second.allocationId).toEqual(initial.allocationId);
      expect(second.publicIp).toEqual(initial.publicIp);

      yield* stack.destroy();
      yield* assertEipReleased(initial.allocationId);
    }).pipe(logLevel),
);

test.provider(
  "reconcile re-creates an EIP that was released out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EIP("EipRecreate", {});
        }),
      );

      yield* EC2.releaseAddress({ AllocationId: initial.allocationId });
      yield* assertEipReleased(initial.allocationId);

      const recreated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EIP("EipRecreate", {});
        }),
      );
      expect(recreated.allocationId).not.toEqual(initial.allocationId);

      yield* stack.destroy();
      yield* assertEipReleased(recreated.allocationId);
    }).pipe(logLevel),
);

test.provider(
  "destroying an already-released EIP is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const eip = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EIP("EipDoubleDestroy", {});
        }),
      );
      yield* EC2.releaseAddress({ AllocationId: eip.allocationId });
      yield* assertEipReleased(eip.allocationId);

      yield* stack.destroy();
    }).pipe(logLevel),
);

class EipStillExists extends Data.TaggedError("EipStillExists") {}

const assertEipReleased = Effect.fn(function* (allocationId: string) {
  yield* EC2.describeAddresses({ AllocationIds: [allocationId] }).pipe(
    Effect.flatMap((r) =>
      r.Addresses && r.Addresses.length > 0
        ? Effect.fail(new EipStillExists())
        : Effect.void,
    ),
    Effect.retry({
      while: (e) => e instanceof EipStillExists,
      schedule: Schedule.exponential(100),
    }),
    Effect.catchTag("InvalidAllocationID.NotFound", () => Effect.void),
  );
});
