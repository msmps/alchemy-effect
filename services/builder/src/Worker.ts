import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import {
  BuilderApi,
  BuildDetail,
  BuildList,
  BuildNotFound,
  BuildSummary,
} from "./Api.ts";
import Builds, { type BuildState } from "./Builds.ts";
import BuildsIndex, { INDEX_NAME } from "./BuildsIndex.ts";
import * as Prompts from "./Prompts.ts";
import { WebhookSecret, WebhookSecretValue } from "./WebhookSecret.ts";

/**
 * Hard-coded repo this builder watches. The Worker source can't reach into
 * the deploy-time `Repository` resource, so the owner/name pair is wired
 * here as a literal — the Stack file (alchemy.run.ts) keeps the same
 * pair and uses it to install the Webhook resource at deploy time.
 */
const REPO: GitHub.RepoRef = {
  owner: "alchemy-run",
  name: "alchemy-effect",
};
const REPO_SLUG = `${REPO.owner}/${REPO.name}`;

const env = (globalThis as any).process?.env ?? {};
const githubToken: string | undefined = env.GITHUB_TOKEN;

// Workers don't expose a real FileSystem; HttpPlatform's file response is stubbed.
const HttpPlatformStub = Layer.succeed(HttpPlatform.HttpPlatform, {
  fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported"),
  fileWebResponse: () =>
    Effect.die("HttpPlatform.fileWebResponse not supported"),
});

const buildId = (suffix: string) => `${REPO_SLUG}@${suffix}`;

const toSummary = (id: string, s: BuildState): BuildSummary =>
  new BuildSummary({
    id,
    status: s.status,
    kind: s.kind,
    repo: s.repo,
    ref: s.ref,
    sha: s.sha,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
  });

const toDetail = (id: string, s: BuildState): BuildDetail =>
  new BuildDetail({
    id,
    status: s.status,
    kind: s.kind,
    repo: s.repo,
    ref: s.ref,
    sha: s.sha,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    exitCode: s.exitCode,
    logTail: s.logTail,
    pushedSha: s.pushedSha,
  });

const isTerminal = (status: BuildState["status"]) =>
  status === "success" || status === "failure";

/**
 * Permissive CORS headers — the SPA worker is on a different origin by
 * default. Tighten `Access-Control-Allow-Origin` to the SPA's deployed
 * URL once you have it.
 */
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "86400",
} as const;

/**
 * Self-hosted CI Worker. Subscribes to GitHub webhooks for one repo and
 * dispatches builds + agent runs to per-job Durable Objects backed by a
 * Cloudflare Container. Exposes a typed JSON API (see `./Api.ts`) for the
 * Vite SPA to display history and stream live status.
 *
 * Routes:
 *   POST /__github/webhook         — webhook receiver (mounted by dispatcher)
 *   GET  /api/builds               — list known builds
 *   GET  /api/builds/:id           — single build status
 *   GET  /api/builds/:id/events    — SSE stream of status updates
 */
