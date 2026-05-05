import * as accounts from "@distilled.cloud/cloudflare/accounts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import {
  buildConditionPayload,
  conditionFingerprint,
  observedCondition,
  observedPolicyFingerprint,
  policyFingerprint,
  resolvePolicies,
  type ApiTokenProps,
} from "./Common.ts";

export type AccountApiToken = Resource<
  "Cloudflare.AccountApiToken",
  ApiTokenProps,
  {
    tokenId: string;
    name: string;
    status: "active" | "disabled" | "expired";
    /**
     * The plaintext token value. Cloudflare returns this only once, on
     * creation, so we persist it here for downstream consumers (e.g. a
     * GitHub Actions secret).
     */
    value: Redacted.Redacted<string>;
    accountId: string;
    /**
     * Opaque marker for the most recent successful `rollKey`. Persisting
     * this lets the reconciler detect when the user has bumped `rollKey`
     * and trigger a `putTokenValue` rotation.
     */
    rolledFor?: string;
  },
  never,
  Providers
>;

/**
 * A Cloudflare account-owned API token (`POST /accounts/{account_id}/tokens`).
 *
 * Account-owned tokens are managed at the account level and persist
 * independently of any single user. Use these for CI tokens, third-party
 * integrations, or anywhere the token should outlive an individual user's
 * session.
 *
 * Creating account-owned tokens requires the caller to have the
 * `API Tokens > Write` account permission.
 *
 * @section Creating a Token
 * @example A token for managing Workers and KV from CI
 * ```typescript
 * const token = yield* Cloudflare.AccountApiToken("ci-token", {
 *   name: "my-ci-token",
 *   accountId,
 *   policies: [
 *     {
 *       effect: "allow",
 *       permissionGroups: [
 *         "Workers Scripts Write",
 *         "Workers KV Storage Write",
 *       ],
 *       resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
 *     },
 *   ],
 * });
 *
 * yield* GitHub.Secret("cf-api-token", {
 *   owner: "me",
 *   repository: "my-repo",
 *   name: "CLOUDFLARE_API_TOKEN",
 *   value: token.value,
 * });
 * ```
 *
 * @section Rotating a Token
 * @example Bump `rollKey` to mint a new secret value
 * ```typescript
 * const token = yield* Cloudflare.AccountApiToken("ci-token", {
 *   accountId,
 *   policies: [...],
 *   rollKey: "2025-05-01", // change this string to rotate the secret
 * });
 * ```
 */
export const AccountApiToken = Resource<AccountApiToken>(
  "Cloudflare.AccountApiToken",
);

type AccountApiTokenAttributes = AccountApiToken["Attributes"];

const resolveName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id }));
  });

