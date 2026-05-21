---
title: PlanetScale, branched per PR
date: 2026-05-21T20:00:00Z
excerpt: PlanetScale lands as a first-class provider — `MySQLDatabase` and `PostgresDatabase`, branches, credentials, and a Drizzle integration that plugs straight into Cloudflare Hyperdrive. The cluster is owned by one stage; PR previews fork off it with `.ref()`.
---

`alchemy/Planetscale` is the new provider. Both engines mirror
each other one-for-one:

| MySQL                       | Postgres                       |
| --------------------------- | ------------------------------ |
| `Planetscale.MySQLDatabase` | `Planetscale.PostgresDatabase` |
| `Planetscale.MySQLBranch`   | `Planetscale.PostgresBranch`   |
| `Planetscale.MySQLPassword` | `Planetscale.PostgresRole`     |

The shape is database → branch → credentials → Hyperdrive →
Worker. The walkthrough below uses Postgres; the MySQL deltas
are inline.

## The resource graph

A `PostgresDatabase` is the long-lived cluster. `PostgresBranch`
is the cheap per-environment fork. `PostgresRole` is the
credentials — a real Postgres role with `GRANT`s from
`inheritedRoles`.

```typescript
// src/Db.ts
export const Db = Effect.gen(function* () {
  const database = yield* Planetscale.PostgresDatabase("app-db", {
    region: { slug: "us-east" },
    clusterSize: "PS_10",
  });

  const branch = yield* Planetscale.PostgresBranch("app-branch", {
    database,
  });

  const role = yield* Planetscale.PostgresRole("app-role", {
    database,
    branch,
    inheritedRoles: ["postgres"],
  });

  return { database, branch, role };
});
```

`region` and `arch` are stable: changing either triggers a
replacement. `clusterSize` is mutable and gets resized in place.

For MySQL, swap `PostgresDatabase` → `MySQLDatabase`,
`PostgresBranch` → `MySQLBranch` (plus `isProduction: false` for
ephemeral branches), and `PostgresRole` → `MySQLPassword` (with
`role: "reader" | "writer" | "admin" | "readwriter"`).

## Hyperdrive consumes `role.origin` directly

Every credentials resource exposes an `origin` attribute:

```typescript
role.origin: {
  scheme: "postgres" | "postgresql";
  host: string;
  port: number;
  database: string;
  user: string;
  password: Redacted.Redacted<string>;
};
```

This is the exact shape `Cloudflare.Hyperdrive` accepts. Wiring
the two is one line:

```typescript
const hd = yield* Cloudflare.Hyperdrive("app-hyperdrive", {
  origin: role.origin,
});
```

Because `role.origin` is an `Output`, the deploy graph orders
itself: `PostgresDatabase` → `PostgresBranch` → `PostgresRole`
→ `Hyperdrive` → `Worker`. No explicit `dependsOn`. (For MySQL,
pass `password.origin` — Hyperdrive sees `scheme: "mysql"` and
provisions a MySQL pooler.)

## Drizzle on top, via the new `alchemy/Drizzle` helper

`Drizzle.postgres(conn.connectionString)` returns a chainable
proxy over `EffectPgDatabase`. Every method call builds an
Effect, so queries are just `yield*`-able:

```typescript
// src/Api.ts
Effect.gen(function* () {
  const conn = yield* Cloudflare.Hyperdrive.bind(Hyperdrive);
  const db = yield* Drizzle.postgres(conn.connectionString, { relations });

  return {
    fetch: Effect.gen(function* () {
      const users = yield* db.select().from(Users);
      return yield* HttpServerResponse.json({ users });
    }),
  };
}).pipe(Effect.provide(Cloudflare.HyperdriveBindingLive))
```

The pool is materialised lazily against an isolated, never-
closing `Scope` — one pool per JS realm, shared across requests,
and `Cloudflare.Worker`'s `Effect.scoped` boundary doesn't tear
it down between fetches.