export default class Worker extends Cloudflare.Worker<Worker>()(
  "Worker",
  {
    main: import.meta.path,
    compatibility: { flags: ["nodejs_compat"] },
  },
  Effect.gen(function* () {
    const builds = yield* Builds;
    const buildsIndex = yield* BuildsIndex;
    const dispatcher = yield* GitHub.Dispatcher;
    const commitStatuses = yield* GitHub.CommitStatuses;
    const comments = yield* GitHub.IssueComments;

    const indexStub = buildsIndex.getByName(INDEX_NAME);

    const recordStart = (id: string) =>
      indexStub
        .register({ id, startedAt: Date.now() })
        .pipe(Effect.catch(() => Effect.void));

    yield* GitHub.on(REPO, {
      push: ({ payload }) =>
        Effect.gen(function* () {
          if (payload.deleted) return;
          const { after, ref } = payload;
          const id = buildId(after);

          yield* recordStart(id);

          const result = yield* builds
            .getByName(id)
            .runBuild({
              repo: REPO_SLUG,
              ref: ref.replace(/^refs\/heads\//, ""),
              sha: after,
              token: githubToken,
            })
            .pipe(Effect.orDie);

          yield* commitStatuses
            .create(REPO, {
              sha: after,
              state: result.status === "success" ? "success" : "failure",
              context: "alchemy/builder",
              description: `build exit ${result.exitCode}`,
            })
            .pipe(Effect.orElseSucceed(() => ({ id: 0, url: "" })));
        }),

      pull_request_review: ({ payload }) =>
        Effect.gen(function* () {
          if (payload.action !== "submitted") return;
          if (payload.review.state !== "changes_requested") return;
          const pr = payload.pull_request;
          const id = buildId(`pr-${pr.number}`);

          yield* recordStart(id);

          const result = yield* builds
            .getByName(id)
            .runAgent({
              repo: REPO_SLUG,
              ref: pr.head.ref,
              pushBranch: pr.head.ref,
              token: githubToken,
              prompt: Prompts.respondToReview({
                reviewBody: payload.review.body,
                inlineComments: [],
              }),
            })
            .pipe(Effect.orDie);

          yield* comments
            .create(REPO, {
              issueNumber: pr.number,
              body:
                result.pushedSha != null
                  ? `Pushed updates addressing the review (\`${result.pushedSha.slice(0, 7)}\`).`
                  : `Tried to address the review but the run failed (exit ${result.exitCode}).`,
            })
            .pipe(Effect.orElseSucceed(() => ({ id: 0, htmlUrl: "" })));
        }),

      release: ({ payload }) =>
        Effect.gen(function* () {
          if (payload.action !== "published") return;
          const tag = payload.release.tag_name;
          const id = buildId(`release-${tag}`);

          yield* recordStart(id);

          yield* builds
            .getByName(id)
            .runAgent({
              repo: REPO_SLUG,
              ref: "main",
              pushBranch: `release-blog/${tag}`,
              token: githubToken,
              prompt: Prompts.releaseBlog({ fromTag: null, toTag: tag }),
            })
            .pipe(Effect.orDie);
        }),

      issue_comment: ({ payload }) =>
        Effect.gen(function* () {
          if (payload.action !== "created") return;
          const body = payload.comment.body ?? "";
          if (!body.startsWith("/build")) return;
          if (!payload.issue.pull_request) return;
          // Chat-op rebuild for a PR — left for the operator to wire up.
        }),
    });

    // ── HttpApi handlers ────────────────────────────────────────────────
    const buildsGroup = HttpApiBuilder.group(BuilderApi, "builds", (h) =>
      h
        .handle("listBuilds", () =>
          Effect.gen(function* () {
            const entries = yield* indexStub.list().pipe(Effect.orDie);
            const summaries = yield* Effect.all(
              entries.map((e) =>
                builds
                  .getByName(e.id)
                  .get()
                  .pipe(
                    Effect.map((s) => toSummary(e.id, s)),
                    Effect.orElseSucceed(() =>
                      toSummary(e.id, { status: "pending" as const }),
                    ),
                  ),
              ),
              { concurrency: 8 },
            );
            return new BuildList({ builds: summaries });
          }),
        )
        .handle("getBuild", ({ params }) =>
          builds
            .getByName(params.id)
            .get()
            .pipe(
              Effect.map((s) => toDetail(params.id, s)),
              Effect.catch(() =>
                Effect.fail(new BuildNotFound({ id: params.id })),
              ),
            ),
        ),
    );

    // Build the per-request HttpApi handler once at init. The outer
    // toHttpEffect call constructs the inner HttpEffect; the inner Effect
    // is what runs on each request.
    const apiHandler = yield* HttpApiBuilder.layer(BuilderApi).pipe(
      Layer.provide(buildsGroup),
      Layer.provide([Etag.layer, HttpPlatformStub, Path.layer]),
      HttpRouter.toHttpEffect,
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;

        // 0. CORS preflight — the SPA lives on a different worker.
        if (request.method === "OPTIONS") {
          return HttpServerResponse.empty({
            status: 204,
            headers: CORS_HEADERS,
          });
        }

        // 1. GitHub webhook receiver — pre-routed by the dispatcher.
        const handled = yield* dispatcher.handle(request);
        if (handled !== undefined) return handled;

        const url = new URL(request.url);

        // 2. SSE status stream — outside HttpApi (it doesn't model
        //    streaming responses cleanly today).
        const sseMatch = url.pathname.match(/^\/api\/builds\/(.+)\/events$/);
        if (request.method === "GET" && sseMatch) {
          const id = decodeURIComponent(sseMatch[1]);
          return sseResponse(builds.getByName(id).get(), id);
        }

        // 3. Typed JSON API.
        if (url.pathname.startsWith("/api/")) {
          const response = yield* apiHandler;
          return HttpServerResponse.setHeaders(response, CORS_HEADERS);
        }

        // 4. Anything else — banner. Static SPA assets are served by
        //    the separate `Cloudflare.Vite("Web")` worker.
        return HttpServerResponse.text("alchemy builder", { status: 200 });
      }),
    };
  }).pipe(
    Effect.provide(GitHub.CapabilitiesLive),
    Effect.provide(
      Cloudflare.GitHub.Webhooks.live(
        Effect.gen(function* () {
          const secret = yield* Cloudflare.Secret.bind(WebhookSecret);
          const random = yield* WebhookSecretValue;
          return { secret, value: random.text };
        }),
      ),
    ),
    Effect.provide(Cloudflare.SecretBindingLive),
    Effect.provide(GitHub.Octokit.fromEnv("GITHUB_TOKEN")),
  ),
) {}

/**
 * SSE response that polls the build's DO state once a second and emits
 * an event whenever the JSON serialization changes. Closes when the
 * status reaches a terminal value.
 */
const sseResponse = (
  getState: Effect.Effect<BuildState, unknown, never>,
  id: string,
) => {
  const events = Stream.tick(Duration.seconds(1)).pipe(
    Stream.mapEffect(() =>
      getState.pipe(
        Effect.orElseSucceed(() => ({ status: "pending" as const })),
        Effect.map((s) => toDetail(id, s)),
      ),
    ),
    Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
    Stream.takeUntil((d) => isTerminal(d.status)),
    Stream.map((d) => `data: ${JSON.stringify(d)}\n\n`),
    Stream.encodeText,
  );

  return HttpServerResponse.stream(events, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
      ...CORS_HEADERS,
    },
  });
};
