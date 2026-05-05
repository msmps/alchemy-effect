import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Vitest";
import * as connectivity from "@distilled.cloud/cloudflare/connectivity";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("create, update, delete vpc service", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const { tunnel, service } = yield* stack.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel("VpcTunnel", {
          ingress: [{ service: "http://localhost:8080" }],
          adopt: true,
        });
        const service = yield* Cloudflare.VpcService("VpcSvc", {
          httpPort: 8080,
          host: {
            hostname: "localhost",
            resolverNetwork: { tunnelId: tunnel.tunnelId },
          },
          adopt: true,
        });
        return { tunnel, service };
      }),
    );

    expect(service.serviceId).toBeDefined();
    expect(service.serviceType).toEqual("http");
    expect(service.httpPort).toEqual(8080);
    expect(service.host).toMatchObject({
      hostname: "localhost",
      resolverNetwork: { tunnelId: tunnel.tunnelId },
    });

    const fetched = yield* connectivity.getDirectoryService({
      accountId,
      serviceId: service.serviceId,
    });
    expect(fetched.serviceId).toEqual(service.serviceId);
    expect(fetched.httpPort).toEqual(8080);

    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel("VpcTunnel", {
          ingress: [{ service: "http://localhost:8080" }],
          adopt: true,
        });
        return yield* Cloudflare.VpcService("VpcSvc", {
          httpPort: 3000,
          httpsPort: 3001,
          host: {
            hostname: "localhost",
            resolverNetwork: { tunnelId: tunnel.tunnelId },
          },
          adopt: true,
        });
      }),
    );

    expect(updated.serviceId).toEqual(service.serviceId);
    expect(updated.httpPort).toEqual(3000);
    expect(updated.httpsPort).toEqual(3001);

    const fetchedUpdated = yield* connectivity.getDirectoryService({
      accountId,
      serviceId: service.serviceId,
    });
    expect(fetchedUpdated.httpPort).toEqual(3000);
    expect(fetchedUpdated.httpsPort).toEqual(3001);

    yield* stack.destroy();

    yield* waitForServiceToBeDeleted(service.serviceId, accountId);
  }).pipe(logLevel),
);

test.provider("create vpc service with ipv4 host", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const service = yield* stack.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel("Ipv4Tunnel", {
          ingress: [{ service: "http://localhost:8080" }],
          adopt: true,
        });
        return yield* Cloudflare.VpcService("Ipv4Svc", {
          httpPort: 8080,
          host: {
            ipv4: "192.168.1.100",
            network: { tunnelId: tunnel.tunnelId },
          },
          adopt: true,
        });
      }),
    );

    expect(service.host).toMatchObject({
      ipv4: "192.168.1.100",
    });
    expect("ipv6" in service.host).toBe(false);

    const fetched = yield* connectivity.getDirectoryService({
      accountId,
      serviceId: service.serviceId,
    });
    expect((fetched.host as { ipv4?: string }).ipv4).toEqual("192.168.1.100");

    yield* stack.destroy();
    yield* waitForServiceToBeDeleted(service.serviceId, accountId);
  }).pipe(logLevel),
);

// TODO: re-enable once distilled ships the union-ordering fix
// (alchemy-run/distilled#232) — on @distilled.cloud/cloudflare@0.16.3 the
// dual-stack host variant comes after the ipv4-only variant in the request
// schema's Schema.Union, so `ipv6` is silently stripped on encode.
test.provider.skip("create vpc service with dual-stack host", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const service = yield* stack.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel("DualStackTunnel", {
          ingress: [{ service: "http://localhost:8080" }],
          adopt: true,
        });
        return yield* Cloudflare.VpcService("DualStackSvc", {
          httpPort: 8080,
          host: {
            ipv4: "192.168.1.101",
            ipv6: "2001:db8::1",
            network: { tunnelId: tunnel.tunnelId },
          },
          adopt: true,
        });
      }),
    );

    expect(service.host).toMatchObject({
      ipv4: "192.168.1.101",
      ipv6: "2001:db8::1",
    });

    yield* stack.destroy();
    yield* waitForServiceToBeDeleted(service.serviceId, accountId);
  }).pipe(logLevel),
);

const waitForServiceToBeDeleted = Effect.fn(function* (
  serviceId: string,
  accountId: string,
) {
  yield* connectivity.getDirectoryService({ accountId, serviceId }).pipe(
    Effect.flatMap(() => Effect.fail(new VpcServiceStillExists())),
    Effect.retry({
      while: (e): e is VpcServiceStillExists =>
        e instanceof VpcServiceStillExists,
      schedule: Schedule.exponential(100),
    }),
    Effect.catch(() => Effect.void),
  );
});

class VpcServiceStillExists extends Data.TaggedError("VpcServiceStillExists") {}