export const AccountApiTokenProvider = () =>
  Provider.effect(
    AccountApiToken,
    Effect.gen(function* () {
      const { accountId: defaultAccountId } = yield* CloudflareEnvironment;
      const createToken = yield* accounts.createToken;
      const updateToken = yield* accounts.updateToken;
      const deleteToken = yield* accounts.deleteToken;
      const getToken = yield* accounts.getToken;
      const listTokens = yield* accounts.listTokens;
      const putTokenValue = yield* accounts.putTokenValue;

      const buildAttributes = (
        tokenData: {
          id?: string | null;
          name?: string | null;
          status?: "active" | "disabled" | "expired" | null;
        },
        value: Redacted.Redacted<string>,
        accountId: string,
        rolledFor: string | undefined,
      ): AccountApiTokenAttributes => ({
        tokenId: tokenData.id ?? "",
        name: tokenData.name ?? "",
        status: tokenData.status ?? "active",
        value,
        accountId,
        rolledFor,
      });

      // Iterate `listTokens` until the desired name is found or the pages
      // run out. Cloudflare returns 1-based page numbers; `perPage` capped
      // at 50 keeps individual responses small.
      const findTokenByName = (accountId: string, name: string) =>
        Effect.gen(function* () {
          const perPage = 50;
          let page = 1;
          while (true) {
            const response = yield* listTokens({
              accountId,
              page,
              perPage,
            });
            const match = response.result.find((t) => t.name === name);
            if (match) return match;
            const total = response.resultInfo.totalCount ?? 0;
            if (page * perPage >= total) return undefined;
            page += 1;
          }
        });

      return {
        stables: ["tokenId", "accountId"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          const newAccountId = news.accountId ?? defaultAccountId;
          const oldAccountId =
            output?.accountId ?? olds?.accountId ?? defaultAccountId;
          if (oldAccountId !== newAccountId) {
            return { action: "replace" } as const;
          }
          // Name changes replace: a token's name is part of its identity in
          // CI configs and audit logs. Forcing replace cleanly retires the
          // old token and mints a new one with a fresh secret value.
          const oldName = output?.name ?? (yield* resolveName(id, olds?.name));
          const newName = yield* resolveName(id, news.name);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          const oldPolicyFp = policyFingerprint(
            resolvePolicies(olds?.policies ?? []),
          );
          const newPolicyFp = policyFingerprint(resolvePolicies(news.policies));
          const oldCondFp = conditionFingerprint(olds?.condition);
          const newCondFp = conditionFingerprint(news.condition);
          if (
            oldPolicyFp !== newPolicyFp ||
            oldCondFp !== newCondFp ||
            (olds?.expiresOn ?? undefined) !== (news.expiresOn ?? undefined) ||
            (olds?.notBefore ?? undefined) !== (news.notBefore ?? undefined) ||
            (olds?.rollKey ?? undefined) !== (news.rollKey ?? undefined)
          ) {
            return { action: "update" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const accountId = news.accountId ?? defaultAccountId;
          const name = yield* resolveName(id, news.name);
          const desiredPolicies = resolvePolicies(news.policies);
          const desiredPolicyFp = policyFingerprint(desiredPolicies);
          const desiredCondFp = conditionFingerprint(news.condition);

          // Observe — fetch current state if we already know the token id.
          // Cloudflare reports a deleted token as `InvalidRoute` or
          // `TokenNotFound`; both mean "create from scratch".
          const observed = output?.tokenId
            ? yield* getToken({
                accountId: output.accountId,
                tokenId: output.tokenId,
              }).pipe(
                Effect.catchTag("InvalidRoute", () =>
                  Effect.succeed(undefined),
                ),
                Effect.catchTag("TokenNotFound", () =>
                  Effect.succeed(undefined),
                ),
              )
            : undefined;

          // Ensure — create if missing. Cloudflare returns the plaintext
          // token value exactly once on create, so we must persist it for
          // downstream consumers. There is no idempotency token here; if
          // a stale write produced an orphan we accept the duplicate over
          // the alternative of losing the secret value.
          if (observed === undefined) {
            const result = yield* createToken({
              accountId,
              name,
              policies: desiredPolicies,
              condition: buildConditionPayload(news.condition),
              expiresOn: news.expiresOn,
              notBefore: news.notBefore,
            });
            if (!result.value) {
              return yield* Effect.die(
                `Cloudflare did not return a value for token "${name}".`,
              );
            }
            return buildAttributes(
              result,
              Redacted.make(result.value),
              accountId,
              news.rollKey,
            );
          }

          // Sync — diff observed cloud state against desired and call
          // `updateToken` only if something actually drifted. The update
          // API replaces all mutable fields, so a single call resolves
          // any combination of name/policy/condition/window drift.
          const observedPolicyFp = observedPolicyFingerprint(
            observed.policies ?? null,
          );
          const observedCondFp = conditionFingerprint(
            observedCondition(observed.condition ?? null),
          );
          const observedExpires = observed.expiresOn ?? undefined;
          const observedNotBefore = observed.notBefore ?? undefined;
          const desiredExpires = news.expiresOn ?? undefined;
          const desiredNotBefore = news.notBefore ?? undefined;
          const policyDrift = observedPolicyFp !== desiredPolicyFp;
          const condDrift = observedCondFp !== desiredCondFp;
          const nameDrift = (observed.name ?? "") !== name;
          const windowDrift =
            observedExpires !== desiredExpires ||
            observedNotBefore !== desiredNotBefore;

          let current: typeof observed = observed;
          if (policyDrift || condDrift || nameDrift || windowDrift) {
            current = yield* updateToken({
              accountId,
              tokenId: output!.tokenId,
              name,
              policies: desiredPolicies,
              condition: buildConditionPayload(news.condition),
              expiresOn: news.expiresOn,
              notBefore: news.notBefore,
            });
          }

          // Sync — rotate the token's secret value when `rollKey`
          // changed since the last successful roll. Cloudflare's
          // PUT /tokens/{id}/value endpoint mints and returns a new
          // bearer; we replace `output.value` with the fresh Redacted.
          let value = output!.value;
          let rolledFor = output!.rolledFor;
          if (
            news.rollKey !== undefined &&
            news.rollKey !== output!.rolledFor
          ) {
            const newValue = yield* putTokenValue({
              accountId,
              tokenId: output!.tokenId,
              body: {},
            });
            if (!newValue) {
              return yield* Effect.die(
                `Cloudflare did not return a value when rolling token "${name}".`,
              );
            }
            value = Redacted.make(newValue);
            rolledFor = news.rollKey;
          } else if (news.rollKey === undefined) {
            // User cleared `rollKey`; forget the marker so a future
            // re-introduction with the same string still rolls.
            rolledFor = undefined;
          }

          return buildAttributes(current, value, accountId, rolledFor);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteToken({
            accountId: output.accountId,
            tokenId: output.tokenId,
          }).pipe(
            // Already gone — Cloudflare may report this as either an
            // `InvalidRoute` (token-id no longer routable) or a generic
            // `TokenNotFound`. Either is fine; we just want the resource gone.
            Effect.catchTag("InvalidRoute", () => Effect.void),
            Effect.catchTag("TokenNotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          // Fast path — we know the token id.
          if (output?.tokenId) {
            return yield* getToken({
              accountId: output.accountId,
              tokenId: output.tokenId,
            }).pipe(
              Effect.map((token) =>
                buildAttributes(
                  token,
                  output.value,
                  output.accountId,
                  output.rolledFor,
                ),
              ),
              Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)),
              Effect.catchTag("TokenNotFound", () =>
                Effect.succeed(undefined),
              ),
            );
          }
          // Discovery path — look up by deterministic physical name.
          // Cloudflare tokens have no tags, so the name is the only
          // ownership signal we have. If a token of that name exists
          // and was minted by us (name matches engine-generated form,
          // i.e. `olds?.name` is undefined and the auto-name resolves
          // to it), we silently adopt; otherwise we mark `Unowned` so
          // takeover requires `--adopt`.
          const accountId = olds?.accountId ?? defaultAccountId;
          const name = yield* resolveName(id, olds?.name);
          const match = yield* findTokenByName(accountId, name);
          if (!match) return undefined;
          // We have no value to populate — Cloudflare won't surface a
          // bearer for an existing token. Mark Unowned so the engine
          // forces the operator to opt in to adoption; on the next
          // reconcile we'll roll the secret if `rollKey` is set or
          // surface the absence of a value otherwise.
          const attrs = buildAttributes(
            match,
            // We don't have the bearer; preserve any cached value on
            // `output` (most likely undefined here since `output.tokenId`
            // was empty), otherwise fall back to an empty Redacted that
            // downstream consumers can detect.
            output?.value ?? Redacted.make(""),
            accountId,
            output?.rolledFor,
          );
          // No tag-based ownership — discovered tokens are foreign by
          // default. The engine routes silent adoption when the cached
          // `output.tokenId` matched, so reaching this branch means the
          // engine state lost the id and a token of that name pre-exists.
          return Unowned(attrs);
        }),
      };
    }),
  );
