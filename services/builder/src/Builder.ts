import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import type { PlatformError } from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

/**
 * Builder Container — runs one job at a time inside a Cloudflare Container
 * sidecar. Each method on the RPC shape is a discrete build phase the
 * Builds DO can call by RPC.
 *
 * Cloning is done directly against the GitHub repo over HTTPS. A token may
 * be supplied for private repos and to authenticate `git push` in agent
 * runs; if absent, the clone is anonymous (only works for public repos and
 * read-only).
 */
export class Builder extends Cloudflare.Container<
  Builder,
  {
    /**
     * Clone the GitHub repo at `ref` into `/work`, run `bun install` and
     * `bun run build`. Returns the build's exit code and tail of logs.
     */
    runBuild: (input: {
      repo: string;
      ref: string;
      sha: string;
      token?: string;
    }) => Effect.Effect<
      {
        exitCode: number;
        logTail: string;
      },
      PlatformError
    >;

    /**
     * Run a coding-agent task in the cloned tree. Pushes any commits the
     * agent produces back to `pushBranch` (defaults to `ref`).
     */
    runAgent: (input: {
      repo: string;
      ref: string;
      prompt: string;
      pushBranch?: string;
      token?: string;
    }) => Effect.Effect<
      {
        exitCode: number;
        logTail: string;
        pushedSha: string | null;
      },
      PlatformError
    >;
  }
>()("Builder", {
  main: import.meta.path,
  instanceType: "dev",
  observability: { logs: { enabled: true } },
}) {}

export default Builder.make(
  Effect.gen(function* () {
    const cp = yield* ChildProcessSpawner;

    const run = (
      cmd: string,
      options: { cwd?: string; env?: Record<string, string> } = {},
    ) =>
      cp
        .spawn(
          ChildProcess.make(cmd, {
            shell: true,
            cwd: options.cwd,
            env: options.env,
          }),
        )
        .pipe(
          Effect.flatMap((handle) =>
            Effect.all(
              [
                handle.exitCode,
                handle.stdout.pipe(Stream.decodeText, Stream.mkString),
                handle.stderr.pipe(Stream.decodeText, Stream.mkString),
              ],
              { concurrency: "unbounded" },
            ),
          ),
          Effect.map(([exitCode, stdout, stderr]) => ({
            exitCode: Number(exitCode),
            stdout,
            stderr,
          })),
          Effect.scoped,
        );

    return Builder.of({
      fetch: Effect.succeed(
        HttpServerResponse.text("alchemy/builder", { status: 200 }),
      ),
      runBuild: ({ repo, ref, token }) =>
        Effect.gen(function* () {
          const remote = githubRemote(repo, token);
          const clone = yield* run(
            `rm -rf /work && git clone --depth=1 --branch ${ref} ${remote} /work`,
          );
          if (clone.exitCode !== 0) {
            return { exitCode: clone.exitCode, logTail: tail(clone.stderr) };
          }

          const install = yield* run(`bun install --frozen-lockfile`, {
            cwd: "/work",
          });
          if (install.exitCode !== 0) {
            return {
              exitCode: install.exitCode,
              logTail: tail(install.stderr),
            };
          }

          const build = yield* run(`bun run build`, { cwd: "/work" });
          return {
            exitCode: build.exitCode,
            logTail: tail(`${build.stdout}\n${build.stderr}`),
          };
        }),

      runAgent: ({ repo, ref, prompt, pushBranch, token }) =>
        Effect.gen(function* () {
          const remote = githubRemote(repo, token);
          const clone = yield* run(
            `rm -rf /work && git clone --depth=1 --branch ${ref} ${remote} /work`,
          );
          if (clone.exitCode !== 0) {
            return {
              exitCode: clone.exitCode,
              logTail: tail(clone.stderr),
              pushedSha: null,
            };
          }

          const agent = yield* run(
            `printf '%s' ${JSON.stringify(prompt)} | npx @anthropic-ai/claude-code --task -`,
            { cwd: "/work" },
          );
          if (agent.exitCode !== 0) {
            return {
              exitCode: agent.exitCode,
              logTail: tail(`${agent.stdout}\n${agent.stderr}`),
              pushedSha: null,
            };
          }

          const target = pushBranch ?? ref;
          const push = yield* run(
            `git checkout -B ${target} && git push --force-with-lease ${remote} ${target}`,
            { cwd: "/work" },
          );
          const head = yield* run(`git rev-parse HEAD`, { cwd: "/work" });
          return {
            exitCode: push.exitCode,
            logTail: tail(`${agent.stdout}\n${push.stdout}\n${push.stderr}`),
            pushedSha: push.exitCode === 0 ? head.stdout.trim() : null,
          };
        }),
    });
  }),
);

const tail = (s: string, max = 4_000) =>
  s.length <= max ? s : `…${s.slice(-max)}`;

/**
 * Build an `https://github.com/owner/name.git` remote URL with an optional
 * token embedded so `git clone`/`git push` can authenticate without a
 * credential helper. `repo` is in `owner/name` form.
 */
const githubRemote = (repo: string, token?: string) => {
  const auth = token ? `x-access-token:${token}@` : "";
  return `https://${auth}github.com/${repo}.git`;
};
