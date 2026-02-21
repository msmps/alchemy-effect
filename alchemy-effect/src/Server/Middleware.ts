import type { unhandled } from "@effect/platform/HttpLayerRouter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { Trait, TraitDef } from "../Trait.ts";
import type { ProtocolClass, ProtocolShape } from "./Protocol.ts";

export interface MiddlewareClass<
  P extends ProtocolShape,
  T extends Trait,
  Response extends any,
  Err = never,
  Req = never,
  ProvidedReq = never,
> extends ServiceMap.ServiceClass<
  MiddlewareClass<P, T, Err, Req>,
  `${T["tag"]}:${P["Id"]}:Middleware`,
  {
    fn: (
      // TODO: can we make this typed/]?
      input: any,
      trait: T,
      next: Effect.Effect<Response, unhandled, Req>,
    ) => Effect.Effect<Response, unhandled | Err, Exclude<Req, ProvidedReq>>;
  }
> {}

export const Middleware =
  <P extends ProtocolClass, T extends TraitDef>(protocol: P, trait: T) =>
  <Response, Err = never, Req = never, ProvidedReq = never>() =>
    Context.Tag(
      `${trait["tag"]}:${protocol}:Middleware`,
    ) as any as MiddlewareClass<
      InstanceType<P>,
      T,
      Response,
      Err,
      Req,
      ProvidedReq
    >;