// ─────────────────────────────────────────────────────────────────────
// Lifecycle convergence
//
// Reconcile must converge from any starting state — pristine, drifted,
// out-of-band-deleted, or replaced — without leaning on `olds` as a
// source of truth. The tests below pin down each starting state.
// ─────────────────────────────────────────────────────────────────────

const randomSuffix = () => Math.random().toString(36).slice(2, 8);

test.provider(
  "redeploy with same props is a no-op (reconcile is idempotent)",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            const tunnel = yield* Cloudflare.Tunnel("IdempotentTunnel", {
              ingress: [{ service: "http://localhost:8080" }],
              adopt: true,
            });
            return yield* Cloudflare.VpcService("IdempotentSvc", {
              httpPort: 8080,
              host: {
                hostname: "idempotent.example.com",
                resolverNetwork: { tunnelId: tunnel.tunnelId },
              },
              adopt: true,
            });
          }),
        );

      const v1 = yield* deploy();
      const v2 = yield* deploy();

      expect(v2.serviceId).toEqual(v1.serviceId);
      expect(v2.serviceName).toEqual(v1.serviceName);
      expect(v2.httpPort).toEqual(8080);

      const fetched = yield* connectivity.getDirectoryService({
        accountId,
        serviceId: v2.serviceId,
      });
      expect(fetched.serviceId).toEqual(v1.serviceId);
      expect(fetched.httpPort).toEqual(8080);

      yield* stack.destroy();
      yield* waitForServiceToBeDeleted(v1.serviceId, accountId);
    }).pipe(logLevel),
);

test.provider(
  "reconcile resets settings mutated out-of-band via the raw Cloudflare API",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            const tunnel = yield* Cloudflare.Tunnel("DriftTunnel", {
              ingress: [{ service: "http://localhost:8080" }],
              adopt: true,
            });
            return yield* Cloudflare.VpcService("DriftSvc", {
              httpPort: 8080,
              host: {
                hostname: "drift.example.com",
                resolverNetwork: { tunnelId: tunnel.tunnelId },
              },
              adopt: true,
            });
          }),
        );

      const v1 = yield* deploy();

      // Mutate the live service out-of-band — change ports and
      // hostname directly via the raw API (the kind of drift a manual
      // edit in the Cloudflare dashboard would produce).
      yield* connectivity.updateDirectoryService({
        accountId,
        serviceId: v1.serviceId,
        name: v1.serviceName,
        type: "http",
        httpPort: 9999,
        httpsPort: 9998,
        host: {
          hostname: "tampered.example.com",
          resolverNetwork: {
            tunnelId: (
              v1.host as {
                resolverNetwork: { tunnelId: string };
              }
            ).resolverNetwork.tunnelId,
          },
        },
      });

      // Re-deploy with the original desired props. Reconcile observes
      // the service by id, then unconditionally PUTs the desired
      // settings — the foreign drift is overwritten.
      const v2 = yield* deploy();
      expect(v2.serviceId).toEqual(v1.serviceId);

      const fetched = yield* connectivity.getDirectoryService({
        accountId,
        serviceId: v2.serviceId,
      });
      expect(fetched.httpPort).toEqual(8080);
      expect((fetched.host as { hostname?: string }).hostname).toEqual(
        "drift.example.com",
      );

      yield* stack.destroy();
      yield* waitForServiceToBeDeleted(v1.serviceId, accountId);
    }).pipe(logLevel),
);

test.provider(
  "reconcile re-creates a service that was deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const serviceName = `alchemy-test-vpcsvc-recreate-${randomSuffix()}`;

      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            const tunnel = yield* Cloudflare.Tunnel("RecreateTunnel", {
              ingress: [{ service: "http://localhost:8080" }],
              adopt: true,
            });
            return yield* Cloudflare.VpcService("RecreateSvc", {
              name: serviceName,
              httpPort: 8080,
              host: {
                hostname: "recreate.example.com",
                resolverNetwork: { tunnelId: tunnel.tunnelId },
              },
              adopt: true,
            });
          }),
        );

      const v1 = yield* deploy();
      expect(v1.serviceName).toEqual(serviceName);

      // Delete the service out-of-band. Local state still references
      // it, but Cloudflare no longer has it.
      yield* connectivity.deleteDirectoryService({
        accountId,
        serviceId: v1.serviceId,
      });
      yield* waitForServiceToBeDeleted(v1.serviceId, accountId);

      // Reconcile must catch `VpcServiceNotFound` from `getService`,
      // fall through to `findServiceByName` (also empty), and create
      // a fresh service.
      const v2 = yield* deploy();
      expect(v2.serviceName).toEqual(serviceName);
      expect(v2.serviceId).not.toEqual(v1.serviceId);

      const fresh = yield* connectivity.getDirectoryService({
        accountId,
        serviceId: v2.serviceId,
      });
      expect(fresh.serviceId).toEqual(v2.serviceId);

      yield* stack.destroy();
      yield* waitForServiceToBeDeleted(v2.serviceId, accountId);
    }).pipe(logLevel),
);

