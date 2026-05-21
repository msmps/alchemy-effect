---
title: Layers, infrastructure behind a typed interface
date: 2026-05-21T21:00:00Z
excerpt: `WorkerEnvironment` used to leak through every binding API call into the consumer's type signature. Move it onto the Layer instead — closed over once at Layer construction — and bindings return `RuntimeContext` everywhere. The runtime-only color is now a single, cloud-agnostic Effect requirement.
---

An Infrastructure Layer is supposed to be a sealed box: it owns
the resources and bindings it needs, returns a typed service,
and the consumer depends on the interface, not the cloud
underneath.

That seal had a leak. Every binding-API method —
`kv.get(...)`, `bucket.put(...)`, `db.prepare(...).first()` —
returned an `Effect` whose `R` channel carried
`WorkerEnvironment`. The cloud-specific dependency dragged
itself all the way up into whatever Layer wrapped the binding.
[`v2.0.0-beta.43`](/blog/2026-05-21-beta-43) plugs that leak
([#383](https://github.com/alchemy-run/alchemy-effect/pull/383)),
and lands `Alchemy.RuntimeContext` as the single, cloud-agnostic
color for runtime-only code.

## The leak

Take a Layer that wants to wrap KV behind a typed service.
Before the change, the return type of every method on the
binding was:

```typescript
kv.get(key, "json"): Effect.Effect<Job | null, KVNamespaceError, WorkerEnvironment>
//                                                                ^^^^^^^^^^^^^^^^
```

`WorkerEnvironment` is the Cloudflare-runtime service — the
thing that gives you access to the live `env` object inside a
deployed Worker. It exists only inside `Cloudflare.Worker`.

That requirement is contagious through Effect's `R` channel.
The moment a `JobService` Layer wrapped `kv.get`:

```typescript
export const JobServiceKV = Layer.effect(
  JobService,
  Effect.gen(function* () {
    const kv = yield* Cloudflare.KVNamespaceBinding.bind(MyKV);
    return {
      getJob: Effect.fn(function* (id: string) {
        return yield* kv.get<Job>(id, "json");
        //                                    └─ pulls WorkerEnvironment up
      }),
    };
  }),
);
```

— `WorkerEnvironment` had to surface in `JobService.getJob`'s
declared type, or the Layer didn't type-check. The "abstract
service" interface couldn't actually be cloud-agnostic, because
its return type told you exactly which cloud it ran on.

That's not a leaky abstraction in the figurative sense. It's a
leaky abstraction in the type-system sense — the encapsulation
boundary was visibly broken at the type level.

## The fix — close over `env` once

The fix lives in each `*BindingLive` Layer. Resolve
`WorkerEnvironment` once during Layer construction, close over
the resulting `env`, return methods that don't require it
anymore:

```diff lang="typescript"
 export const KVNamespaceBindingLive = Layer.effect(
   KVNamespaceBinding,
   Effect.gen(function* () {
     const bind = yield* KVNamespaceBindingPolicy;
+    const env = yield* WorkerEnvironment;

     return Effect.fn(function* (bucket: KVNamespace) {
       yield* bind(bucket);
-      const raw = WorkerEnvironment.pipe(
-        Effect.map((env) =>
-          (env as Record<string, runtime.KVNamespace>)[bucket.LogicalId],
-        ),
-      );
+      const raw = Effect.sync(
+        () => (env as Record<string, runtime.KVNamespace>)[bucket.LogicalId],
+      );
       // ...
     });
   }),
 );
```

`WorkerEnvironment` is now a dependency of the `Live` Layer,
not of the runtime methods it produces. Satisfy it at the
Worker boundary (the Worker runtime does this automatically) and
nothing downstream has to know.

Every binding interface in `alchemy/Cloudflare` now matches
this shape — KV, R2, D1, Hyperdrive, Queue, AiGateway,
Analytics Engine, Images, Email, Artifacts, Secrets Store,
Durable Object namespace, Workflow, Dynamic Worker Loader. The
same pattern lands on AWS bindings.

## `RuntimeContext` — coloring runtime-only code

The methods still need *some* requirement, because they still
do real I/O — they can't be allowed to run from a deploy script
or a plan run. That's what `Alchemy.RuntimeContext` is for:

```diff lang="typescript"
-kv.get(key, "json"): Effect.Effect<Job | null, KVNamespaceError, WorkerEnvironment>
+kv.get(key, "json"): Effect.Effect<Job | null, KVNamespaceError, RuntimeContext>
```

`RuntimeContext` is a typed Effect service that exists *only*
inside a deployed Function or Worker. Provided automatically by
the runtime; never available at plan time, init time, or
anywhere else.

This is the "colored function" trick, encoded as an Effect
requirement. Code with `RuntimeContext` in its `R` channel is
provably "this can only run inside a deployed handler" — call
it from a deploy script and the type checker rejects the call,
because nothing in scope satisfies the requirement.

```typescript
// inside Cloudflare.Worker's runtime closure — fine
fetch: Effect.gen(function* () {
  const job = yield* kv.get<Job>("job-1", "json"); // ✓ RuntimeContext satisfied
  return HttpServerResponse.json(job);
});

// at the top of alchemy.run.ts — fails to type-check
const job = yield* kv.get<Job>("job-1", "json");
//                                                ^ RuntimeContext not satisfied
```

It's the same protection `WorkerEnvironment` was giving you
incidentally — "this method only works in a Worker" — but now
it's a single, cloud-agnostic name. AWS Lambda bindings use the
same `RuntimeContext`; Cloudflare Workers use the same
`RuntimeContext`; an in-memory test fake satisfies the same
`RuntimeContext`. Consumers don't have to write
`Effect<A, E, WorkerEnvironment | LambdaEnvironment | TestEnv>`
to be portable.

## The Layer pattern, now actually sealed

With both changes in place, the `JobService` Layer's inferred
type is what it always should have been:

```typescript
JobService.getJob: (id: string) => Effect.Effect<Job | null, never, RuntimeContext>
```

No `WorkerEnvironment`. No KV-specific error. Nothing about
Cloudflare. A consumer Worker can write:

```typescript
const jobs = yield* JobService;
const job = yield* jobs.getJob("job-1");
```

— and never learn that it's KV underneath. Swap the Layer for a
DynamoDB-backed implementation, the consumer's type is
unchanged. Swap it for an in-memory mock backed by `Map`, the
consumer's type is unchanged. That was the whole pitch for
Layers; it now actually holds at the type level.

The [Layers](/concepts/layers) doc walks through the
encapsulation pattern end-to-end against a Worker, and the new
[Building Infrastructure Layers](/guides/infrastructure-layers)
guide walks `JobService` from contract to provided Layer one
diff at a time. ([#386](https://github.com/alchemy-run/alchemy-effect/pull/386))

## Where to go next

- [Layers](/concepts/layers) — the encapsulation walkthrough
- [Building Infrastructure Layers](/guides/infrastructure-layers) — step-by-step guide
- [Binding](/concepts/binding) — what `.bind(...)` does under the hood
- [Phases](/concepts/phases) — init vs runtime, and where `RuntimeContext` is satisfied
- [#383 — move WorkerEnvironment requirement to the Layer](https://github.com/alchemy-run/alchemy-effect/pull/383)
- [#386 — refresh layers concept doc](https://github.com/alchemy-run/alchemy-effect/pull/386)
