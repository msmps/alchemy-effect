import type { Yieldable } from "effect/Effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";
import type { ResourceClass, ResourceLike } from "./Resource.ts";

export type BindingFn = (
  resource: any,
  props?: any,
) => Effect.Effect<(request?: any) => Effect.Effect<any, any, any>, any, any>;

export interface BindingLike<
  Tag extends string = string,
  Fn extends BindingFn = BindingFn,
> {
  tag: Tag;
  fn: Fn;
}

export type Binding<
  Tag extends string = string,
  Fn extends BindingFn = BindingFn,
> = Fn & {
  tag: Tag;
  fn: Fn;
  from: <Res extends ResourceClass<(...args: any) => any>>(
    resource: Res,
    impl: (
      target: ResourceClass.Instance<Res>,
      source: Binding.Source<Fn>,
    ) => Effect.Effect<Res, never, never>,
  ) => Layer.Layer<[from: Res, to: Binding<Tag>], never, any>;
};

export declare namespace Binding {
  export type Source<B extends BindingFn> = Parameters<B>[0];
  export type Props<B extends BindingFn> = Parameters<B>[1];
}

export const fn: {
  <
    R extends ResourceLike,
    Eff extends Yieldable<any, any, any, any>,
    AEff,
    Args extends Array<any>,
  >(
    resource: R,
    body: (...args: Args) => Generator<Eff, AEff, never>,
  ): Effect.Effect<
    (...args: Args) => Effect.Effect<
      AEff,
      [Eff] extends [never]
        ? never
        : [Eff] extends [Yieldable<any, infer _A, infer E, infer _R>]
          ? E
          : never,
      // Requirements of the underlying Effect are hoisted to the policy
      never
    >,
    never,
    // hoist requirementes to the outer effect:
    [Eff] extends [never]
      ? never
      : [Eff] extends [Yieldable<any, infer _A, infer _E, infer R>]
        ? R
        : never
  >;
} = Effect.fn(function* (
  ...args:
    | [resource: ResourceLike, fn: any]
    | [resource: ResourceLike, props: any, fn: any]
) {
  const [resource, props, fn] =
    args.length === 2
      ? [args[0], undefined, args[1]]
      : [args[0], args[1], args[2]];
  // TODO(sam): we need a Scope like Effect.scoped to attach bindings to
  yield* bind(resource, props);
  return Effect.fn(fn);
});

export const make = <Tag extends string, Fn extends BindingFn>(
  tag: Tag,
  fn: Fn,
): Binding<Tag, Fn> =>
  Object.assign(
    (resource: any, props: any) => ({
      tag,
      resource,
      props,
    }),
    {
      tag,
      fn,
      from<B extends Binding, R extends ResourceClass>(this: B, resource: R) {
        return BindingService(resource, this);
      },
    },
  ) as any;

/** Function that runs for a Binding at infrastructure planning time */
export type BindingPlanFn<R extends ResourceClass, B extends BindingLike> = (
  resource: ResourceClass.Instance<R>,
  binding: Binding.Source<B["fn"]>,
  props: Binding.Props<B["fn"]>,
) => Effect.Effect<any, any, any>;

export const effect = <R extends ResourceClass, B extends BindingLike>(
  [resource, binding]: [R, B],
  impl: NoInfer<BindingPlanFn<R, B>>,
): Layer.Layer<[R, B]> =>
  Layer.succeed(BindingService(resource, binding), impl);

export const BindingService = <R extends ResourceClass, B extends Binding>(
  resource: ResourceClass,
  binding: B,
) =>
  ServiceMap.Service<[R, B], BindingPlanFn<R, B>>()(
    `${resource.type}:${binding.tag}`,
  );