(MySQL uses `drizzle-orm/mysql2` directly inside the `fetch`
body, one connection per request. There's no `Drizzle.mysql`
helper yet — see the
[MySQL example](https://github.com/alchemy-run/alchemy-effect/tree/main/examples/cloudflare-planetscale-mysql-drizzle/src/Api.ts).)

## Migrations as a resource

`Drizzle.Schema` wraps drizzle-kit's programmatic API as an
alchemy resource. Wire its `out` output into a branch's
`migrationsDir` and the dependency graph drives the whole flow:

```diff lang="typescript"
+const schema = yield* Drizzle.Schema("app-schema", {
+  schema: "./src/schema.ts",
+  out: "./migrations",
+});

 const branch = yield* Planetscale.PostgresBranch("app-branch", {
   database,
+  migrationsDir: schema.out,
 });
```

On every deploy: `Drizzle.Schema` diffs the source against the
latest snapshot, writes a new `{timestamp}_migration/` directory
when it drifts, and `PostgresBranch` then scans the directory
and applies new SQL files transactionally against its own
connection.

This is the same flow the [Drizzle tutorial](/tutorial/cloudflare/drizzle)
walks through against Neon — the PlanetScale wiring is
identical, just with `PostgresBranch.migrationsDir` instead of
`Neon.Branch.migrationsDir`.

## `.ref()` — fork from a centralised staging database

So far every deploy creates a fresh `PostgresDatabase`. That's
fine for `dev_<user>` and for prod, but it's wrong for PR
previews — spinning up a new Postgres cluster per PR is slow,
expensive, and out of step with how PlanetScale itself thinks
about branching.

The pattern splits stages into two tiers:

- **`staging-*` stages own the long-lived database.** They run
  on PR open (creating `staging-pr-123` for PR #123) and on push
  to main. They provision `PostgresDatabase`, nothing else.
- **`pr-*` stages own ephemeral compute.** They reference the
  `staging-pr-*` database via `.ref()` and provision only the
  per-PR branch, role, Hyperdrive, and Worker.

One ternary is the fork point:

```diff lang="typescript"
+const { stage } = yield* Alchemy.Stack;

-const database = yield* Planetscale.PostgresDatabase("app-db", {
-  region: { slug: "us-east" },
-  clusterSize: "PS_10",
-});
+const database = stage.startsWith("pr-")
+  ? yield* Planetscale.PostgresDatabase.ref("app-db", {
+      stage: `staging-${stage}`,
+    })
+  : yield* Planetscale.PostgresDatabase("app-db", {
+      region: { slug: "us-east" },
+      clusterSize: "PS_10",
+    });
```

`PostgresDatabase.ref("app-db", { stage })` reads the resource's
output attributes from another stage's state instead of
provisioning a new one. The returned value has the same
`PostgresDatabase` type — downstream code (the branch, the
role, the Hyperdrive) can't tell the difference between an
owned database and a referenced one.

This is the same mechanism the
[Branch from a shared database](/tutorial/cloudflare/branch-from-shared-database)
tutorial and the [Shared database](/guides/shared-database)
guide walk through against Neon. The PlanetScale story is
identical — `Resource.ref(id, { stage })` is the cross-stage
reference, regardless of provider.

## Where to go next

- [Hyperdrive tutorial](/tutorial/cloudflare/neon-hyperdrive) — now with PlanetScale Postgres and MySQL as side-by-side tabs alongside Neon
- [Drizzle tutorial](/tutorial/cloudflare/drizzle) — `Drizzle.Schema` and deploy-driven migrations
- [Branch from a shared database](/tutorial/cloudflare/branch-from-shared-database) — the `.ref()` pattern as a guided tutorial
- [Shared database guide](/guides/shared-database) — the reference for cross-stage references
- [PlanetScale Postgres + Drizzle example](https://github.com/alchemy-run/alchemy-effect/tree/main/examples/cloudflare-planetscale-postgres-drizzle)
- [PlanetScale MySQL + Drizzle example](https://github.com/alchemy-run/alchemy-effect/tree/main/examples/cloudflare-planetscale-mysql-drizzle)
- [#113 — feat(planetscale): add planetscale resources](https://github.com/alchemy-run/alchemy-effect/pull/113)
