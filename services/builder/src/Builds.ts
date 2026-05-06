import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { Builder } from "./Builder.ts";

/**
 * Per-job build orchestrator. One Durable Object instance per job id
 * (e.g. `${repo}@${sha}` for push builds, `${repo}@pr-${n}` for agent
 * runs): holds run state in `state.storage` and dispatches to a Container
 * by RPC. The DO's serialized identity makes runs naturally serialized
 * per id.
 */
export type BuildState = {
  status: "pending" | "running" | "success" | "failure";
  kind?: "build" | "agent";
  repo?: string;
  ref?: string;
  sha?: string;
  startedAt?: number;
  completedAt?: number;
  exitCode?: number;
  logTail?: string;
  pushedSha?: string | null;
};

export default class Builds extends Cloudflare.DurableObjectNamespace<Builds>()(
  "Builds",
  Effect.gen(function* () {
    const builderEff = yield* Cloudflare.Container.bind(Builder);

    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      const builder = yield* Cloudflare.start(builderEff);

      const get = () =>
        Effect.gen(function* () {
          const raw = yield* state.storage.get<BuildState>("state");
          return raw ?? { status: "pending" as const };
        });

      return {
        get,
        runBuild: (input: {
          repo: string;
          ref: string;
          sha: string;
          token?: string;
        }) =>
          Effect.gen(function* () {
            const startedAt = Date.now();
            yield* state.storage.put<BuildState>("state", {
              status: "running",
              kind: "build",
              repo: input.repo,
              ref: input.ref,
              sha: input.sha,
              startedAt,
            });
            const result = yield* builder
              .runBuild(input)
              .pipe(
                Effect.catch((e) =>
                  Effect.succeed({ exitCode: 1, logTail: String(e) }),
                ),
              );
            const finalState: BuildState = {
              status: result.exitCode === 0 ? "success" : "failure",
              kind: "build",
              repo: input.repo,
              ref: input.ref,
              sha: input.sha,
              startedAt,
              completedAt: Date.now(),
              exitCode: result.exitCode,
              logTail: result.logTail,
            };
            yield* state.storage.put<BuildState>("state", finalState);
            return finalState;
          }),

        runAgent: (input: {
          repo: string;
          ref: string;
          prompt: string;
          pushBranch?: string;
          token?: string;
        }) =>
          Effect.gen(function* () {
            const startedAt = Date.now();
            yield* state.storage.put<BuildState>("state", {
              status: "running",
              kind: "agent",
              repo: input.repo,
              ref: input.ref,
              startedAt,
            });
            const result = yield* builder.runAgent(input).pipe(
              Effect.catch((e) =>
                Effect.succeed({
                  exitCode: 1,
                  logTail: String(e),
                  pushedSha: null,
                }),
              ),
            );
            const finalState: BuildState = {
              status: result.exitCode === 0 ? "success" : "failure",
              kind: "agent",
              repo: input.repo,
              ref: input.ref,
              startedAt,
              completedAt: Date.now(),
              exitCode: result.exitCode,
              logTail: result.logTail,
              pushedSha: result.pushedSha,
            };
            yield* state.storage.put<BuildState>("state", finalState);
            return finalState;
          }),
      };
    });
  }),
) {}
