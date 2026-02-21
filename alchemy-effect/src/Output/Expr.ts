import type { Yieldable } from "effect/Effect";
import * as Effect from "effect/Effect";
import type { ResourceLike } from "../Resource.ts";
import type { Output, Value } from "./Output.ts";

export const ExprSymbol = Symbol.for("alchemy/Expr");

export type ObjectExpr<A, Src extends ResourceLike, Req = any> = Output<
  A,
  Src,
  Req
> & {
  [Prop in keyof Exclude<A, undefined>]-?: Output.Of<
    Exclude<A, undefined>[Prop] | Extract<A, undefined>,
    Src,
    Req
  >;
};

export type ArrayExpr<
  A extends any[],
  Src extends ResourceLike,
  Req = any,
> = Output<A, Src, Req> & {
  [i in Extract<keyof A, number>]: Output.Of<A[i], Src, Req>;
};

export const isExpr = (value: any): value is Expr<any> =>
  value &&
  (typeof value === "object" || typeof value === "function") &&
  ExprSymbol in value;

export type Expr<A = any, Src extends ResourceLike = ResourceLike, Req = any> =
  | AllExpr<Expr<A, Src, Req>[]>
  | ApplyExpr<any, A, Src, Req>
  | EffectExpr<any, A, Src, Req>
  | LiteralExpr<A>
  | PropExpr<A, keyof A, Src, Req>
  | ResourceExpr<A, Src, Req>
  | RefExpr<A>;

const proxy = (self: any): any => {
  const proxy = new Proxy(
    Object.assign(() => {}, self),
    {
      has: (_, prop) => (prop === ExprSymbol ? true : prop in self),
      get: (_, prop) =>
        prop === Symbol.toPrimitive
          ? (hint: string) => (hint === "string" ? self.toString() : self)
          : prop === ExprSymbol
            ? self
            : isResourceExpr(self) && self.stables && prop in self.stables
              ? self.stables[prop as keyof typeof self.stables]
              : prop === "apply"
                ? self[prop]
                : prop in self
                  ? typeof self[prop as keyof typeof self] === "function" &&
                    !("kind" in self)
                    ? new PropExpr(proxy, prop as never)
                    : self[prop as keyof typeof self]
                  : new PropExpr(proxy, prop as never),
      apply: (_, thisArg, args) => {
        if (isPropExpr(self)) {
          if (self.identifier === "apply") {
            return new ApplyExpr(self.expr, args[0]);
          } else if (self.identifier === "effect") {
            return new EffectExpr(self.expr, args[0]);
          }
        }
        return undefined;
      },
    },
  );
  return proxy;
};

// @ts-expect-error
export abstract class BaseExpr<
  A = any,
  Src extends ResourceLike = any,
  Req = any,
> implements Output<A, Src, Req> {
  declare readonly kind: any;
  declare readonly src: Src;
  declare readonly req: Req;
  // we use a kind tag instead of instanceof to protect ourselves from duplicate alchemy-effect module imports
  constructor() {}

  [Symbol.iterator](): Iterator<
    Yieldable<any, void, never, this>,
    Value<A, Src>,
    void
  > {
    throw new Error("Method not implemented.");
  }
  public apply<B>(fn: (value: A) => B): Output.Of<B, Src> {
    return new ApplyExpr(this as Expr<A, Src, Req>, fn) as any;
  }
  public effect<B, Req2>(
    fn: (value: A) => Effect.Effect<B, never, Req2>,
  ): Output.Of<B, Src, Req | Req2> {
    return new EffectExpr(this as any, fn) as any;
  }
  public pipe(...fns: any[]): any {
    // @ts-expect-error
    return pipe(this, ...fns);
  }
  toString(): string {
    return JSON.stringify(this, null, 2);
  }
}

export const isResourceExpr = <
  Value = any,
  Src extends ResourceLike = ResourceLike,
  Req = any,
>(
  node: Expr<Value, Src, Req> | any,
): node is ResourceExpr<Value, Src, Req> => node?.kind === "ResourceExpr";

export class ResourceExpr<
  Value,
  Src extends ResourceLike,
  Req = never,
> extends BaseExpr<Value, Src, Req> {
  readonly kind = "ResourceExpr";
  constructor(
    public readonly src: Src,
    readonly stables?: Record<string, any>,
  ) {
    super();
    return proxy(this);
  }
}

export const isPropExpr = <
  A = any,
  Prop extends keyof A = keyof A,
  Src extends ResourceLike = ResourceLike,
  Req = any,
>(
  node: any,
): node is PropExpr<A, Prop, Src, Req> => node?.kind === "PropExpr";

export class PropExpr<
  A = any,
  Id extends keyof A = keyof A,
  Src extends ResourceLike = ResourceLike,
  Req = any,
> extends BaseExpr<A[Id], Src, Req> {
  readonly kind = "PropExpr";
  constructor(
    public readonly expr: Expr<A, Src, Req>,
    public readonly identifier: Id,
  ) {
    super();
    return proxy(this);
  }
}

export const literal = <A>(value: A) => new LiteralExpr(value);

export const isLiteralExpr = <A = any>(node: any): node is LiteralExpr<A> =>
  node?.kind === "LiteralExpr";

export class LiteralExpr<A> extends BaseExpr<A, never> {
  readonly kind = "LiteralExpr";
  constructor(public readonly value: A) {
    super();
    return proxy(this);
  }
}

//Output.ApplyExpr<any, any, ResourceLike, any>
export const isApplyExpr = <
  In = any,
  Out = any,
  Src extends ResourceLike = ResourceLike,
  Req = any,
>(
  node: Output<Out, Src, Req>,
): node is ApplyExpr<In, Out, Src, Req> => node?.kind === "ApplyExpr";

export class ApplyExpr<
  A,
  B,
  Src extends ResourceLike,
  Req = never,
> extends BaseExpr<B, Src, Req> {
  readonly kind = "ApplyExpr";
  constructor(
    public readonly expr: Expr<A, Src, Req>,
    public readonly f: (value: A) => B,
  ) {
    super();
    return proxy(this);
  }
}

export const isEffectExpr = <
  In = any,
  Out = any,
  Src extends ResourceLike = ResourceLike,
  Req = any,
  Req2 = any,
>(
  node: any,
): node is EffectExpr<In, Out, Src, Req, Req2> => node?.kind === "EffectExpr";

export class EffectExpr<
  A,
  B,
  Src extends ResourceLike,
  Req = never,
  Req2 = never,
> extends BaseExpr<B, Src, Req> {
  readonly kind = "EffectExpr";
  constructor(
    public readonly expr: Expr<A, Src, Req>,
    public readonly f: (value: A) => Effect.Effect<B, never, Req2>,
  ) {
    super();
    return proxy(this);
  }
}

export const isAllExpr = <Outs extends Expr[] = Expr[]>(
  node: any,
): node is AllExpr<Outs> => node?.kind === "AllExpr";

export class AllExpr<Outs extends Expr[]> extends BaseExpr<Outs> {
  readonly kind = "AllExpr";
  constructor(public readonly outs: Outs) {
    super();
    return proxy(this);
  }
}

export const isRefExpr = <A = any>(node: any): node is RefExpr<A> =>
  node?.kind === "RefExpr";

export class RefExpr<A> extends BaseExpr<A, never, never> {
  readonly kind = "RefExpr";
  constructor(
    public readonly stack: string | undefined,
    public readonly stage: string | undefined,
    public readonly resourceId: string,
  ) {
    super();
    return proxy(this);
  }
}
