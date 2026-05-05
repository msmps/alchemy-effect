import * as AWS from "@/AWS";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const main = import.meta.filename;

/**
 * Bare-bones Lambda fixture used by the lifecycle convergence tests.
 *
 * The tests vary `functionName`, `url`, `env`, `vpc`, etc. via the
 * `LifecycleFunction(...)` props at deploy time — this file just supplies
 * a reusable bundleable handler so the convergence tests can be expressed
 * as plain prop diffs.
 */
export class LifecycleFunction extends AWS.Lambda.Function<LifecycleFunction>()(
  "LifecycleFunction",
  { main, url: false },
) {}

export const LifecycleFunctionLive = LifecycleFunction.make(
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text("ok");
      }),
    };
  }),
);

export default LifecycleFunctionLive;
