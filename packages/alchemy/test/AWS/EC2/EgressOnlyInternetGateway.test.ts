import * as AWS from "@/AWS";
import { EgressOnlyInternetGateway, Vpc } from "@/AWS/EC2";
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
          const vpc = yield* Vpc("EigwVpc", { cidrBlock: "10.40.0.0/16" });
          const eigw = yield* EgressOnlyInternetGateway("Eigw", {
            vpcId: vpc.vpcId,
          });
          return { vpc, eigw };
        }),
      );

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("EigwVpc", { cidrBlock: "10.40.0.0/16" });
          const eigw = yield* EgressOnlyInternetGateway("Eigw", {
            vpcId: vpc.vpcId,
          });
          return { vpc, eigw };
        }),
      );

      expect(second.eigw.egressOnlyInternetGatewayId).toEqual(
        initial.eigw.egressOnlyInternetGatewayId,
      );

      yield* stack.destroy();
      yield* assertEigwDeleted(initial.eigw.egressOnlyInternetGatewayId);
    }).pipe(logLevel),
);

test.provider(
  "destroying an already-deleted EIGW is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("EigwDoubleVpc", {
            cidrBlock: "10.41.0.0/16",
          });
          const eigw = yield* EgressOnlyInternetGateway("EigwDouble", {
            vpcId: vpc.vpcId,
          });
          return { vpc, eigw };
        }),
      );

      yield* EC2.deleteEgressOnlyInternetGateway({
        EgressOnlyInternetGatewayId: initial.eigw.egressOnlyInternetGatewayId,
      });
      yield* assertEigwDeleted(initial.eigw.egressOnlyInternetGatewayId);

      yield* stack.destroy();
    }).pipe(logLevel),
);

class EigwStillExists extends Data.TaggedError("EigwStillExists") {}

const assertEigwDeleted = Effect.fn(function* (eigwId: string) {
  yield* EC2.describeEgressOnlyInternetGateways({
    EgressOnlyInternetGatewayIds: [eigwId],
  }).pipe(
    Effect.flatMap((r) =>
      r.EgressOnlyInternetGateways && r.EgressOnlyInternetGateways.length > 0
        ? Effect.fail(new EigwStillExists())
        : Effect.void,
    ),
    Effect.retry({
      while: (e) => e instanceof EigwStillExists,
      schedule: Schedule.exponential(100),
    }),
    Effect.catchTag("InvalidEgressOnlyInternetGatewayId.NotFound", () =>
      Effect.void,
    ),
  );
});
