import Stack from "@/Cloudflare/StateStore/Stack.ts";
import type { ResourceState } from "alchemy/State";
import { REDACTED_MARKER } from "alchemy/State";
import {
  afterAll,
  beforeAll,
  deploy,
  destroy,
  expect,
  test,
} from "alchemy/Test/Bun";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const stack = beforeAll(
  Effect.gen(function* () {
    const output = yield* deploy(Stack);
    const url = output.url as string;
    const authToken = output.authToken as string;
    yield* Effect.promise(() => waitForWorker(url, authToken));
    return { url, authToken };
  }),
  { timeout: 180_000 },
);

// Skip teardown with NO_DESTROY=1 for local iteration.
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 180_000 });

async function waitForWorker(url: string, token: string, maxRetries = 60) {
  // Probe an authenticated RPC path until it responds with JSON. The
  // Secrets Store bindings and Durable Object namespace may take a
  // moment to become consistent after deploy.
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`${url}/state/listStacks`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      const text = await res.text();
      if (res.status === 200 && text.startsWith("{")) {
        const json = JSON.parse(text);
        if (json?.ok) return;
      }
    } catch {
      // network / 521 / 522 — keep retrying
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Worker RPC path not warm after retries");
}

// -------------------------------------------------------------- helpers --

type Rpc =
  | "listStacks"
  | "listStages"
  | "list"
  | "get"
  | "set"
  | "delete"
  | "getReplacedResources";

async function rpc<T = unknown>(
  baseUrl: string,
  token: string,
  method: Rpc,
  body: Record<string, unknown> = {},
): Promise<{
  status: number;
  body: { ok: boolean; result?: T; error?: { code: string; message: string } };
}> {
  const res = await fetch(`${baseUrl}/state/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `Non-JSON response from ${method} (status ${res.status}): ${text.slice(0, 500)}`,
    );
  }
  if (res.status >= 500) {
    // Surface the server cause so failures are diagnosable instead of
    // swallowed by a retry loop.
    console.error(`[rpc ${method}] 5xx:`, json);
  }
  return { status: res.status, body: json };
}

/**
 * Build a valid `CreatedResourceState` for use in `set` tests. Every
 * field that `BaseResourceState` requires is populated so the object
 * round-trips correctly through JSON.
 */
const makeResource = (
  logicalId: string,
  overrides: Partial<ResourceState> = {},
): ResourceState =>
  ({
    resourceType: "Test.Resource",
    namespace: undefined,
    fqn: logicalId,
    logicalId,
    instanceId: `${logicalId}-instance`,
    providerVersion: 1,
    status: "created",
    downstream: [],
    bindings: [],
    props: { foo: "bar" },
    attr: { id: logicalId },
    ...overrides,
  }) as ResourceState;

// Use a unique stack name per test so tests don't interfere with each
// other (each stack gets its own Durable Object).
let stackCounter = 0;
const uniqueStack = () => `test-stack-${++stackCounter}-${Date.now()}`;

// ---------------------------------------------------------------- tests --

test(
  "rejects requests missing the bearer token with 401",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const res = yield* Effect.promise(() =>
      fetch(`${url}/state/listStacks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
    const body = (yield* Effect.promise(() => res.json())) as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("unauthorized");
  }),
);

