import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { discordFetch } from "./Credentials.ts";
import type { Providers } from "./Providers.ts";

export type ApplicationProps = {
  /**
   * The Discord application (bot) ID. The application itself is created
   * out-of-band in the Discord Developer Portal — this resource just
   * imports it into the stack and validates it exists.
   */
  applicationId: string;
};

export type Application = Resource<
  "Discord.Application",
  ApplicationProps,
  {
    applicationId: string;
    name: string;
    description: string;
  },
  never,
  Providers
>;

/**
 * A Discord Application (bot) imported into the stack by ID.
 *
 * Discord Applications must be created in the
 * [Developer Portal](https://discord.com/developers/applications) — the API
 * has no public "create application" endpoint. This resource simply records
 * the application ID so other Discord resources can reference it, and
 * validates the bot token has access on create/read.
 *
 * @section Importing an Application
 * @example By ID
 * ```typescript
 * const app = yield* Discord.Application("Triage", {
 *   applicationId: "1234567890",
 * });
 * ```
 */
export const Application = Resource<Application>("Discord.Application");

interface ApplicationResponse {
  id: string;
  name: string;
  description: string;
}

const fetchApplication = (_id: string) =>
  // Discord doesn't expose a public "fetch arbitrary application by id" GET
  // unless you own the OAuth credentials; the `@me` route returns the
  // application owning the bot token, which is what we want for credential
  // validation.
  discordFetch<ApplicationResponse>(`/oauth2/applications/@me`);

export const ApplicationProvider = () =>
  Provider.effect(
    Application,
    Effect.gen(function* () {
      return {
        stables: ["applicationId"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (olds && olds.applicationId !== news.applicationId) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        create: Effect.fn(function* ({ news }) {
          const app = yield* fetchApplication(news.applicationId);
          return {
            applicationId: news.applicationId,
            name: app.name,
            description: app.description,
          };
        }),
        update: Effect.fn(function* ({ news, output }) {
          const app = yield* fetchApplication(news.applicationId).pipe(
            Effect.catch(() =>
              Effect.succeed({
                id: news.applicationId,
                name: output.name,
                description: output.description,
              }),
            ),
          );
          return {
            applicationId: news.applicationId,
            name: app.name,
            description: app.description,
          };
        }),
        delete: () => Effect.void,
        read: Effect.fn(function* ({ output }) {
          if (!output?.applicationId) return undefined;
          return yield* fetchApplication(output.applicationId).pipe(
            Effect.map((app) => ({
              applicationId: output.applicationId,
              name: app.name,
              description: app.description,
            })),
            Effect.catch(() => Effect.succeed(undefined)),
          );
        }),
      };
    }),
  );
