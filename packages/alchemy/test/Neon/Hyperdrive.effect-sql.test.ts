import * as Cloudflare from "@/Cloudflare";
import * as Neon from "@/Neon";
import * as Test from "@/Test/Vitest";
import { describe, expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import HyperdriveWorker, {
  type Widget,
} from "./fixtures/hyperdrive-effect-sql/worker.ts";
import { Hyperdrive, NeonDb } from "./fixtures/Stack.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Neon.providers()),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {}

describe.skipIf(!process.env.NEON_TEST)(() => {
  /**
   * End-to-end: deploy a {@link Neon.Project} + branch, point a
   * {@link Cloudflare.Hyperdrive} at the branch's origin, and exercise
   * `@effect/sql-pg` over real Postgres via a Worker.
   */
  test.provider(
    "Neon.Branch + Hyperdrive + @effect/sql-pg round-trips through a Worker",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const { worker } = yield* stack.deploy(
          Effect.gen(function* () {
            yield* NeonDb;
            yield* Hyperdrive;
            const worker = yield* HyperdriveWorker;
            return { worker };
          }),
        );

        expect(worker.url).toBeTypeOf("string");
        const baseUrl = (worker.url as string).replace(/\/+$/, "");

        const initial = yield* HttpClient.get(`${baseUrl}/widgets`).pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? res.text.pipe(Effect.as(res))
              : res.text.pipe(
                  Effect.flatMap((body) =>
                    Effect.fail(
                      new WorkerNotReady({ status: res.status, body }),
                    ),
                  ),
                ),
          ),
          Effect.retry({
            while: (e): e is WorkerNotReady =>
              e instanceof WorkerNotReady && e.status >= 400 && e.status < 600,
            schedule: Schedule.exponential("500 millis").pipe(
              Schedule.both(Schedule.recurs(20)),
            ),
          }),
        );
        expect(initial.status).toBe(200);
        const initialBody = (yield* initial.json) as { widgets: Widget[] };
        expect(Array.isArray(initialBody.widgets)).toBe(true);

        const insertRes = yield* HttpClient.execute(
          HttpClientRequest.post(`${baseUrl}/widgets`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ id: 1, name: "alpha" }),
          ),
        );
        expect(insertRes.status).toBe(200);
        const insertBody = (yield* insertRes.json) as { widget: Widget };
        expect(insertBody.widget).toMatchObject({ id: 1, name: "alpha" });

        const after = yield* HttpClient.get(`${baseUrl}/widgets`);
        expect(after.status).toBe(200);
        const afterBody = (yield* after.json) as { widgets: Widget[] };
        expect(afterBody.widgets.some((w) => w.id === 1)).toBe(true);

        const deleteRes = yield* HttpClient.execute(
          HttpClientRequest.delete(`${baseUrl}/widgets/1`),
        );
        expect(deleteRes.status).toBe(200);

        const final = yield* HttpClient.get(`${baseUrl}/widgets`);
        const finalBody = (yield* final.json) as { widgets: Widget[] };
        expect(finalBody.widgets.some((w) => w.id === 1)).toBe(false);

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 600_000 },
  );
});
