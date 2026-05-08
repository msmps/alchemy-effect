import * as Layer from "effect/Layer";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileLive } from "../Auth/Profile.ts";
import * as Provider from "../Provider.ts";
import { GitHubAuth } from "./AuthProvider.ts";
import { Comment, CommentProvider } from "./Comment.ts";
import * as Credentials from "./Credentials.ts";
import { Secret, SecretProvider } from "./Secret.ts";
import { Variable, VariableProvider } from "./Variable.ts";
import { Webhook, WebhookProvider } from "./Webhook.ts";

export { GitHubCredentials } from "./Credentials.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "GitHub",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * GitHub providers (Comment, Secret, Variable, Webhook) plus the GitHub
 * AuthProvider that `alchemy login` discovers. Runtime binding policies
 * (e.g. `CreateCommentPolicy`, `UpdateCommentPolicy`) are runtime-
 * specific and registered alongside each runtime's Providers — see
 * `packages/alchemy/src/Cloudflare/GitHub/Webhooks.ts`.
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([Comment, Secret, Variable, Webhook]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        CommentProvider(),
        SecretProvider(),
        VariableProvider(),
        WebhookProvider(),
      ),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(GitHubAuth),
    Layer.provideMerge(ProfileLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
