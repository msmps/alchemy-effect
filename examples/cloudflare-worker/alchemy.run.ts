import { Cloudflare, Stack } from "alchemy-effect";
import * as Effect from "effect/Effect";

import Api from "./src/Api.ts";

const stack = Effect.gen(function* () {
  const api = yield* Api;
  // const sandbox = yield* Sandbox;

  return {
    url: api.url.as<string>(),
  };
}).pipe(Stack.make("CloudflareWorker", Cloudflare.providers()));

export default stack;
