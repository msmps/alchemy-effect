import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

/**
 * Resolved Discord bot credentials. Used by Discord providers to authenticate
 * REST calls to https://discord.com/api/v10.
 */
export interface DiscordCredentialsService {
  /** Bot token, sent as `Authorization: Bot <token>`. */
  readonly token: Redacted.Redacted<string>;
}

export class DiscordCredentials extends Context.Service<
  DiscordCredentials,
  DiscordCredentialsService
>()("Discord::Credentials") {}

/**
 * Build a `DiscordCredentials` layer from a literal token. Useful when the
 * caller already holds a bot token.
 */
export const fromToken = (token: string | Redacted.Redacted<string>) =>
  Layer.succeed(DiscordCredentials, {
    token: typeof token === "string" ? Redacted.make(token) : token,
  });

/**
 * Build a `DiscordCredentials` layer that reads `DISCORD_BOT_TOKEN` from the
 * environment. Falls back to `DISCORD_TOKEN`.
 */
export const fromEnv = () =>
  Layer.effect(
    DiscordCredentials,
    Effect.gen(function* () {
      const bot = yield* Config.redacted("DISCORD_BOT_TOKEN").pipe(
        Config.option,
      );
      const generic = yield* Config.redacted("DISCORD_TOKEN").pipe(
        Config.option,
      );
      const token =
        bot._tag === "Some"
          ? bot.value
          : generic._tag === "Some"
            ? generic.value
            : undefined;
      if (!token) {
        return yield* Effect.die(
          new Error(
            "Discord credentials not found. Set DISCORD_BOT_TOKEN or DISCORD_TOKEN.",
          ),
        );
      }
      return { token };
    }).pipe(Effect.orDie),
  );

export const DISCORD_API_BASE = "https://discord.com/api/v10";

/**
 * Make an authenticated request to the Discord REST API. Returns parsed JSON
 * on success and dies with an `Error` containing the status + body on failure
 * (so callers don't need to plumb error channels through every lifecycle op).
 */
export const discordFetch = <T = unknown>(
  path: string,
  init: Omit<RequestInit, "body"> & { body?: any } = {},
) =>
  Effect.gen(function* () {
    const { token } = yield* DiscordCredentials;
    const headers: Record<string, string> = {
      Authorization: `Bot ${Redacted.value(token)}`,
      "User-Agent": "alchemy-discord/0 (+https://alchemy.run)",
      ...(init.headers as Record<string, string> | undefined),
    };
    const body =
      init.body !== undefined && typeof init.body !== "string"
        ? JSON.stringify(init.body)
        : (init.body as string | undefined);
    if (body !== undefined && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    const res = yield* Effect.tryPromise({
      try: () =>
        fetch(`${DISCORD_API_BASE}${path}`, {
          ...init,
          headers,
          body,
        }),
      catch: (cause) => new Error(`Discord request failed: ${String(cause)}`),
    });
    if (!res.ok) {
      const text = yield* Effect.tryPromise({
        try: () => res.text(),
        catch: () => new Error("failed to read Discord error body"),
      }).pipe(Effect.orElseSucceed(() => ""));
      return yield* Effect.die(
        new DiscordApiError(
          `Discord API ${init.method ?? "GET"} ${path} -> ${res.status} ${res.statusText}: ${text}`,
          res.status,
        ),
      );
    }
    if (res.status === 204) return undefined as T;
    return (yield* Effect.tryPromise({
      try: () => res.json() as Promise<T>,
      catch: (cause) =>
        new Error(`Failed to parse Discord JSON response: ${String(cause)}`),
    })) as T;
  });

export class DiscordApiError extends Error {
  readonly _tag = "DiscordApiError";
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}
