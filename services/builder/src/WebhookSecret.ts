import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

/**
 * Webhook HMAC secret used by the builder service. GitHub does NOT
 * provide signing secrets — the caller mints one and hands the same
 * value to:
 *
 *   1. GitHub (when the webhook is created/updated, so it signs every
 *      delivery with `X-Hub-Signature-256`),
 *   2. The receiving worker (so it can verify the signature).
 *
 * Mirrors the {@link Cloudflare.StateStore} token pattern: a `Random`
 * value persisted in alchemy state, uploaded into the account-wide
 * `SecretsStore`, and bound into the worker.
 */

/**
 * The randomly generated secret value. Generated once on create and
 * persisted, so subsequent deploys keep the same value unless the
 * resource is replaced.
 */
export const WebhookSecretValue = Alchemy.Random("WebhookSecret");

/**
 * Account-wide Secrets Store that holds the worker-bound version of
 * the secret. Adopts the existing store if one is already on the
 * account, or creates one.
 */
export const WebhookSecretStore = Cloudflare.SecretsStore("BuilderSecrets");

export const WEBHOOK_SECRET_NAME = "BuilderGitHubWebhookSecret" as const;

/**
 * The Cloudflare Secret resource. Yield from the stack to ensure it's
 * deployed; yield from a worker init to bind it (`Cloudflare.Secret.bind`)
 * for runtime access.
 */
export const WebhookSecret = Effect.gen(function* () {
  const store = yield* WebhookSecretStore;
  const random = yield* WebhookSecretValue;
  return yield* Cloudflare.Secret(WEBHOOK_SECRET_NAME, {
    name: WEBHOOK_SECRET_NAME,
    store,
    value: random.text,
  });
});
