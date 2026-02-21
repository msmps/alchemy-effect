import type {
  ConsumedCapacity,
  ReturnConsumedCapacity,
} from "distilled-aws/dynamodb";
import * as DynamoDB from "distilled-aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output/index.ts";
import * as Policy from "../../Policy/index.ts";
import * as Lambda from "../Lambda/index.ts";
import { fromAttributeValue } from "./AttributeValue.ts";
import type { Table } from "./Table.ts";

export interface GetItemConstraint<
  LeadingKeys extends Policy.AnyOf<any> = Policy.AnyOf<any>,
  Attributes extends Policy.AnyOf<any> = Policy.AnyOf<any>,
  ReturnConsumedCapacityValue extends Policy.AnyOf<any> = Policy.AnyOf<any>,
> {
  leadingKeys?: LeadingKeys;
  attributes?: Attributes;
  returnConsumedCapacity?: ReturnConsumedCapacityValue;
}

export interface GetItemRequest<T extends Table>
  extends Omit<DynamoDB.GetItemInput, "TableName" | "Key"> {
  Key: Table.Key<T>;
}

export interface GetItemResult<T extends Table, Key extends Table.Key<T>> {
  Item: (InstanceType<T["props"]["items"]> & Key) | undefined;
  ConsumedCapacity?: ConsumedCapacity;
}

export const GetItem = Binding.make(
  "AWS.DynamoDB.GetItem",
  <
    T extends Table,
    const LeadingKeys extends Policy.AnyOf<any> = Policy.AnyOf<string>,
    const Attributes extends Policy.AnyOf<any> = never,
    const ReturnConsumedCapacityValue extends Policy.AnyOf<any> = never,
  >(
    table: T,
    constraint?: GetItemConstraint<
      LeadingKeys,
      Attributes,
      ReturnConsumedCapacityValue
    >,
  ) =>
    Binding.fn(table, constraint, function* (request: GetItemRequest<T>) {
      const tableName = yield* table.tableName();
      const { Item, ...rest } = yield* DynamoDB.getItem({
        ...request,
        TableName: tableName,
        Key: {
          [table.props.partitionKey]: {
            S: (request.Key as any)[table.props.partitionKey] as string,
          },
          ...(table.props.sortKey
            ? {
                [table.props.sortKey]: {
                  S: (request.Key as any)[table.props.sortKey] as string,
                },
              }
            : {}),
        },
      });

      return {
        ...rest,
        Item: Item
          ? (Object.fromEntries(
              yield* Effect.promise(() =>
                Promise.all(
                  Object.entries(Item!).map(async ([key, value]) => [
                    key,
                    await fromAttributeValue(value!),
                  ]),
                ),
              ),
            ) as any)
          : undefined,
      };
    }),
);

export const GetItemLambda = Binding.effect(
  [Lambda.Function, GetItem],
  (func, table, props) =>
    Effect.succeed({
      policyStatements: [
        {
          Sid: "GetItem",
          Effect: "Allow",
          Action: ["dynamodb:GetItem"],
          Resource: [Output.interpolate`${table.tableArn()}`],
          Condition:
            props?.leadingKeys ||
            props?.attributes ||
            props?.returnConsumedCapacity
              ? {
                  "ForAllValues:StringEquals": {
                    "dynamodb:LeadingKeys": props.leadingKeys?.anyOf as string[],
                    "dynamodb:Attributes": props.attributes?.anyOf as string[],
                    "dynamodb:ReturnConsumedCapacity": props.returnConsumedCapacity
                      ?.anyOf as string[],
                  },
                }
              : undefined,
        },
      ],
    }),
);
