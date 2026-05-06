import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Worker from "./src/Worker.ts";
import { WebhookSecret } from "./src/WebhookSecret.ts";

/**
 * Stack: a self-hosted CI service running on Cloudflare. Watches a single
 * GitHub repo for events, builds it in a Container, and runs coding-agent
 * tasks for review responses + release notes.
 *
 * The repo identifiers below must match the literal `REPO` constant in
 * `src/Worker.ts` — the worker source can't read this stack's resources,
 * so the (owner, name) pair is duplicated by design.
 */
const REPO = {
  owner: "alchemy-run",
  name: "alchemy-effect",
} as const;

export default Alchemy.Stack(
  "AlchemyBuilder",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    // The repository we watch (adopted — it already exists on GitHub).
    yield* GitHub.Repository("repo", {
      owner: REPO.owner,
      name: REPO.name,
      adopt: true,
    });

    // Mint (or look up) the webhook HMAC secret and upload it into the
    // account-wide Cloudflare Secrets Store. The same value is bound
    // into the worker for runtime signature verification AND embedded
    // in every `GitHub.Webhook` resource the runtime auto-creates from
    // `GitHub.on(...)` subscriptions.
    yield* WebhookSecret;

    const worker = yield* Worker;

    // SPA that talks to the API worker. Lives at the package root —
    // index.html + src/main.tsx — so Vite finds it with no rootDir.
    // The SPA reads the API URL from `localStorage` (or prompts on
    // first load) since `Cloudflare.Vite` doesn't currently take
    // build-time env vars; set it once after the first deploy.
    const web = yield* Cloudflare.Vite("Web");

    return {
      workerUrl: worker.url,
      webUrl: web.url,
    };
  }),
);
