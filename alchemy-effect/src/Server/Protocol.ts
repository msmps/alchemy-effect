import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

// TODO: what is the scope of a Protocol? Serialization + Transport? E.g. EC2Query over HTTP
export interface Protocol {
  // TODO: better types for this
  serialize: (input: any) => Effect.Effect<string, never, any>;
  deserialize: (input: string) => Effect.Effect<any, never, any>;
}

export const Protocol =
  <Tag extends string>(tag: Tag) =>
  <Self>(): ProtocolClass<Self, Tag> =>
    Context.Tag(tag)<Self, Protocol>();

export type ProtocolClass<
  Self = any,
  Tag extends string = string,
> = ServiceMap.ServiceClass<Self, Tag, Protocol>;

export interface ProtocolShape<
  Tag extends string = string,
> extends ServiceMap.ServiceClassShape<Tag, Protocol> {}
