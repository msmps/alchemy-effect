import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Neon from "@/Neon/index.ts";
import * as Effect from "effect/Effect";

/**
 * Shared Neon + Cloudflare wiring used by the Neon Hyperdrive fixture
 * workers. A long-lived staging Neon project (named deterministically
 * so reruns adopt the same resource) owns a feature branch; Hyperdrive
 * points at `branch.origin` so the worker can connect over Postgres
 * through Cloudflare's edge pool.
 */
export const NeonDb = Effect.gen(function* () {
  const project = yield* Neon.Project("HyperdriveTestProject", {
    name: "alchemy-neon-hyperdrive",
    region: "aws-us-east-1",
  });

  const branch = yield* Neon.Branch("HyperdriveTestBranch", {
    project,
    migrationsDir: "./packages/alchemy/test/Neon/fixtures/migrations",
  });

  return { project, branch };
});

export const Hyperdrive = Effect.gen(function* () {
  const { branch } = yield* NeonDb;
  return yield* Cloudflare.Hyperdrive("HyperdriveTestEdge", {
    origin: branch.origin,
  });
});
