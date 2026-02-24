import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Credentials } from "distilled-aws/Credentials";
import { Region } from "distilled-aws/Region";
import { HttpClient } from "effect/unstable/http/HttpClient";

export const withContext = Effect.fn(function* <
  Input,
  A,
  Err = never,
  Req = never,
>(fn: (request: Input) => Effect.Effect<A, Err, Req>) {
  const credentials = yield* Credentials;
  const region = yield* Region;
  const httpClient = yield* HttpClient;
  return (
    request: Input,
  ): Effect.Effect<A, Err, Exclude<Req, Credentials | Region | HttpClient>> =>
    fn(request).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Credentials, credentials),
          Layer.succeed(Region, region),
          Layer.succeed(HttpClient, httpClient),
        ),
      ),
    );
});
