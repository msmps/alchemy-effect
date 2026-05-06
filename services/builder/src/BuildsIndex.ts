import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

/**
 * Singleton DO that maintains an index of every build the worker has
 * dispatched, so the API can list them. Cloudflare doesn't expose a
 * "list all DO instances of a namespace" primitive, so we keep the
 * index ourselves.
 *
 * Routing convention: always address by name `"index"`.
 */
export type BuildsIndexEntry = {
  id: string;
  startedAt: number;
};

export default class BuildsIndex extends Cloudflare.DurableObjectNamespace<
  BuildsIndex
>()(
  "BuildsIndex",
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;

      const list = () =>
        Effect.gen(function* () {
          const map = yield* state.storage.list<BuildsIndexEntry>();
          const entries = Array.from(map.values());
          entries.sort((a, b) => b.startedAt - a.startedAt);
          return entries;
        });

      const register = (entry: BuildsIndexEntry) =>
        state.storage.put<BuildsIndexEntry>(entry.id, entry);

      return { list, register };
    });
  }),
) {}

export const INDEX_NAME = "index";
