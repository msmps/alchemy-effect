import * as Effect from "effect/Effect";
import type { AIClient, WorkerEnvironment } from "alchemy/Cloudflare";

/**
 * Default Workers AI model used for triage classification. Cheap, fast, and
 * good enough at 70B for a 1-2 sentence summary + severity score. Override
 * with the `model` option on `triageEvents` if you want to spend more.
 *
 * @see https://developers.cloudflare.com/workers-ai/models/
 */
export const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * Raw event coming in from Axiom (logs or traces) — we accept anything with
 * at minimum a free-form `message` field. Additional fields are passed
 * through to the LLM verbatim so it can pick out useful context.
 */
export interface RawEvent {
  /** ms since epoch. */
  timestamp: number;
  /** Free-form message. For logs this is the log message; for traces, span name + status. */
  message: string;
  /** Optional error type (e.g. `TypeError`, `RetryableHttpError`). */
  errorType?: string;
  /** Optional service name. */
  service?: string;
  /** Optional file:line where the error originated. */
  location?: string;
  /** Optional extra attributes — included in the AI prompt. */
  attributes?: Record<string, unknown>;
  /** APL query that surfaced this event, for breadcrumb display. */
  axiomQuery?: string;
}

export interface TriageDecision {
  title: string;
  summary: string;
  /** 1 (low) .. 5 (critical). */
  severity: number;
}

interface AIChatResponse {
  response?: string;
  result?: { response?: string };
}

const SYSTEM_PROMPT = `You are an SRE triage assistant. Given one error event from production telemetry, produce a short JSON object describing the underlying issue.

Rules:
- "title" must be <= 80 characters and identify the bug, not the symptom.
- "summary" is 1-2 sentences explaining what likely happened and why it matters.
- "severity" is an integer 1..5: 1 = informational, 3 = user-facing bug, 5 = data loss / outage.
- Output ONLY the JSON object, no prose, no markdown.`;

const buildUserPrompt = (event: RawEvent): string => {
  const attrs = event.attributes
    ? `\nAttributes: ${JSON.stringify(event.attributes)}`
    : "";
  return [
    event.service ? `Service: ${event.service}` : "",
    event.errorType ? `Error type: ${event.errorType}` : "",
    event.location ? `Location: ${event.location}` : "",
    `Message: ${event.message}`,
    attrs,
  ]
    .filter(Boolean)
    .join("\n");
};

/**
 * Ask Workers AI to classify an event and return a {@link TriageDecision}. On
 * model failure or invalid JSON we fall back to a deterministic decision so
 * the worker still produces a triaged issue (better degraded than dropped).
 */
export const classifyEvent = (
  ai: AIClient,
  event: RawEvent,
  model: string = DEFAULT_MODEL,
): Effect.Effect<TriageDecision, never, WorkerEnvironment> =>
  ai
    .run<AIChatResponse>(model, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(event) },
      ],
      response_format: { type: "json_object" },
      max_tokens: 256,
    })
    .pipe(
      Effect.map((res) => {
        const raw = res.response ?? res.result?.response ?? "";
        return parseDecision(raw, event);
      }),
      Effect.catch(() => Effect.succeed(fallbackDecision(event))),
    );

const parseDecision = (raw: string, event: RawEvent): TriageDecision => {
  const trimmed = raw.trim().replace(/^```(?:json)?/, "").replace(/```$/, "");
  try {
    const parsed = JSON.parse(trimmed) as Partial<TriageDecision>;
    const severity =
      typeof parsed.severity === "number" && parsed.severity >= 1
        ? Math.min(5, Math.max(1, Math.round(parsed.severity)))
        : 3;
    return {
      title: (parsed.title ?? "").toString().slice(0, 80) ||
        fallbackTitle(event),
      summary: (parsed.summary ?? "").toString() || event.message,
      severity,
    };
  } catch {
    return fallbackDecision(event);
  }
};

const fallbackTitle = (event: RawEvent) =>
  `${event.errorType ?? "Error"}: ${event.message.slice(0, 60)}`;

const fallbackDecision = (event: RawEvent): TriageDecision => ({
  title: fallbackTitle(event),
  summary: event.message,
  severity: 3,
});

/**
 * Convenience: classify a batch of events sequentially. Returns the
 * decisions in the same order. Stops at the first error.
 */
export const triageEvents = (
  ai: AIClient,
  events: readonly RawEvent[],
  model?: string,
) => Effect.forEach(events, (e) => classifyEvent(ai, e, model));
