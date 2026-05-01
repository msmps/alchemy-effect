import * as Cloudflare from "alchemy/Cloudflare";

/**
 * The D1 database that backs the triage issue catalog.
 *
 * Migration files live in `packages/triage/migrations/` and are applied on
 * every deploy via the alchemy D1 migration pipeline.
 */
export const IssuesDB = Cloudflare.D1Database("TriageIssuesDB", {
  migrationsDir: new URL("../migrations", import.meta.url).pathname,
});
