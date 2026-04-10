import {
  afterAll,
  beforeAll,
  deploy,
  destroy,
  expect,
  test,
} from "alchemy-effect/Test/Bun";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";

import Stack from "../alchemy.run.ts";

const stack = beforeAll(deploy(Stack));

afterAll(destroy(Stack));

test(
  "integ",
  Effect.gen(function* () {
    const { url } = yield* stack;

    expect(url).toBeString();

    const response = yield* HttpClient.get(url);

    const text = yield* response.text;
  }),
);
