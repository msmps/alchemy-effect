import * as AWS from "@/AWS";
import { InternetGateway, Vpc } from "@/AWS/EC2";
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
          const vpc = yield* Vpc("IgwIdempotentVpc", {
            cidrBlock: "10.20.0.0/16",
          });
          const igw = yield* InternetGateway("IgwIdempotent", {
            vpcId: vpc.vpcId,
          });
          return { vpc, igw };
        }),
      );

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("IgwIdempotentVpc", {
            cidrBlock: "10.20.0.0/16",
          });
          const igw = yield* InternetGateway("IgwIdempotent", {
            vpcId: vpc.vpcId,
          });
          return { vpc, igw };
        }),
      );

      expect(second.igw.internetGatewayId).toEqual(
        initial.igw.internetGatewayId,
      );
      expect(second.igw.vpcId).toEqual(initial.vpc.vpcId);

      yield* stack.destroy();
      yield* assertIgwDeleted(initial.igw.internetGatewayId);
    }).pipe(logLevel),
);

test.provider(
  "reconcile re-attaches a detached IGW",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("IgwReattachVpc", {
            cidrBlock: "10.21.0.0/16",
          });
          const igw = yield* InternetGateway("IgwReattach", {
            vpcId: vpc.vpcId,
          });
          return { vpc, igw };
        }),
      );

      // Detach out of band.
      yield* EC2.detachInternetGateway({
        InternetGatewayId: initial.igw.internetGatewayId,
        VpcId: initial.vpc.vpcId,
      });

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("IgwReattachVpc", {
            cidrBlock: "10.21.0.0/16",
          });
          const igw = yield* InternetGateway("IgwReattach", {
            vpcId: vpc.vpcId,
          });
          return { vpc, igw };
        }),
      );

      expect(second.igw.internetGatewayId).toEqual(
        initial.igw.internetGatewayId,
      );
      // Confirm cloud state — the IGW is attached to the VPC again.
      const observed = yield* EC2.describeInternetGateways({
        InternetGatewayIds: [second.igw.internetGatewayId],
      });
      const attachments = observed.InternetGateways?.[0]?.Attachments ?? [];
      expect(attachments.some((a) => a.VpcId === second.vpc.vpcId)).toEqual(
        true,
      );

      yield* stack.destroy();
      yield* assertIgwDeleted(initial.igw.internetGatewayId);
    }).pipe(logLevel),
);

test.provider(
  "destroying an already-deleted IGW is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("IgwDoubleDestroyVpc", {
            cidrBlock: "10.22.0.0/16",
          });
          const igw = yield* InternetGateway("IgwDoubleDestroy", {
            vpcId: vpc.vpcId,
          });
          return { vpc, igw };
        }),
      );

      // Detach + delete out of band so both detach and delete in our
      // delete path must tolerate "already gone".
      yield* EC2.detachInternetGateway({
        InternetGatewayId: initial.igw.internetGatewayId,
        VpcId: initial.vpc.vpcId,
      });
      yield* EC2.deleteInternetGateway({
        InternetGatewayId: initial.igw.internetGatewayId,
      });
      yield* assertIgwDeleted(initial.igw.internetGatewayId);

      yield* stack.destroy();
    }).pipe(logLevel),
);

class IgwStillExists extends Data.TaggedError("IgwStillExists") {}

const assertIgwDeleted = Effect.fn(function* (igwId: string) {
  yield* EC2.describeInternetGateways({
    InternetGatewayIds: [igwId],
  }).pipe(
    Effect.flatMap(() => Effect.fail(new IgwStillExists())),
    Effect.retry({
      while: (e) => e instanceof IgwStillExists,
      schedule: Schedule.exponential(100),
    }),
    Effect.catchTag("InvalidInternetGatewayID.NotFound", () => Effect.void),
  );
});
