import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

/**
 * Public HTTP API for the builder service. Hand-written with `HttpApi*`
 * schemas so the Vite SPA can derive a typed client from the same
 * definitions. See https://v2.alchemy.run/guides/effect-http-api/.
 */

export const BuildKind = Schema.Literals(["build", "agent"]);
export type BuildKind = typeof BuildKind.Type;

export const BuildStatus = Schema.Literals([
  "pending",
  "running",
  "success",
  "failure",
]);
export type BuildStatus = typeof BuildStatus.Type;

/** Single record returned by the index — enough to render a list row. */
export class BuildSummary extends Schema.Class<BuildSummary>("BuildSummary")({
  id: Schema.String,
  status: BuildStatus,
  kind: Schema.optional(BuildKind),
  repo: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
  sha: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.Number),
  completedAt: Schema.optional(Schema.Number),
}) {}

/** Detail returned by `GET /api/builds/:id` and the SSE event stream. */
export class BuildDetail extends Schema.Class<BuildDetail>("BuildDetail")({
  id: Schema.String,
  status: BuildStatus,
  kind: Schema.optional(BuildKind),
  repo: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
  sha: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.Number),
  completedAt: Schema.optional(Schema.Number),
  exitCode: Schema.optional(Schema.Number),
  logTail: Schema.optional(Schema.String),
  pushedSha: Schema.optional(Schema.NullOr(Schema.String)),
}) {}

export class BuildList extends Schema.Class<BuildList>("BuildList")({
  builds: Schema.Array(BuildSummary),
}) {}

export class BuildNotFound extends Schema.TaggedErrorClass<BuildNotFound>()(
  "BuildNotFound",
  { id: Schema.String },
) {}

const BuildIdParam = Schema.Struct({ id: Schema.String });

export const listBuilds = HttpApiEndpoint.get("listBuilds", "/api/builds", {
  success: BuildList,
});

export const getBuild = HttpApiEndpoint.get("getBuild", "/api/builds/:id", {
  params: BuildIdParam,
  success: BuildDetail,
  error: BuildNotFound,
});

export class BuildsGroup extends HttpApiGroup.make("builds")
  .add(listBuilds)
  .add(getBuild) {}

export class BuilderApi extends HttpApi.make("BuilderApi").add(BuildsGroup) {}

/**
 * Path for the SSE endpoint exposed outside the typed `HttpApi` schema
 * (Effect's HttpApi doesn't yet model streaming responses cleanly).
 *
 * Each event is a single `data:` line containing a JSON-encoded
 * {@link BuildDetail}. The stream emits whenever the underlying state
 * changes and stays open until the build reaches a terminal state.
 */
export const buildEventsPath = (id: string) =>
  `/api/builds/${encodeURIComponent(id)}/events`;
