import type * as runtime from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import type { ResourceLike } from "../../Resource.ts";
import { isWorker, WorkerEnvironment } from "../Workers/Worker.ts";

/**
 * Logical name used as the `env.<name>` key on a Worker bound to
 * Cloudflare Workers AI. Matches Wrangler's default.
 */
export const AI_BINDING_NAME = "AI";

export class AIError extends Data.TaggedError("Cloudflare.AI.Error")<{
  message: string;
  cause?: unknown;
}> {}

export interface AIRunInput {
  // Allow any model-specific input; consumers should narrow at the call site.
  readonly [key: string]: unknown;
}

export interface AIClient {
  /**
   * Resolves to the raw `Ai` binding from `@cloudflare/workers-types`.
   */
  raw: Effect.Effect<runtime.Ai, never, WorkerEnvironment>;

  /**
   * Run a Workers AI model.
   *
   * @param model A model identifier such as `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.
   * @param input Model-specific input. See https://developers.cloudflare.com/workers-ai/models/
   */
  run<T = unknown>(
    model: string,
    input: AIRunInput,
    options?: runtime.AiOptions,
  ): Effect.Effect<T, AIError, WorkerEnvironment>;
}

/**
 * Workers AI binding — a typed handle to Cloudflare's `env.AI` Worker
 * binding for invoking models such as `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.
 *
 * @section Bind from a Worker
 * @example Run a chat completion model
 * ```typescript
 * const ai = yield* Cloudflare.AI.bind();
 * const result = yield* ai.run<{ response: string }>(
 *   "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
 *   {
 *     messages: [
 *       { role: "system", content: "You are a triage assistant." },
 *       { role: "user", content: "Classify this log: ..." },
 *     ],
 *   },
 * );
 * ```
 */
export class AI extends Binding.Service<
  AI,
  () => Effect.Effect<AIClient>
>()("Cloudflare.AI") {}

export const AILive = Layer.effect(
  AI,
  Effect.gen(function* () {
    const policy = yield* AIPolicy;

    return Effect.fn(function* () {
      yield* policy();
      const env = WorkerEnvironment.asEffect();
      const raw = env.pipe(
        Effect.map(
          (env) => (env as Record<string, runtime.Ai>)[AI_BINDING_NAME]!,
        ),
      );

      return {
        raw,
        run: <T>(model: string, input: AIRunInput, options?: runtime.AiOptions) =>
          raw.pipe(
            Effect.flatMap((ai) =>
              Effect.tryPromise({
                try: () => ai.run(model as any, input as any, options) as Promise<T>,
                catch: (cause: any) =>
                  new AIError({
                    message: cause?.message ?? "Workers AI run failed",
                    cause,
                  }),
              }),
            ),
          ),
      } satisfies AIClient as AIClient;
    });
  }),
);

export class AIPolicy extends Binding.Policy<
  AIPolicy,
  () => Effect.Effect<void>
>()("Cloudflare.AI") {}

export const AIPolicyLive = AIPolicy.layer.succeed(
  Effect.fn(function* (host: ResourceLike) {
    if (isWorker(host)) {
      yield* host.bind`${AI_BINDING_NAME}`({
        bindings: [
          {
            // `ai` is a first-class binding type in the Cloudflare Workers
            // metadata API but our local `WorkerBinding` union may not yet
            // include it; cast through `any` to keep the binding inline.
            type: "ai",
            name: AI_BINDING_NAME,
          } as any,
        ],
      });
    } else {
      return yield* Effect.die(
        new Error(`Cloudflare.AI does not support runtime '${host.Type}'`),
      );
    }
  }),
);
