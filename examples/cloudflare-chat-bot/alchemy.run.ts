import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Worker from "./src/Worker.ts";

/**
 * A minimal chat-bot stack:
 *
 * - `Worker` — backend that exposes `/api/chat`, `/api/messages`, `/api/reset`
 *   and hosts the `ChatAgent` Durable Object (one persisted chat per session).
 * - `Website` — Vite-built React SPA that talks to the worker over HTTP. The
 *   worker's URL is injected at build time as `VITE_API_URL`.
 */
export default Alchemy.Stack(
  "CloudflareChatBot",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Worker;

    const website = yield* Cloudflare.Vite("Website", {
      env: {
        VITE_API_URL: worker.url.as<string>(),
      },
    });

    return {
      apiUrl: worker.url.as<string>(),
      websiteUrl: website.url.as<string>(),
    };
  }),
);
