import * as Effect from "effect/Effect";
import type { D1ConnectionClient } from "alchemy/Cloudflare";

export type IssueStatus =
  | "open"
  | "triaging"
  | "reproduced"
  | "fixing"
  | "closed";

export interface Issue {
  id: string;
  title: string;
  summary: string;
  severity: number;
  status: IssueStatus;
  occurrences: number;
  firstSeen: number;
  lastSeen: number;
  axiomQuery: string | null;
  sampleEvent: unknown;
  prUrl: string | null;
  discordMessageId: string | null;
}

export interface IssueRow {
  id: string;
  title: string;
  summary: string;
  severity: number;
  status: string;
  occurrences: number;
  first_seen: number;
  last_seen: number;
  axiom_query: string | null;
  sample_event: string | null;
  pr_url: string | null;
  discord_msg_id: string | null;
}

const fromRow = (row: IssueRow): Issue => ({
  id: row.id,
  title: row.title,
  summary: row.summary,
  severity: row.severity,
  status: (row.status as IssueStatus) ?? "open",
  occurrences: row.occurrences,
  firstSeen: row.first_seen,
  lastSeen: row.last_seen,
  axiomQuery: row.axiom_query,
  sampleEvent: row.sample_event ? safeParse(row.sample_event) : null,
  prUrl: row.pr_url,
  discordMessageId: row.discord_msg_id,
});

const safeParse = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

/**
 * Compute a stable fingerprint for an event so repeated occurrences map to a
 * single Issue row. Uses a fast non-cryptographic hash (FNV-1a) since this
 * runs inside the worker hot path.
 */
export const fingerprint = (parts: readonly string[]): string => {
  const input = parts
    .map((p) => normalize(p))
    .filter((p) => p.length > 0)
    .join("|");
  // FNV-1a 64-bit, returned as 16-char hex string.
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
};

/**
 * Normalize a token used in the fingerprint so that minor variations (e.g.
 * memory addresses, request ids, timestamps) don't fragment the same logical
 * issue across many rows.
 */
const normalize = (s: string) =>
  s
    .replace(/0x[0-9a-fA-F]+/g, "0xN") // pointers
    .replace(/\b[0-9a-fA-F]{8,}\b/g, "HEX") // hashes / req ids
    .replace(/\b\d{10,}\b/g, "TS") // unix timestamps
    .replace(/\d+/g, "N") // bare numbers
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

export const upsertIssue = (
  db: D1ConnectionClient,
  issue: Issue,
): Effect.Effect<Issue, never, never> =>
  Effect.gen(function* () {
    const stmt = yield* db.prepare(
      `INSERT INTO issues (
         id, title, summary, severity, status, occurrences,
         first_seen, last_seen, axiom_query, sample_event,
         pr_url, discord_msg_id
       )
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         occurrences = occurrences + 1,
         last_seen   = excluded.last_seen,
         severity    = MAX(severity, excluded.severity),
         summary     = excluded.summary,
         sample_event= excluded.sample_event
       RETURNING *`,
    );
    const bound = stmt.bind(
      issue.id,
      issue.title,
      issue.summary,
      issue.severity,
      issue.status,
      issue.firstSeen,
      issue.lastSeen,
      issue.axiomQuery,
      issue.sampleEvent ? JSON.stringify(issue.sampleEvent) : null,
      issue.prUrl,
      issue.discordMessageId,
    );
    const result = yield* Effect.promise(() => bound.first<IssueRow>());
    if (!result) {
      // Should never happen with RETURNING * — but be defensive.
      return issue;
    }
    return fromRow(result);
  }).pipe(Effect.orDie);

export const listIssues = (
  db: D1ConnectionClient,
  options: { status?: IssueStatus; limit?: number } = {},
): Effect.Effect<Issue[], never, never> =>
  Effect.gen(function* () {
    const limit = options.limit ?? 50;
    const stmt = options.status
      ? (yield* db.prepare(
          `SELECT * FROM issues WHERE status = ?
           ORDER BY severity DESC, last_seen DESC LIMIT ?`,
        )).bind(options.status, limit)
      : (yield* db.prepare(
          `SELECT * FROM issues
           ORDER BY severity DESC, last_seen DESC LIMIT ?`,
        )).bind(limit);
    const result = yield* Effect.promise(() => stmt.all<IssueRow>());
    return (result.results ?? []).map(fromRow);
  }).pipe(Effect.orDie);

export const getIssue = (
  db: D1ConnectionClient,
  id: string,
): Effect.Effect<Issue | null, never, never> =>
  Effect.gen(function* () {
    const stmt = (yield* db.prepare(`SELECT * FROM issues WHERE id = ?`)).bind(
      id,
    );
    const result = yield* Effect.promise(() => stmt.first<IssueRow>());
    return result ? fromRow(result) : null;
  }).pipe(Effect.orDie);

export const setIssueStatus = (
  db: D1ConnectionClient,
  id: string,
  status: IssueStatus,
  prUrl?: string,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const stmt = (yield* db.prepare(
      `UPDATE issues
       SET status = ?, pr_url = COALESCE(?, pr_url)
       WHERE id = ?`,
    )).bind(status, prUrl ?? null, id);
    yield* Effect.promise(() => stmt.run());
  }).pipe(Effect.orDie);

export const setDiscordMessageId = (
  db: D1ConnectionClient,
  id: string,
  messageId: string,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const stmt = (yield* db.prepare(
      `UPDATE issues SET discord_msg_id = ? WHERE id = ?`,
    )).bind(messageId, id);
    yield* Effect.promise(() => stmt.run());
  }).pipe(Effect.orDie);
