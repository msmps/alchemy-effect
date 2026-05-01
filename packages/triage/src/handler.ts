import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { IssuesDB } from "./IssuesDB.ts";
import {
  fingerprint,
  getIssue,
  listIssues,
  setDiscordMessageId,
  upsertIssue,
  type Issue,
  type IssueStatus,
} from "./IssueStore.ts";
import {
  classifyEvent,
  type RawEvent,
  type TriageDecision,
} from "./Triage.ts";

export interface HandlerOptions {
  /**
   * Workers AI model to use for classification.
   * @default "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
   */
  model?: string;
  /**
   * Discord webhook URL the triage worker posts new issues to. When omitted
   * the handler reads `DISCORD_WEBHOOK_URL` from the worker env at runtime.
   */
  discordWebhookUrl?: string;
  /**
   * Shared secret expected on the `Authorization: Bearer ...` header of the
   * `/webhooks/axiom` route. When omitted the handler reads
   * `TRIAGE_WEBHOOK_SECRET` from the worker env.
   */
  webhookSecret?: string;
  /**
   * Severity threshold below which we won't post to Discord. 1..5.
   * @default 2
   */
  discordSeverityFloor?: number;
}

const bindings = Layer.mergeAll(
  Cloudflare.AILive,
  Cloudflare.D1ConnectionLive,
);

class Unauthorized extends Data.TaggedError("Unauthorized")<{}> {}

const requireAuth = (expected: string | undefined) =>
  Effect.gen(function* () {
    if (!expected) return;
    const request = yield* HttpServerRequest;
    const auth = request.headers.authorization;
    if (auth !== `Bearer ${expected}`) {
      return yield* Effect.fail(new Unauthorized());
    }
  });

/**
 * Triage worker handler. Wire as the third argument to `Cloudflare.Worker`:
 *
 * ```ts
 * import * as Triage from "@alchemy.run/triage";
 *
 * class TriageWorker extends Cloudflare.Worker<TriageWorker>()(
 *   "Triage",
 *   { main: import.meta.path, url: true, ... },
 *   Triage.handler({ webhookSecret: env.TRIAGE_WEBHOOK_SECRET }),
 * ) {}
 * ```
 *
 * Routes:
 *
 * - `POST /webhooks/axiom` — accepts an Axiom Monitor / customWebhook payload.
 *   Body shape:
 *   ```json
 *   {
 *     "events": [ { "timestamp": 0, "message": "...", "errorType": "...", ... } ],
 *     "axiomQuery": "['stage-logs'] | where ...",
 *     "monitorName": "..."
 *   }
 *   ```
 * - `GET  /issues?status=open` — list issues, ordered by severity then recency.
 * - `GET  /issues/:id` — fetch a single issue.
 */
