import * as Effect from "effect/Effect";
import type { Pipeable } from "effect/Pipeable";
import * as ServiceMap from "effect/ServiceMap";
import * as Types from "effect/Types";

export const ConstructTypeId = "alchemy/Construct";

/**
 * @since 2.0.0
 * @category models
 */
export interface Construct<in ROut, out E = never, out RIn = never>
  extends Construct.Variance<ROut, E, RIn>, Pipeable {}

/**
 * @since 2.0.0
 */
export declare namespace Construct {
  /**
   * @since 2.0.0
   * @category models
   */
  export interface Variance<in ROut, out E, out RIn> {
    readonly [ConstructTypeId]: {
      readonly _ROut: Types.Contravariant<ROut>;
      readonly _E: Types.Covariant<E>;
      readonly _RIn: Types.Covariant<RIn>;
    };
  }
  /**
   * @since 3.9.0
   * @category type-level
   */
  export interface Any {
    readonly [ConstructTypeId]: {
      readonly _ROut: Types.Contravariant<never>;
      readonly _E: Types.Covariant<any>;
      readonly _RIn: Types.Covariant<any>;
    };
  }
  /**
   * @since 2.0.0
   * @category type-level
   */
  export type Context<T extends Any> = [T] extends [
    Construct<infer _ROut, infer _E, infer _RIn>,
  ]
    ? _RIn
    : never;
  /**
   * @since 2.0.0
   * @category type-level
   */
  export type Error<T extends Any> = [T] extends [
    Construct<infer _ROut, infer _E, infer _RIn>,
  ]
    ? _E
    : never;
  /**
   * @since 2.0.0
   * @category type-level
   */
  export type Success<T extends Any> = [T] extends [
    Construct<infer _ROut, infer _E, infer _RIn>,
  ]
    ? _ROut
    : never;
}

export const effect: {
  <I, S>(
    tag: ServiceMap.Service<I, S>,
  ): <E, R>(
    effect: Effect.Effect<Types.NoInfer<S>, E, R>,
  ) => Construct<I, E, R>;
  <I, S, E, R>(
    tag: ServiceMap.Service<I, S>,
    effect: Effect.Effect<Types.NoInfer<S>, E, R>,
  ): Construct<I, E, R>;
} = undefined!;
