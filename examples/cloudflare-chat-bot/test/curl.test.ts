import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "raw curl",
  Effect.gen(function* () {
    const { apiUrl } = yield* stack;
    console.log("apiUrl:", apiUrl);
    const res = yield* Effect.promise(() =>
      fetch(apiUrl.replace(/\/+$/, ""), {
        method: "POST",
        headers: { "content-type": "application/x-ndjson" },
        body:
          JSON.stringify({
            _tag: "Request",
            id: "1",
            tag: "getMessages",
            payload: { id: "x", threadId: "y" },
            traceId: "00000000000000000000000000000000",
            spanId: "0000000000000000",
            sampled: false,
            headers: {},
          }) + "\n",
      }),
    );
    console.log("status:", res.status);
    console.log("content-type:", res.headers.get("content-type"));
    const text = yield* Effect.promise(() => res.text());
    console.log("body:", text.slice(0, 1000));
    expect(res.status).toBeLessThan(600);
  }),
  { timeout: 60_000 },
);
