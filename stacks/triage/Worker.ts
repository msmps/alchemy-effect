import * as Triage from "@alchemy.run/triage";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";
import * as Redacted from "effect/Redacted";

/**
 * The triage worker.
 *
 * Reads:
 * - `Triage.IssuesDB` — D1 (issue catalog)
 * - `AI`              — Cloudflare Workers AI binding
 *
 * Receives Axiom Monitor `customWebhook` POSTs at `/webhooks/axiom` and
 * exposes `GET /issues` for inspection.
 *
 * Env vars (sourced from `process.env` at deploy time, typically Doppler):
 * - `DISCORD_WEBHOOK_URL`   — webhook URL for new-issue alerts
 * - `TRIAGE_WEBHOOK_SECRET` — bearer secret expected from Axiom Notifier
 */
export default class TriageWorker extends Cloudflare.Worker<TriageWorker>()(
  "TriageWorker",
  Stack.useSync(({ stage }) => ({
    main: import.meta.path,
    url: true,
    observability: { enabled: true },
    domain: stage === "prod" ? ["triage.alchemy.run"] : undefined,
    compatibility: {
      flags: ["nodejs_compat"],
      date: "2026-03-17",
    },
    env: {
      DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL ?? "",
      TRIAGE_WEBHOOK_SECRET: process.env.TRIAGE_WEBHOOK_SECRET
        ? Redacted.make(process.env.TRIAGE_WEBHOOK_SECRET)
        : "",
    },
  })),
  Triage.handler({ discordSeverityFloor: 3 }),
) {}
