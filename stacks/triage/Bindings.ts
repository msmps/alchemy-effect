import * as Discord from "alchemy/Discord";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

/**
 * Discord application (bot) — must be created in the Developer Portal first
 * and supplied via `DISCORD_APPLICATION_ID` (alongside `DISCORD_BOT_TOKEN`
 * for the alchemy Discord providers).
 */
export const TriageDiscordApp = Discord.Application(
  "TriageApp",
  Config.string("DISCORD_APPLICATION_ID").asEffect().pipe(
    Effect.map((applicationId) => ({ applicationId })),
    Effect.orDie,
  ),
);

/**
 * Channel webhook the triage worker posts new issues into. The channel ID
 * is supplied at deploy time via `DISCORD_CHANNEL_ID`. The resulting URL is
 * exposed as a stack output — copy it into Doppler / your env as
 * `DISCORD_WEBHOOK_URL` and redeploy so the worker can post to it.
 */
export const TriageChannelWebhook = Discord.Webhook(
  "TriageChannelWebhook",
  Config.string("DISCORD_CHANNEL_ID").asEffect().pipe(
    Effect.map((channelId) => ({ channelId, name: "Alchemy Triage" })),
    Effect.orDie,
  ),
);
