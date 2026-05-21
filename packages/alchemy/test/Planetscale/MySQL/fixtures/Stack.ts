import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Planetscale from "@/Planetscale/index.ts";
import * as Effect from "effect/Effect";

/**
 * Shared Planetscale + Cloudflare wiring used by the MySQL Hyperdrive
 * fixture workers. A long-lived staging MySQL database (named
 * deterministically so reruns adopt the same resource) owns a feature
 * branch + password; Hyperdrive points at `password.origin` so the
 * worker can connect over MySQL through Cloudflare's edge pool.
 */
export const PlanetscaleDb = Effect.gen(function* () {
  const database = yield* Planetscale.MySQLDatabase("HyperdriveTestDb", {
    name: "alchemy-mysql-hyperdrive",
    region: { slug: "us-east" },
    clusterSize: "PS_10",
    allowForeignKeyConstraints: true,
  });

  const branch = yield* Planetscale.MySQLBranch("HyperdriveTestBranch", {
    database,
    parentBranch: "main",
    isProduction: false,
    migrationsDir:
      "./packages/alchemy/test/Planetscale/MySQL/fixtures/migrations",
  });

  const password = yield* Planetscale.MySQLPassword("HyperdriveTestPassword", {
    database,
    branch,
    role: "readwriter",
  });

  return { database, branch, password };
});

export const Hyperdrive = Effect.gen(function* () {
  const { password } = yield* PlanetscaleDb;
  return yield* Cloudflare.Hyperdrive("HyperdriveTestEdge", {
    origin: password.origin,
  });
});
