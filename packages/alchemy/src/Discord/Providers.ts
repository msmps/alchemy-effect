import * as Layer from "effect/Layer";
import * as Provider from "../Provider.ts";
import { Application, ApplicationProvider } from "./Application.ts";
import * as Credentials from "./Credentials.ts";
import { SlashCommand, SlashCommandProvider } from "./SlashCommand.ts";
import { Webhook, WebhookProvider } from "./Webhook.ts";

export { DiscordCredentials } from "./Credentials.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Discord",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Discord providers — Application (import), Webhook, SlashCommand.
 *
 * Authentication uses a bot token from `DISCORD_BOT_TOKEN` (or
 * `DISCORD_TOKEN`) by default. To override, provide
 * `Discord.fromToken(...)` instead of `fromEnv()` on the stack.
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([Application, SlashCommand, Webhook]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ApplicationProvider(),
        SlashCommandProvider(),
        WebhookProvider(),
      ),
    ),
    Layer.provideMerge(Credentials.fromEnv()),
    Layer.orDie,
  );