test(
  "rejects requests with a wrong bearer token with 401",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const res = yield* Effect.promise(() =>
      fetch(`${url}/state/listStacks`, {
        method: "POST",
        headers: {
          Authorization: "Bearer not-the-real-token",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
  }),
);

test(
  "returns 404 for unknown routes",
  Effect.gen(function* () {
    const { url, authToken } = yield* stack;
    const res = yield* Effect.promise(() =>
      fetch(`${url}/does/not/exist`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(res.status).toBe(404);
  }),
);

test(
  "returns 404 for unknown RPC methods (router has no matching route)",
  Effect.gen(function* () {
    const { url, authToken } = yield* stack;
    const res = yield* Effect.promise(() =>
      rpc(url, authToken, "doesNotExist" as Rpc),
    );
    expect(res.status).toBe(404);
  }),
);

test(
  "set + get + delete round-trip for a single resource",
  Effect.gen(function* () {
    const { url, authToken } = yield* stack;
    const stackName = uniqueStack();
    const resource = makeResource("my-resource");

    // initial get -> null
    const g0 = yield* Effect.promise(() =>
      rpc<ResourceState | null>(url, authToken, "get", {
        stack: stackName,
        stage: "dev",
        fqn: "my-resource",
      }),
    );
    expect(g0.status).toBe(200);
    expect(g0.body.result).toBeNull();

    // set
    const s1 = yield* Effect.promise(() =>
      rpc<ResourceState>(url, authToken, "set", {
        stack: stackName,
        stage: "dev",
        fqn: "my-resource",
        value: resource,
      }),
    );
    expect(s1.status).toBe(200);
    expect(s1.body.result?.logicalId).toBe("my-resource");
    expect(s1.body.result?.resourceType).toBe("Test.Resource");

    // get -> the resource
    const g1 = yield* Effect.promise(() =>
      rpc<ResourceState | null>(url, authToken, "get", {
        stack: stackName,
        stage: "dev",
        fqn: "my-resource",
      }),
    );
    expect(g1.status).toBe(200);
    expect(g1.body.result?.logicalId).toBe("my-resource");
    expect((g1.body.result as any)?.props?.foo).toBe("bar");

    // delete
    const d1 = yield* Effect.promise(() =>
      rpc(url, authToken, "delete", {
        stack: stackName,
        stage: "dev",
        fqn: "my-resource",
      }),
    );
    expect(d1.status).toBe(200);
    expect(d1.body.result).toBeNull();

    // get again -> null
    const g2 = yield* Effect.promise(() =>
      rpc<ResourceState | null>(url, authToken, "get", {
        stack: stackName,
        stage: "dev",
        fqn: "my-resource",
      }),
    );
    expect(g2.status).toBe(200);
    expect(g2.body.result).toBeNull();
  }),
);

test(
  "delete is idempotent for missing keys",
  Effect.gen(function* () {
    const { url, authToken } = yield* stack;
    const res = yield* Effect.promise(() =>
      rpc(url, authToken, "delete", {
        stack: uniqueStack(),
        stage: "dev",
        fqn: "never-existed",
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  }),
);

test(
  "list returns FQNs for a given (stack, stage)",
  Effect.gen(function* () {
    const { url, authToken } = yield* stack;
    const stackName = uniqueStack();

    yield* Effect.promise(() =>
      rpc(url, authToken, "set", {
        stack: stackName,
        stage: "dev",
        fqn: "a",
        value: makeResource("a"),
      }),
    );
    yield* Effect.promise(() =>
      rpc(url, authToken, "set", {
        stack: stackName,
        stage: "dev",
        fqn: "parent/b",
        value: makeResource("b"),
      }),
    );
    // different stage should not appear
    yield* Effect.promise(() =>
      rpc(url, authToken, "set", {
        stack: stackName,
        stage: "prod",
        fqn: "c",
        value: makeResource("c"),
      }),
    );

    const res = yield* Effect.promise(() =>
      rpc<string[]>(url, authToken, "list", {
        stack: stackName,
        stage: "dev",
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body.result?.sort()).toEqual(["a", "parent/b"]);
  }),
);

test(
  "listStages returns stages for a stack; listStacks returns registered stacks",
  Effect.gen(function* () {
    const { url, authToken } = yield* stack;
    const alpha = uniqueStack();
    const beta = uniqueStack();

    yield* Effect.promise(() =>
      rpc(url, authToken, "set", {
        stack: alpha,
        stage: "dev",
        fqn: "r1",
        value: makeResource("r1"),
      }),
    );
    yield* Effect.promise(() =>
      rpc(url, authToken, "set", {
        stack: alpha,
        stage: "prod",
        fqn: "r2",
        value: makeResource("r2"),
      }),
    );
    yield* Effect.promise(() =>
      rpc(url, authToken, "set", {
        stack: beta,
        stage: "dev",
        fqn: "r3",
        value: makeResource("r3"),
      }),
    );

    const stacks = yield* Effect.promise(() =>
      rpc<string[]>(url, authToken, "listStacks"),
    );
    expect(stacks.status).toBe(200);
    // Other parallel tests may also register their own stacks, so
    // just assert our two are present.
    expect(stacks.body.result).toContain(alpha);
    expect(stacks.body.result).toContain(beta);

    const stagesAlpha = yield* Effect.promise(() =>
      rpc<string[]>(url, authToken, "listStages", { stack: alpha }),
    );
    expect(stagesAlpha.status).toBe(200);
    expect(stagesAlpha.body.result?.sort()).toEqual(["dev", "prod"]);

    const stagesBeta = yield* Effect.promise(() =>
      rpc<string[]>(url, authToken, "listStages", { stack: beta }),
    );
    expect(stagesBeta.body.result?.sort()).toEqual(["dev"]);

    const stagesMissing = yield* Effect.promise(() =>
      rpc<string[]>(url, authToken, "listStages", { stack: "not-a-stack" }),
    );
    expect(stagesMissing.body.result).toEqual([]);
  }),
);

test(
  "set on an existing key overwrites the value",
  Effect.gen(function* () {
    const { url, authToken } = yield* stack;
    const stackName = uniqueStack();

    yield* Effect.promise(() =>
      rpc(url, authToken, "set", {
        stack: stackName,
        stage: "e",
        fqn: "f",
        value: makeResource("f", { props: { v: 1 } as any }),
      }),
    );

    yield* Effect.promise(() =>
      rpc(url, authToken, "set", {
        stack: stackName,
        stage: "e",
        fqn: "f",
        value: makeResource("f", { props: { v: 2 } as any }),
      }),
    );

    const res = yield* Effect.promise(() =>
      rpc<ResourceState | null>(url, authToken, "get", {
        stack: stackName,
        stage: "e",
        fqn: "f",
      }),
    );
    expect((res.body.result as any)?.props?.v).toBe(2);
  }),
);

test(
  "getReplacedResources filters to status === 'replaced'",
  Effect.gen(function* () {
    const { url, authToken } = yield* stack;
    const stackName = uniqueStack();

    yield* Effect.promise(() =>
      rpc(url, authToken, "set", {
        stack: stackName,
        stage: "e",
        fqn: "created",
        value: makeResource("created", { status: "created" }),
      }),
    );
    yield* Effect.promise(() =>
      rpc(url, authToken, "set", {
        stack: stackName,
        stage: "e",
        fqn: "replaced-one",
        value: makeResource("replaced-one", {
          status: "replaced",
          deleteFirst: false,
          old: {
            status: "created",
            resourceType: "Test.Resource",
            namespace: undefined,
            fqn: "replaced-one",
            logicalId: "replaced-one",
            instanceId: "old-instance",
            providerVersion: 1,
            downstream: [],
            bindings: [],
            props: {},
            attr: {},
          },
        } as any),
      }),
    );
    yield* Effect.promise(() =>
      rpc(url, authToken, "set", {
        stack: stackName,
        stage: "e",
        fqn: "replaced-two",
        value: makeResource("replaced-two", {
          status: "replaced",
          deleteFirst: true,
          old: {
            status: "created",
            resourceType: "Test.Resource",
            namespace: undefined,
            fqn: "replaced-two",
            logicalId: "replaced-two",
            instanceId: "old-instance-2",
            providerVersion: 1,
            downstream: [],
            bindings: [],
            props: {},
            attr: {},
          },
        } as any),
      }),
    );

    const res = yield* Effect.promise(() =>
      rpc<ResourceState[]>(url, authToken, "getReplacedResources", {
        stack: stackName,
        stage: "e",
      }),
    );
    expect(res.status).toBe(200);
    const ids = (res.body.result ?? []).map((r) => r.logicalId).sort();
    expect(ids).toEqual(["replaced-one", "replaced-two"]);
  }),
);

test(
  "stacks are isolated from each other",
  Effect.gen(function* () {
    const { url, authToken } = yield* stack;
    const stackA = uniqueStack();
    const stackB = uniqueStack();

    yield* Effect.promise(() =>
      rpc(url, authToken, "set", {
        stack: stackA,
        stage: "e",
        fqn: "only-in-a",
        value: makeResource("only-in-a"),
      }),
    );

    const listA = yield* Effect.promise(() =>
      rpc<string[]>(url, authToken, "list", { stack: stackA, stage: "e" }),
    );
    const listB = yield* Effect.promise(() =>
      rpc<string[]>(url, authToken, "list", { stack: stackB, stage: "e" }),
    );
    expect(listA.body.result).toEqual(["only-in-a"]);
    expect(listB.body.result).toEqual([]);

    const getFromB = yield* Effect.promise(() =>
      rpc<ResourceState | null>(url, authToken, "get", {
        stack: stackB,
        stage: "e",
        fqn: "only-in-a",
      }),
    );
    expect(getFromB.body.result).toBeNull();
  }),
);

test(
  "missing required params on set returns 400",
  Effect.gen(function* () {
    const { url, authToken } = yield* stack;
    const res = yield* Effect.promise(() =>
      rpc(url, authToken, "set", {
        stack: uniqueStack(),
        stage: "e",
        // fqn missing
        value: makeResource("x"),
      } as any),
    );
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("bad_request");
  }),
);

test(
  "FQNs containing slashes survive a set/get round-trip",
  Effect.gen(function* () {
    const { url, authToken } = yield* stack;
    const stackName = uniqueStack();
    const fqn = "Parent/Child/Grandchild";

    yield* Effect.promise(() =>
      rpc(url, authToken, "set", {
        stack: stackName,
        stage: "e",
        fqn,
        value: makeResource("Grandchild", { fqn }),
      }),
    );

    const got = yield* Effect.promise(() =>
      rpc<ResourceState | null>(url, authToken, "get", {
        stack: stackName,
        stage: "e",
        fqn,
      }),
    );
    expect(got.body.result?.fqn).toBe(fqn);

    const listed = yield* Effect.promise(() =>
      rpc<string[]>(url, authToken, "list", { stack: stackName, stage: "e" }),
    );
    expect(listed.body.result).toEqual([fqn]);
  }),
);

test(
  "Redacted values survive a set/get round-trip via the REDACTED_MARKER envelope",
  Effect.gen(function* () {
    const { url, authToken } = yield* stack;
    const stackName = uniqueStack();
    const secretValue = "super-secret-value-42";

    // On the wire, Redacted<T> is encoded as { [REDACTED_MARKER]: value }
    // — the same envelope LocalState uses. The server-side DO does the
    // same encoding before encryption, so the round-trip should bring
    // the envelope back identically.
    yield* Effect.promise(() =>
      rpc(url, authToken, "set", {
        stack: stackName,
        stage: "e",
        fqn: "has-secret",
        value: makeResource("has-secret", {
          props: {
            apiKey: { [REDACTED_MARKER]: secretValue },
            nested: {
              deeplyRedacted: { [REDACTED_MARKER]: "nested-secret" },
            },
          } as any,
        }),
      }),
    );

    const got = yield* Effect.promise(() =>
      rpc<ResourceState | null>(url, authToken, "get", {
        stack: stackName,
        stage: "e",
        fqn: "has-secret",
      }),
    );
    expect(got.status).toBe(200);
    const props = (got.body.result as any)?.props;
    expect(props?.apiKey?.[REDACTED_MARKER]).toBe(secretValue);
    expect(props?.nested?.deeplyRedacted?.[REDACTED_MARKER]).toBe(
      "nested-secret",
    );

    // Sanity: the exact shape is what `reviveState` on the client
    // would turn back into a `Redacted<string>` — confirm.
    const revived = Redacted.make(props.apiKey[REDACTED_MARKER]);
    expect(Redacted.value(revived)).toBe(secretValue);
  }),
);
