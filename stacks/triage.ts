import * as Triage from "@alchemy.run/triage";
import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Discord from "alchemy/Discord";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Logs, Traces } from "./otel/Datasets.ts";
import {
  TriageChannelWebhook,
  TriageDiscordApp,
} from "./triage/Bindings.ts";
import TriageWorker from "./triage/Worker.ts";

/**
 * Triage stack. Wires Axiom OTEL signals through Cloudflare Workers AI into a
 * D1-backed issue catalog, with Discord notifications on first detection.
 *
 * Configuration (`Config`):
 * - `DISCORD_BOT_TOKEN`         — bot token (consumed by `alchemy/Discord`)
 * - `DISCORD_APPLICATION_ID`    — bot's application id
 * - `DISCORD_CHANNEL_ID`        — channel for webhook posts
 * - `DISCORD_GUILD_ID` (opt.)   — register `/triage` in this guild only
 *
 * What it provisions:
 * - `Triage.IssuesDB`    — D1 with migrations
 * - `TriageWorker`       — Cloudflare Worker (Triage.handler)
 * - `TriageDiscordApp`   — imports the bot
 * - `TriageChannelWebhook` — channel webhook
 * - `Discord.SlashCommand` — `/triage [status]`
 * - `Axiom.Notifier`     — customWebhook pointing at the worker
 * - `Axiom.Monitor` x 2  — error-rate (logs) + provider-error-rate (traces)
 */
export default Alchemy.Stack(
  "AlchemyTriage",
  {
    providers: Layer.mergeAll(
      Axiom.providers(),
      Cloudflare.providers(),
      Discord.providers(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const guildIdOpt = yield* Config.string("DISCORD_GUILD_ID").pipe(
      Config.option,
    );
    const guildId = guildIdOpt._tag === "Some" ? guildIdOpt.value : undefined;

    const triageWebhookSecret = yield* Config.string(
      "TRIAGE_WEBHOOK_SECRET",
    );

    const app = yield* TriageDiscordApp;
    const channelWebhook = yield* TriageChannelWebhook;

    yield* Discord.SlashCommand("TriageSlash", {
      applicationId: app.applicationId,
      guildId,
      name: "triage",
      description: "Show the highest-priority open triage issues",
      options: [
        {
          type: 3, // STRING
          name: "status",
          description: "Filter by status",
          required: false,
          choices: [
            { name: "open", value: "open" },
            { name: "triaging", value: "triaging" },
            { name: "reproduced", value: "reproduced" },
            { name: "fixing", value: "fixing" },
            { name: "closed", value: "closed" },
          ],
        },
      ],
    });

    const db = yield* Triage.IssuesDB;
    const worker = yield* TriageWorker;
    const traces = yield* Traces;
    const logs = yield* Logs;

    const notifier = yield* Axiom.Notifier("TriageWorker", {
      name: "alchemy-triage-worker",
      properties: {
        customWebhook: {
          url: Output.interpolate`${worker.url}/webhooks/axiom`,
          body: "",
          headers: {
            Authorization: `Bearer ${triageWebhookSecret}`,
          },
        },
      },
    });

    yield* Axiom.Monitor("ErrorRate", {
      name: "Error rate (logs)",
      description:
        "Fires for every log event with severity >= ERROR so the triage worker can classify it.",
      type: "MatchEvent",
      aplQuery: Output.interpolate`
        ['${logs.name}']
        | where ['severity_text'] in ("ERROR", "FATAL")
        | project _time, message=['body'], severity=['severity_text'],
                  service=tostring(['resource.attributes']['service.name']),
                  errorType=tostring(['attributes']['exception.type']),
                  location=tostring(['attributes']['code.filepath']),
                  attributes=['attributes']
      `,
      intervalMinutes: 1,
      rangeMinutes: 1,
      notifierIds: [notifier.id],
    });

    yield* Axiom.Monitor("ProviderErrorRate", {
      name: "Resource provider error rate",
      description:
        "Threshold: fires when more than 5 provider.* spans error in 5 min.",
      type: "Threshold",
      aplQuery: Output.interpolate`
        ['${traces.name}']
        | where name startswith "provider." and tobool(['error'])
        | summarize errors=count() by bin_auto(_time)
      `,
      operator: "Above",
      threshold: 5,
      intervalMinutes: 5,
      rangeMinutes: 5,
      alertOnNoData: false,
      resolvable: true,
      notifierIds: [notifier.id],
    });

    return {
      workerUrl: worker.url.as<string>(),
      issuesDbId: db.databaseId,
      discordWebhookUrl: channelWebhook.url,
    };
  }).pipe(Effect.orDie),
);
