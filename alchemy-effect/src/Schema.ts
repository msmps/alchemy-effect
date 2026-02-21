import type { Effect } from "effect/Effect";
import * as S from "effect/Schema";
import type { AST } from "effect/SchemaAST";
import type { Sink } from "effect/Sink";
import type { Stream } from "effect/Stream";

export * from "effect/Schema";

const Description = Symbol.for("effect/annotation/Description");

export const isTag = <T extends S.Schema<any>>(tag: T["ast"]["_tag"]) =>
  ((schema) =>
    S.isSchema(schema)
      ? S.encodedSchema(schema).ast._tag === tag
      : schema._tag === tag) as {
    (schema: S.Schema<any>): schema is T;
    (schema: AST): boolean;
  };

export const hasGenericAnnotation =
  (type: string) => (ast: AST | undefined) => {
    const description: string | undefined = ast?.annotations?.[
      Description
    ] as string;
    return (
      description &&
      description?.startsWith(`${type}<`) &&
      description?.endsWith(">")
    );
  };

export const isNullishSchema = (schema: S.Schema<any>) =>
  isNullSchema(schema) || isUndefinedSchema(schema);
export const isNullSchema = (schema: S.Schema<any>) =>
  schema.ast._tag === "Literal" && schema.ast.literal === null;
export const isUndefinedSchema = isTag("UndefinedKeyword");
export const isBooleanSchema = isTag<S.Schema<boolean>>("BooleanKeyword");
export const isStringSchema = isTag<S.Schema<string>>("StringKeyword");
export const isNumberSchema = isTag<S.Schema<number>>("NumberKeyword");

export const hasMapAnnotation = hasGenericAnnotation("Map");

export const isRecordLikeSchema = (schema: S.Schema<any>) =>
  isMapSchema(schema) ||
  isRecordSchema(schema) ||
  isStructSchema(schema) ||
  isClassSchema(schema) ||
  false;

export const isMapSchema = (schema: S.Schema<any>) =>
  hasMapAnnotation(schema.ast) ||
  // @ts-expect-error - ast.to?. is not narrowed, we don't care
  hasMapAnnotation(schema.ast.to) ||
  false;

export const isClassSchema = (schema: S.Schema<any>) => {
  const encoded = S.encodedSchema(schema);
  return (
    encoded.ast._tag === "TypeLiteral" &&
    encoded.ast.propertySignatures !== undefined
  );
};

export const isStructSchema = (schema: S.Schema<any>) => {
  return (
    schema.ast._tag === "TypeLiteral" &&
    schema.ast.propertySignatures !== undefined
  );
};

export const isRecordSchema = (schema: S.Schema<any>) => {
  const encoded = S.encodedSchema(schema);
  return (
    encoded.ast._tag === "TypeLiteral" &&
    encoded.ast.indexSignatures?.[0] !== undefined
  );
};

export const isListSchema = (schema: S.Schema<any>) => {
  return (
    hasListAnnotation(schema.ast) ||
    (S.encodedSchema(schema).ast._tag === "TupleType" && !isMapSchema(schema))
  );
};
export const hasListAnnotation = (ast: AST | undefined) => {
  const description: string | undefined = ast?.annotations?.[
    Description
  ] as string;
  return (
    description &&
    description?.startsWith("List<") &&
    description?.endsWith(">")
  );
};

export const isSetSchema = (schema: S.Schema<any>) => {
  return (
    // @ts-expect-error - ast.to?. is not narrowed, we don't care
    hasSetAnnotation(schema.ast) || hasSetAnnotation(schema.ast.to) || false
  );
};

export const hasSetAnnotation = hasGenericAnnotation("Set");

export const getSetValueAST = (schema: S.Schema<any>): AST =>
  // @ts-expect-error - ast.to?. is not narrowed, we don't care
  isSetSchema(schema) && schema.ast.to?.typeParameters[0];

/** A Schema representing a Schema */
export type Field = S.Struct.Field; // needs to be a Field to support S.optional(..)
export const Field = S.suspend(
  (): [Field] extends [any] ? S.Schema<Field> : never => S.Any,
);

type FunctionType = (...args: any[]) => any;
export type Function<F extends FunctionType = FunctionType> = S.Schema<F>;
export const Function: <F extends FunctionType>() => Function<F> = S.suspend(
  (): S.Schema<FunctionType> => S.Any,
) as any;

export type CreatedAt = Date;
export const CreatedAt = S.Date.annotate({
  description: "The timestamp of when this record was created",
});

export type UpdatedAt = Date;
export const UpdatedAt = S.Date.annotate({
  description: "The timestamp of when this record was last updated",
});

export type AnyClassSchema<
  Self = any,
  Fields extends S.Struct.Fields = S.Struct.Fields,
> = S.Class<Self, Fields, any, any, any, any, any>;

export type AnyClass = new (...args: any[]) => any;

export type AnyErrorSchema = S.TaggedErrorClass<any, any, any>;

export type SchemaWithTemplate<
  Schema extends S.Schema<any>,
  References extends any[] = any[],
> = Schema & {
  template: TemplateStringsArray;
  references: References;
};

export type SchemaExt =
  | FunctionSchema
  | EffectSchema
  | StreamSchema
  | SinkSchema;

export interface SchemaExtBase<A> extends S.Schema<A> {
  <References extends any[]>(
    template: TemplateStringsArray,
    ...references: References
  ): SchemaWithTemplate<this, References>;
}

export interface FunctionSchema<
  Input extends S.Schema.All | undefined = S.Schema.All | undefined,
  Output extends S.Schema.All = S.Schema.All,
