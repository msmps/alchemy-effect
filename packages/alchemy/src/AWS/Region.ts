import * as Region from "@distilled.cloud/aws/Region";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AWSEnvironment } from "./Environment.ts";

export { Region } from "@distilled.cloud/aws/Region";

export const AWS_REGION = Config.string("AWS_REGION");

export type RegionID = string;

export const of = (region: string) => Layer.succeed(Region.Region, region);

export const fromEnvOrElse = (region: string) =>
  Layer.succeed(Region.Region, process.env.AWS_REGION ?? region);

/**
 * Derive the AWS region from the surrounding {@link AWSEnvironment}.
 */
export const fromEnvironment = Layer.effect(
  Region.Region,
  Effect.map(AWSEnvironment.asEffect(), (env) => env.region),
);