test.provider(
  "changing service name updates in place (name is mutable)",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const suffix = randomSuffix();
      const nameA = `alchemy-test-vpcsvc-rename-a-${suffix}`;
      const nameB = `alchemy-test-vpcsvc-rename-b-${suffix}`;

      const deploy = (name: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const tunnel = yield* Cloudflare.Tunnel("RenameTunnel", {
              ingress: [{ service: "http://localhost:8080" }],
              adopt: true,
            });
            return yield* Cloudflare.VpcService("RenameSvc", {
              name,
              httpPort: 8080,
              host: {
                hostname: "rename.example.com",
                resolverNetwork: { tunnelId: tunnel.tunnelId },
              },
              adopt: true,
            });
          }),
        );

      const a = yield* deploy(nameA);
      expect(a.serviceName).toEqual(nameA);

      const b = yield* deploy(nameB);
      expect(b.serviceName).toEqual(nameB);
      // diff returns `update`, not `replace` — same id, new name.
      expect(b.serviceId).toEqual(a.serviceId);

      const fetched = yield* connectivity.getDirectoryService({
        accountId,
        serviceId: b.serviceId,
      });
      expect(fetched.name).toEqual(nameB);

      yield* stack.destroy();
      yield* waitForServiceToBeDeleted(b.serviceId, accountId);
    }).pipe(logLevel),
);

test.provider("destroying an already-deleted service is a no-op", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const service = yield* stack.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel("DoubleDestroyTunnel", {
          ingress: [{ service: "http://localhost:8080" }],
          adopt: true,
        });
        return yield* Cloudflare.VpcService("DoubleDestroySvc", {
          httpPort: 8080,
          host: {
            hostname: "doubledestroy.example.com",
            resolverNetwork: { tunnelId: tunnel.tunnelId },
          },
          adopt: true,
        });
      }),
    );

    // Delete the service out-of-band so the next destroy hits the
    // not-found path in provider.delete. The catchTag on
    // `VpcServiceNotFound` must absorb the error cleanly.
    yield* connectivity.deleteDirectoryService({
      accountId,
      serviceId: service.serviceId,
    });
    yield* waitForServiceToBeDeleted(service.serviceId, accountId);

    // First destroy: state still references the deleted service; the
    // engine calls provider.delete which must idempotently succeed.
    yield* stack.destroy();

    // Second destroy: state is gone; this is a true no-op.
    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider(
  "adopt(true) re-claims a foreign service matching by name",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const serviceName = `alchemy-test-vpcsvc-adopt-${randomSuffix()}`;

      // Phase 1 — provision a tunnel via the engine (we need a real
      // tunnel id) but create the VPC service out-of-band so it has
      // no engine ownership state.
      const { tunnelId } = yield* stack.deploy(
        Effect.gen(function* () {
          const tunnel = yield* Cloudflare.Tunnel("AdoptTunnel", {
            ingress: [{ service: "http://localhost:8080" }],
            adopt: true,
          });
          return { tunnelId: tunnel.tunnelId };
        }),
      );

      const foreign = yield* connectivity.createDirectoryService({
        accountId,
        name: serviceName,
        type: "http",
        httpPort: 8080,
        host: {
          hostname: "adopt.example.com",
          resolverNetwork: { tunnelId },
        },
      });

      // Phase 2 — without `adopt: true`, the create call should fail
      // with `VpcServiceNameAlreadyExists` and reconcile must surface
      // that error rather than silently take over the foreign service.
      const refusal = yield* stack
        .deploy(
          Effect.gen(function* () {
            const tunnel = yield* Cloudflare.Tunnel("AdoptTunnel", {
              ingress: [{ service: "http://localhost:8080" }],
              adopt: true,
            });
            return yield* Cloudflare.VpcService("AdoptSvc", {
              name: serviceName,
              httpPort: 8080,
              host: {
                hostname: "adopt.example.com",
                resolverNetwork: { tunnelId: tunnel.tunnelId },
              },
            });
          }),
        )
        .pipe(Effect.flip);
      expect(refusal).toBeDefined();

      // Phase 3 — with `adopt: true`, reconcile re-lists by name and
      // takes over the existing service without creating a duplicate.
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          const tunnel = yield* Cloudflare.Tunnel("AdoptTunnel", {
            ingress: [{ service: "http://localhost:8080" }],
            adopt: true,
          });
          return yield* Cloudflare.VpcService("AdoptSvc", {
            name: serviceName,
            httpPort: 8080,
            host: {
              hostname: "adopt.example.com",
              resolverNetwork: { tunnelId: tunnel.tunnelId },
            },
            adopt: true,
          });
        }),
      );
      expect(adopted.serviceName).toEqual(serviceName);
      expect(adopted.serviceId).toEqual(foreign.serviceId);

      yield* stack.destroy();
      yield* waitForServiceToBeDeleted(foreign.serviceId!, accountId);
    }).pipe(logLevel),
);
