import * as AWS from "@/AWS";
import {
  EIP,
  InternetGateway,
  NatGateway,
  Route,
  RouteTable,
  RouteTableAssociation,
  Subnet,
  Vpc,
} from "@/AWS/EC2";
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
  "redeploy with same props is a no-op for RouteTable + Route + Association",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("RtVpc", { cidrBlock: "10.30.0.0/16" });
          const subnet = yield* Subnet("RtSubnet", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.30.1.0/24",
          });
          const igw = yield* InternetGateway("RtIgw", { vpcId: vpc.vpcId });
          const rt = yield* RouteTable("RtTable", { vpcId: vpc.vpcId });
          const route = yield* Route("RtDefault", {
            routeTableId: rt.routeTableId,
            destinationCidrBlock: "0.0.0.0/0",
            gatewayId: igw.internetGatewayId,
          });
          const assoc = yield* RouteTableAssociation("RtAssoc", {
            routeTableId: rt.routeTableId,
            subnetId: subnet.subnetId,
          });
          return { vpc, subnet, igw, rt, route, assoc };
        }),
      );

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("RtVpc", { cidrBlock: "10.30.0.0/16" });
          const subnet = yield* Subnet("RtSubnet", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.30.1.0/24",
          });
          const igw = yield* InternetGateway("RtIgw", { vpcId: vpc.vpcId });
          const rt = yield* RouteTable("RtTable", { vpcId: vpc.vpcId });
          const route = yield* Route("RtDefault", {
            routeTableId: rt.routeTableId,
            destinationCidrBlock: "0.0.0.0/0",
            gatewayId: igw.internetGatewayId,
          });
          const assoc = yield* RouteTableAssociation("RtAssoc", {
            routeTableId: rt.routeTableId,
            subnetId: subnet.subnetId,
          });
          return { vpc, subnet, igw, rt, route, assoc };
        }),
      );

      expect(second.rt.routeTableId).toEqual(initial.rt.routeTableId);
      expect(second.assoc.associationId).toEqual(initial.assoc.associationId);
      // Route is identified by (rtb, dest); reconcile must NOT create a
      // duplicate route — observe-first finds the existing one.
      const observed = yield* EC2.describeRouteTables({
        RouteTableIds: [second.rt.routeTableId],
      });
      const matchingRoutes =
        observed.RouteTables?.[0]?.Routes?.filter(
          (r) => r.DestinationCidrBlock === "0.0.0.0/0",
        ) ?? [];
      expect(matchingRoutes.length).toEqual(1);

      yield* stack.destroy();
      yield* assertRouteTableDeleted(initial.rt.routeTableId);
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "destroying an already-deleted RouteTable + Association is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("RtDestroyVpc", {
            cidrBlock: "10.31.0.0/16",
          });
          const subnet = yield* Subnet("RtDestroySubnet", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.31.1.0/24",
          });
          const rt = yield* RouteTable("RtDestroyTable", {
            vpcId: vpc.vpcId,
          });
          const assoc = yield* RouteTableAssociation("RtDestroyAssoc", {
            routeTableId: rt.routeTableId,
            subnetId: subnet.subnetId,
          });
          return { vpc, subnet, rt, assoc };
        }),
      );

      // Disassociate + delete the route table out of band so destroy must
      // tolerate "already gone".
      yield* EC2.disassociateRouteTable({
        AssociationId: initial.assoc.associationId,
      });
      yield* EC2.deleteRouteTable({ RouteTableId: initial.rt.routeTableId });
      yield* assertRouteTableDeleted(initial.rt.routeTableId);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);

// NAT Gateway create/delete is the longest-running EC2 op (~2min each), so
// we keep this test minimal — just exercise the happy path through reconcile
// + destroy with the hardened delete (DependencyViolation tolerance and
// `read` recovery from a deleted-out-of-band gateway).
test.provider(
  "NAT Gateway happy path",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("NatVpc", { cidrBlock: "10.32.0.0/16" });
          const subnet = yield* Subnet("NatSubnet", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.32.1.0/24",
          });
          const eip = yield* EIP("NatEip", {});
          const nat = yield* NatGateway("Nat", {
            subnetId: subnet.subnetId,
            allocationId: eip.allocationId,
          });
          return { vpc, subnet, eip, nat };
        }),
      );

      expect(result.nat.state).toEqual("available");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 600_000 },
);

class RtStillExists extends Data.TaggedError("RtStillExists") {}

const assertRouteTableDeleted = Effect.fn(function* (routeTableId: string) {
  yield* EC2.describeRouteTables({ RouteTableIds: [routeTableId] }).pipe(
    Effect.flatMap(() => Effect.fail(new RtStillExists())),
    Effect.retry({
      while: (e) => e instanceof RtStillExists,
      schedule: Schedule.exponential(100),
    }),
    Effect.catchTag("InvalidRouteTableID.NotFound", () => Effect.void),
  );
});