> extends SchemaExtBase<
  (
    ...args: Input extends undefined ? [] : [input: S.Schema.Type<Input>]
  ) => S.Schema.Type<Output>
> {
  input: Input;
  output: Output;
}

export interface EffectSchema<
  A extends S.Schema.All = S.Schema.All,
  Err extends S.Schema.All = S.Schema.All,
  Req extends S.Schema.All = S.Schema.All,
> extends SchemaExtBase<
  Effect<S.Schema.Type<A>, S.Schema.Type<Err>, S.Schema.Type<Req>>
> {
  A: A;
  Err: Err;
  Req: Req;
}

export interface StreamSchema<
  A extends S.Schema.All = S.Schema.All,
  Err extends S.Schema.All = S.Schema.All,
  Req extends S.Schema.All = S.Schema.All,
> extends SchemaExtBase<
  Stream<S.Schema.Type<A>, S.Schema.Type<Err>, S.Schema.Type<Req>>
> {
  A: A;
  Err: Err;
  Req: Req;
}

export interface SinkSchema<
  A extends S.Schema.All = S.Schema.All,
  In extends S.Schema.All = S.Schema.All,
  L extends S.Schema.All = S.Schema.All,
  Err extends S.Schema.All = S.Schema.All,
  Req extends S.Schema.All = S.Schema.All,
> extends SchemaExtBase<
  Sink<
    S.Schema.Type<A>,
    S.Schema.Type<In>,
    S.Schema.Type<L>,
    S.Schema.Type<Err>,
    S.Schema.Type<Req>
  >
> {
  A: A;
  In: In;
  L: L;
  Err: Err;
  Req: Req;
}

export const makeExtSchema = <Schema extends SchemaExt>(
  schema: Schema,
): SchemaExt => {
  const s = S.Any.annotations({
    aspect: schema,
  });
  return new Proxy(() => {}, {
    get: (_target, prop) => s[prop as keyof typeof s],
    apply: (_target, _thisArg, [template, ...references]) => {
      return S.annotations({
        aspect: {
          ...schema,
          template,
          references,
        },
      });
    },
  }) as any as SchemaExt;
};

// export type def = typeof def;

export interface func<
  Input extends undefined | S.Schema.All | S.Schema.All[],
  Output extends S.Schema.All,
> extends S.Schema<
  Input extends undefined
    ? () => S.Schema.Type<Output>
    : Input extends S.Schema.All[]
      ? (...args: TypeArray<Input>) => S.Schema.Type<Output>
      : (input: S.Schema.Type<Input>) => S.Schema.Type<Output>
> {}

type TypeArray<T extends S.Schema.All[]> = T extends [
  infer Head,
  ...infer Tail extends S.Schema.All[],
]
  ? Head extends S.Schema.All
    ? [S.Schema.Type<Head>, ...TypeArray<Tail>]
    : never
  : [];

export const func: {
  <Output extends S.Schema<any>>(
    output: Output,
  ): func<undefined, Output> & {
    <R extends any[]>(
      template: TemplateStringsArray,
      ...references: R
    ): SchemaWithTemplate<func<undefined, Output>, R>;
  };
  <Input extends S.Schema<any>, Output extends S.Schema<any>>(
    input: Input,
    output: Output,
  ): func<Input, Output> & {
    <R extends any[]>(
      template: TemplateStringsArray,
      ...references: R
    ): SchemaWithTemplate<func<Input, Output>, R>;
  };
  <const Args extends S.Schema<any>[], Output extends S.Schema<any>>(
    args: Args,
    output: Output,
  ): func<Args, Output> & {
    <R extends any[]>(
      template: TemplateStringsArray,
      ...references: R
    ): SchemaWithTemplate<func<Args, Output>, R>;
  };
} = ((input: any, output: any) =>
  S.Any.annotations({
    aspect: {
      type: "fn",
      input: output ? input : undefined,
      output: output ?? input,
    },
  })) as any;

export interface effect<A, Err, Req> extends S.Schema<
  Effect<S.Schema.Type<A>, S.Schema.Type<Err>, S.Schema.Type<Req>>
> {}

export const effect = <
  A extends S.Schema<any>,
  Err extends S.Schema<any> | S.Never = S.Never,
  Req extends S.Schema<any> | S.Any = S.Any,
>(
  a: A,
  err: Err = S.Never as any,
  req: Req = S.Never as any,
): effect<A, Err, Req> =>
  S.Any.annotations({
    aspect: {
      type: "effect",
      a: a,
      err: err,
      req: req,
    },
  });

export const stream = <
  A extends S.Schema<any>,
  Err extends S.Schema<any> | S.Never = S.Never,
  Req extends S.Schema<any> | S.Never = S.Never,
>(
  a: A,
  err: Err = S.Never as any,
  req: Req = S.Never as any,
) =>
  S.Any.annotations({
    aspect: {
      type: "stream",
      a: a,
      err: err,
      req: req,
    },
  });

export const sink = <
  A extends S.Schema<any>,
  In extends S.Schema<any>,
  L extends S.Schema<any>,
  Err extends S.Schema<any> | S.Never = S.Never,
  Req extends S.Schema<any> | S.Never = S.Never,
>(
  a: A,
  _in: In = S.Never as any,
  l: L = S.Never as any,
  err: Err = S.Never as any,
  req: Req = S.Never as any,
) =>
  S.Any.annotations({
    aspect: {
      type: "sink",
      a: a,
      in: _in,
      l: l,
      err: err,
      req: req,
    },
  });