export const handler = (options: HandlerOptions = {}) =>
  Effect.gen(function* () {
    const ai = yield* Cloudflare.AI.bind();
    const db = yield* Cloudflare.D1Connection.bind(yield* IssuesDB);

    const expectedSecret =
      options.webhookSecret ??
      (yield* readOptionalConfig("TRIAGE_WEBHOOK_SECRET"));

    const discordWebhookUrl =
      options.discordWebhookUrl ??
      (yield* readOptionalConfig("DISCORD_WEBHOOK_URL"));

    const discordFloor = options.discordSeverityFloor ?? 2;

    const postToDiscord = (issue: Issue, decision: TriageDecision) =>
      Effect.gen(function* () {
        if (!discordWebhookUrl) return;
        if (decision.severity < discordFloor) return;
        const payload = {
          username: "alchemy-triage",
          embeds: [
            {
              title: `[sev ${decision.severity}] ${decision.title}`,
              description: decision.summary,
              color: severityColor(decision.severity),
              fields: [
                {
                  name: "Occurrences",
                  value: String(issue.occurrences),
                  inline: true,
                },
                {
                  name: "Status",
                  value: issue.status,
                  inline: true,
                },
                {
                  name: "Issue ID",
                  value: `\`${issue.id}\``,
                  inline: true,
                },
                ...(issue.axiomQuery
                  ? [
                      {
                        name: "Axiom",
                        value: `\`\`\`kql\n${issue.axiomQuery.slice(0, 800)}\n\`\`\``,
                        inline: false,
                      },
                    ]
                  : []),
              ],
            },
          ],
        };
        const res = yield* Effect.tryPromise({
          try: () =>
            fetch(`${discordWebhookUrl}?wait=true`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            }),
          catch: (cause) => new Error(`discord post failed: ${String(cause)}`),
        });
        if (!res.ok) return;
        const body = (yield* Effect.tryPromise({
          try: () => res.json() as Promise<{ id?: string }>,
          catch: () => new Error("discord parse failed"),
        }).pipe(Effect.orElseSucceed(() => ({}) as { id?: string })));
        if (body.id) {
          yield* setDiscordMessageId(db, issue.id, body.id);
        }
      }).pipe(Effect.catch(() => Effect.void));

    const triageOne = (event: RawEvent) =>
      Effect.gen(function* () {
        const id = fingerprint([
          event.errorType ?? "",
          event.location ?? "",
          event.service ?? "",
          event.message,
        ]);
        const decision = yield* classifyEvent(ai, event, options.model);
        const now = event.timestamp || Date.now();
        const issue = yield* upsertIssue(db, {
          id,
          title: decision.title,
          summary: decision.summary,
          severity: decision.severity,
          status: "open",
          occurrences: 1,
          firstSeen: now,
          lastSeen: now,
          axiomQuery: event.axiomQuery ?? null,
          sampleEvent: {
            message: event.message,
            errorType: event.errorType,
            service: event.service,
            location: event.location,
            attributes: event.attributes,
          },
          prUrl: null,
          discordMessageId: null,
        });
        // Only ping Discord on the first occurrence to avoid spam. The
        // upserted row's `occurrences` is post-increment, so == 1 means new.
        if (issue.occurrences <= 1) {
          yield* postToDiscord(issue, decision);
        }
        return { id, decision, occurrences: issue.occurrences };
      });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, `https://${request.headers.host ?? "localhost"}`);
        const path = url.pathname;
        const method = request.method;

        if (method === "POST" && path === "/webhooks/axiom") {
          return yield* Effect.gen(function* () {
            yield* requireAuth(expectedSecret);
            const text = yield* request.text;
            const body = parseWebhookPayload(text);
            if (body.events.length === 0) {
              return yield* HttpServerResponse.json(
                { ok: true, triaged: 0 },
                { status: 200 },
              );
            }
            const results = yield* Effect.forEach(body.events, triageOne);
            return yield* HttpServerResponse.json({
              ok: true,
              triaged: results.length,
              issues: results,
            });
          }).pipe(
            Effect.catchTag("Unauthorized", () =>
              HttpServerResponse.json(
                { error: "unauthorized" },
                { status: 401 },
              ),
            ),
          );
        }

        if (method === "GET" && path === "/issues") {
          const status = url.searchParams.get("status") as IssueStatus | null;
          const limit = Number(url.searchParams.get("limit") ?? 50);
          const issues = yield* listIssues(db, {
            status: status ?? undefined,
            limit,
          });
          return yield* HttpServerResponse.json({ issues });
        }

        const issueMatch = path.match(/^\/issues\/([a-f0-9]{16})$/i);
        if (method === "GET" && issueMatch) {
          const issue = yield* getIssue(db, issueMatch[1]!);
          return issue
            ? yield* HttpServerResponse.json({ issue })
            : yield* HttpServerResponse.json(
                { error: "not found" },
                { status: 404 },
              );
        }

        if (method === "GET" && path === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }).pipe(
        Effect.catch((error: any) =>
          Effect.succeed(
            HttpServerResponse.text(
              `Internal Server Error: ${error?.message ?? error?._tag ?? String(error)}`,
              { status: 500 },
            ),
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(bindings), Effect.orDie);

const readOptionalConfig = (name: string) =>
  Effect.gen(function* () {
    const opt = yield* Config.string(name).pipe(Config.option);
    return opt._tag === "Some" ? opt.value : undefined;
  });

interface WebhookPayload {
  events: RawEvent[];
}

const parseWebhookPayload = (text: string): WebhookPayload => {
  if (!text) return { events: [] };
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { events: [] };
  }
  // Axiom Monitor "MatchEvent" notifier posts one event; "Threshold" posts an
  // aggregate. We accept three shapes:
  //   1. { events: [...] }
  //   2. Axiom Monitor MatchEvent: { matchedEvent: {...}, query, monitor: { name } }
  //   3. Axiom Monitor Threshold:  { aggregations: [...], query, monitor: { name } }
  if (Array.isArray(parsed?.events)) {
    return { events: parsed.events.map(coerce) };
  }
  if (parsed?.matchedEvent) {
    return {
      events: [
        coerce({
          ...parsed.matchedEvent,
          axiomQuery: parsed.query,
        }),
      ],
    };
  }
  if (Array.isArray(parsed?.aggregations)) {
    return {
      events: parsed.aggregations.map((row: any) =>
        coerce({
          message:
            parsed.monitor?.name ??
            `aggregate over ${Object.keys(row).join(",")}`,
          attributes: row,
          axiomQuery: parsed.query,
        }),
      ),
    };
  }
  // Otherwise treat the whole body as a single event.
  return { events: [coerce(parsed)] };
};

const coerce = (raw: any): RawEvent => ({
  timestamp:
    typeof raw.timestamp === "number"
      ? raw.timestamp
      : raw._time
        ? new Date(raw._time).getTime()
        : Date.now(),
  message:
    typeof raw.message === "string"
      ? raw.message
      : raw.body ??
        raw.name ??
        raw.event ??
        JSON.stringify(raw).slice(0, 500),
  errorType: raw.errorType ?? raw["error.type"] ?? raw.type ?? undefined,
  service: raw.service ?? raw["service.name"] ?? undefined,
  location: raw.location ?? raw["code.filepath"] ?? undefined,
  attributes:
    raw.attributes && typeof raw.attributes === "object"
      ? (raw.attributes as Record<string, unknown>)
      : undefined,
  axiomQuery:
    typeof raw.axiomQuery === "string" ? raw.axiomQuery : undefined,
});

const severityColor = (severity: number): number => {
  switch (severity) {
    case 5:
      return 0xb91c1c; // red-700
    case 4:
      return 0xea580c; // orange-600
    case 3:
      return 0xeab308; // yellow-500
    case 2:
      return 0x3b82f6; // blue-500
    default:
      return 0x6b7280; // gray-500
  }
};
