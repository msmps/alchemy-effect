import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";
import { App } from "../App.ts";

export class Endpoint extends ServiceMap.Service<
  Endpoint,
  EndpointID | undefined
>()("AWS::Endpoint") {}

export type EndpointID = string;

export const of = (endpoint: string) => Layer.succeed(Endpoint, endpoint);

export const fromStageConfig = () =>
  Layer.effect(
    Endpoint,
    Effect.gen(function* () {
      const app = yield* App;
      return app.config.aws?.endpoint;
    }),
  );
