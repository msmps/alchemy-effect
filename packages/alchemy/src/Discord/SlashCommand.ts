import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { discordFetch } from "./Credentials.ts";
import type { Providers } from "./Providers.ts";

export type SlashCommandOption = {
  type: number;
  name: string;
  description: string;
  required?: boolean;
  choices?: { name: string; value: string | number }[];
};

export type SlashCommandProps = {
  /** Discord application ID. */
  applicationId: string;
  /**
   * Optional guild ID. If omitted the command is registered globally
   * (rolls out within ~1h). Guild commands are instant.
   */
  guildId?: string;
  /** Command name, e.g. `triage`. Lowercase. */
  name: string;
  description: string;
  options?: SlashCommandOption[];
  /** Application command type. 1 = ChatInput (slash), 2 = User, 3 = Message. */
  type?: 1 | 2 | 3;
};

export type SlashCommand = Resource<
  "Discord.SlashCommand",
  SlashCommandProps,
  {
    commandId: string;
    applicationId: string;
    guildId: string | undefined;
    name: string;
    version: string;
  },
  never,
  Providers
>;

/**
 * A Discord application command (slash, user, or message command).
 *
 * @see https://discord.com/developers/docs/interactions/application-commands
 *
 * @section Registering a Command
 * @example Guild slash command
 * ```typescript
 * yield* Discord.SlashCommand("triage", {
 *   applicationId: app.applicationId,
 *   guildId: "999000111222",
 *   name: "triage",
 *   description: "Show open triage issues",
 *   options: [
 *     { type: 3, name: "status", description: "Filter by status",
 *       choices: [{ name: "open", value: "open" }, { name: "closed", value: "closed" }] },
 *   ],
 * });
 * ```
 */
export const SlashCommand = Resource<SlashCommand>("Discord.SlashCommand");

interface CommandResponse {
  id: string;
  application_id: string;
  guild_id?: string | null;
  name: string;
  version: string;
}

const commandPath = (props: {
  applicationId: string;
  guildId?: string;
}) =>
  props.guildId
    ? `/applications/${props.applicationId}/guilds/${props.guildId}/commands`
    : `/applications/${props.applicationId}/commands`;

const toAttrs = (data: CommandResponse) => ({
  commandId: data.id,
  applicationId: data.application_id,
  guildId: data.guild_id ?? undefined,
  name: data.name,
  version: data.version,
});

const buildBody = (news: SlashCommandProps) => ({
  name: news.name,
  description: news.description,
  options: news.options,
  type: news.type ?? 1,
});

export const SlashCommandProvider = () =>
  Provider.effect(
    SlashCommand,
    Effect.gen(function* () {
      return {
        stables: ["commandId", "applicationId"],
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return undefined;
          if (
            output &&
            (news.applicationId !== output.applicationId ||
              (news.guildId ?? undefined) !== (output.guildId ?? undefined) ||
              news.name !== output.name)
          ) {
            return { action: "replace" } as const;
          }
          if (
            !olds ||
            news.description !== olds.description ||
            JSON.stringify(news.options ?? []) !==
              JSON.stringify(olds.options ?? []) ||
            (news.type ?? 1) !== (olds.type ?? 1)
          ) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        create: Effect.fn(function* ({ news }) {
          const data = yield* discordFetch<CommandResponse>(commandPath(news), {
            method: "POST",
            body: buildBody(news),
          });
          return toAttrs(data);
        }),
        update: Effect.fn(function* ({ news, output }) {
          // Discord uses PATCH on `/<base>/<command_id>`; we can also POST
          // the same path which upserts by name. PATCH is the documented update.
          const data = yield* discordFetch<CommandResponse>(
            `${commandPath(news)}/${output.commandId}`,
            {
              method: "PATCH",
              body: buildBody(news),
            },
          );
          return toAttrs(data);
        }),
        delete: Effect.fn(function* ({ olds, output }) {
          yield* discordFetch(`${commandPath(olds)}/${output.commandId}`, {
            method: "DELETE",
          }).pipe(Effect.catch(() => Effect.void));
        }),
        read: Effect.fn(function* ({ olds, output }) {
          if (!output?.commandId) return undefined;
          return yield* discordFetch<CommandResponse>(
            `${commandPath(olds ?? output)}/${output.commandId}`,
          ).pipe(
            Effect.map(toAttrs),
            Effect.catch(() => Effect.succeed(undefined)),
          );
        }),
      };
    }),
  );
