import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { discordFetch } from "./Credentials.ts";
import type { Providers } from "./Providers.ts";

export type WebhookProps = {
  /**
   * Discord channel ID the webhook will post to.
   * Changing this triggers a replacement.
   */
  channelId: string;
  /** Display name of the webhook. Mutable. */
  name: string;
  /**
   * Optional avatar as a [data URI](https://discord.com/developers/docs/reference#image-data).
   * Updates in place.
   */
  avatar?: string;
};

export type Webhook = Resource<
  "Discord.Webhook",
  WebhookProps,
  {
    webhookId: string;
    channelId: string;
    guildId: string | undefined;
    name: string;
    /**
     * Full webhook URL including the secret token. Treat as a credential —
     * anyone with this URL can post messages to the channel.
     */
    url: string;
    /** Just the webhook token, useful for callers that prefer to construct URLs. */
    token: string;
  },
  never,
  Providers
>;

/**
 * A Discord channel webhook — an unauthenticated POST endpoint that posts
 * messages to a specific channel.
 *
 * Created with `POST /channels/{channel.id}/webhooks` (requires the
 * `MANAGE_WEBHOOKS` permission for the bot). The full URL (including the
 * secret token) is exposed as `url` so a Worker can post to it without holding
 * the bot token at runtime.
 *
 * @see https://discord.com/developers/docs/resources/webhook
 *
 * @section Creating a Webhook
 * @example Notifications channel
 * ```typescript
 * const hook = yield* Discord.Webhook("triage-alerts", {
 *   channelId: "1099887766554433221",
 *   name: "Triage",
 * });
 * yield* Cloudflare.Worker(..., {
 *   vars: { DISCORD_WEBHOOK_URL: hook.url },
 * });
 * ```
 */
export const Webhook = Resource<Webhook>("Discord.Webhook");

interface WebhookResponse {
  id: string;
  type: number;
  channel_id: string;
  guild_id?: string | null;
  name: string;
  avatar: string | null;
  token: string;
  url?: string;
}

const toAttrs = (data: WebhookResponse) => ({
  webhookId: data.id,
  channelId: data.channel_id,
  guildId: data.guild_id ?? undefined,
  name: data.name,
  token: data.token,
  url: data.url ?? `https://discord.com/api/webhooks/${data.id}/${data.token}`,
});

export const WebhookProvider = () =>
  Provider.effect(
    Webhook,
    Effect.gen(function* () {
      return {
        stables: ["webhookId", "channelId", "guildId", "token", "url"],
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return undefined;
          if (output && news.channelId !== output.channelId) {
            return { action: "replace" } as const;
          }
          if (
            !olds ||
            news.name !== olds.name ||
            news.avatar !== olds.avatar
          ) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        create: Effect.fn(function* ({ news }) {
          const data = yield* discordFetch<WebhookResponse>(
            `/channels/${news.channelId}/webhooks`,
            {
              method: "POST",
              body: { name: news.name, avatar: news.avatar },
            },
          );
          return toAttrs(data);
        }),
        update: Effect.fn(function* ({ news, output }) {
          const data = yield* discordFetch<WebhookResponse>(
            `/webhooks/${output.webhookId}`,
            {
              method: "PATCH",
              body: { name: news.name, avatar: news.avatar },
            },
          );
          return toAttrs({ ...data, token: output.token });
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* discordFetch(`/webhooks/${output.webhookId}`, {
            method: "DELETE",
          }).pipe(Effect.catch(() => Effect.void));
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.webhookId) return undefined;
          return yield* discordFetch<WebhookResponse>(
            `/webhooks/${output.webhookId}`,
          ).pipe(
            Effect.map((data) =>
              toAttrs({ ...data, token: data.token ?? output.token }),
            ),
            Effect.catch(() => Effect.succeed(undefined)),
          );
        }),
      };
    }),
  );
