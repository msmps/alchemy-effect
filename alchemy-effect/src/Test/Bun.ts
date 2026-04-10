import { BunServices } from "@effect/platform-bun";
import * as bun from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Scope } from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import { apply } from "../Apply.ts";
import { provideFreshArtifactStore } from "../Artifacts.ts";
import * as Plan from "../Plan.ts";
import type { CompiledStack, StackServices } from "../Stack.ts";
import { Stage } from "../Stage.ts";
import * as State from "../State/index.ts";
import { TestCli } from "./TestCli.ts";

export type ProvidedServies =
  | Scope
  | BunServices.BunServices
  | HttpClient
  | StackServices;

export type TestEffect<T, Err = any, Req = never> = Effect.Effect<
  T,
  Err,
  Req | ProvidedServies
>;

const sharedState = State.InMemoryService({});

const testRuntime = Layer.mergeAll(
  BunServices.layer,
  FetchHttpClient.layer,
  Layer.succeed(State.State, sharedState),
  Layer.succeed(Stage, "test"),
  TestCli,
);

const run = <A, Err, Req>(fn: TestEffect<A, Err, Req>) =>
  Effect.runPromise(
    fn.pipe(Effect.provide(testRuntime), Effect.scoped) as Effect.Effect<
      A,
      Err,
      never
    >,
  );

export function test<Err = any, Req = never>(
  name: string,
  fn: TestEffect<void, Err, Req>,
  options?: bun.TestOptions,
) {
  return bun.test(name, () => run(fn), options);
}

export function beforeAll<A, Err = any, Req = never>(
  fn: TestEffect<A, Err, Req>,
) {
  let cached: Promise<A> | undefined;
  bun.beforeAll(() => (cached ??= run(fn)));
  return Effect.promise(() => (cached ??= run(fn)));
}

export function afterAll<Err = any, Req = never>(
  fn: TestEffect<void, Err, Req>,
) {
  return bun.afterAll(() => run(fn));
}

export function beforeEach<Err = any, Req = never>(
  fn: TestEffect<void, Err, Req>,
) {
  return bun.beforeEach(() => run(fn));
}

export function afterEach<Err = any, Req = never>(
  fn: TestEffect<void, Err, Req>,
) {
  return bun.afterEach(() => run(fn));
}

export function describe<Err = any, Req = never>(
  name: string,
  fn: TestEffect<void, Err, Req>,
) {
  return bun.describe(name, () => run(fn));
}

export function it<Err = any, Req = never>(
  name: string,
  fn: TestEffect<void, Err, Req>,
) {
  return bun.it(name, () => run(fn));
}

export function expect(value: any) {
  return bun.expect(value);
}

export function deploy<A, Err = never, Req = never>(
  stackEffect: Effect.Effect<CompiledStack<A, Req>, Err, ProvidedServies>,
) {
  return Effect.gen(function* () {
    const stack = yield* stackEffect;
    return yield* Plan.make(stack).pipe(
      Effect.flatMap(apply),
      Effect.provide(stack.services),
      provideFreshArtifactStore,
    );
  });
}

export function destroy<Err = never, Req = never>(
  stackEffect: Effect.Effect<any, Err, Req>,
) {
  return Effect.gen(function* () {
    const stack = yield* stackEffect;
    yield* Plan.make({
      ...stack,
      resources: {},
      bindings: {},
      output: {},
    }).pipe(
      Effect.flatMap(apply),
      Effect.provide(stack.services),
      provideFreshArtifactStore,
    );
  });
}
