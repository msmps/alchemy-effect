# @alchemy.run/triage

A Cloudflare Worker that consumes Axiom OTEL logs/metrics, classifies them with
Cloudflare Workers AI, and maintains a prioritized issue catalog in D1.

When a new issue is detected it is posted to a Discord webhook. Reproducer +
PR generation via a Claude Code container is a follow-up (see `stacks/triage/`
for the stack wiring).

## Architecture

```
Axiom Monitor (every N min)
   │  customWebhook
   ▼
Cloudflare Worker (this package)
   │  classifyEvent → Workers AI (@cf/meta/llama-3.3-70b)
   │  upsertIssue   → D1 (issues table, fingerprint dedup)
   │  postToDiscord → Discord Webhook (when severity >= floor)
   ▼
GET /issues, GET /issues/:id  — read API
```

## Routes

- `POST /webhooks/axiom` — Axiom Monitor / customWebhook target. Auth via
  `Authorization: Bearer ${TRIAGE_WEBHOOK_SECRET}` if the secret is set.
- `GET  /issues?status=open&limit=50` — list issues.
- `GET  /issues/:id` — fetch a single issue (id is the 16-char fingerprint).
- `GET  /health` — liveness.

## Wiring it up

```ts
import * as Triage from "@alchemy.run/triage";
import * as Cloudflare from "alchemy/Cloudflare";

class TriageWorker extends Cloudflare.Worker<TriageWorker>()(
  "Triage",
  { main: import.meta.path, url: true },
  Triage.handler({ discordSeverityFloor: 3 }),
) {}
```

The handler expects:

- A bound D1 database named `TriageIssuesDB` (provided by `Triage.IssuesDB`).
- A Workers AI binding (`AI`).
- `DISCORD_WEBHOOK_URL` and (optionally) `TRIAGE_WEBHOOK_SECRET` as env vars.

See `stacks/triage.ts` for an end-to-end deployment example that also
provisions an Axiom Monitor + Notifier targeting this worker.

## Issue fingerprinting

Issues are deduplicated using a stable FNV-1a hash of the (normalized) error
type, code location, service, and message. Numbers, hex tokens, and
timestamps are stripped before hashing so cosmetic variations don't fragment
one logical issue into many rows.
