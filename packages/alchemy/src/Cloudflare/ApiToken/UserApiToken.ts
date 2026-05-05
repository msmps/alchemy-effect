import * as user from "@distilled.cloud/cloudflare/user";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
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

export type UserApiToken = Resource<
  "Cloudflare.UserApiToken",
  ApiTokenProps,
  {
    tokenId: string;
    name: string;
    status: "active" | "disabled" | "expired";
    /**
     * The plaintext token value. Cloudflare returns this only once, on
     * creation, so we persist it here for downstream consumers.
     */
    value: Redacted.Redacted<string>;
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
 * A Cloudflare user-owned API token (`POST /user/tokens`).
 *
 * User-owned tokens are tied to the authenticated user's identity. They can
 * be created by any authenticated user (including OAuth-derived sessions
 * from `alchemy login`) without needing the account-level
 * `API Tokens > Write` permission, but they are also revoked if the user
 * leaves the account.
 *
 * For CI tokens, prefer {@link AccountApiToken} so the token survives
 * personnel changes.
 *
 * Policy `resources` are passed through verbatim — no `accountId` rewriting
 * is performed because user tokens aren't bound to a single account.
 *
 * @section Creating a Token
 * @example A token bound to the authenticated user
 * ```typescript
 * const token = yield* Cloudflare.UserApiToken("personal-token", {
 *   name: "my-personal-token",
 *   policies: [
 *     {
 *       effect: "allow",
 *       permissionGroups: ["Workers Scripts Read"],
 *       resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
 *     },
 *   ],
 * });
 * ```
 *
 * @section Rotating a Token
 * @example Bump `rollKey` to mint a new secret value
 * ```typescript
 * const token = yield* Cloudflare.UserApiToken("personal-token", {
 *   policies: [...],
 *   rollKey: "2025-05-01", // change this string to rotate the secret
 * });
 * ```
 */
export const UserApiToken = Resource<UserApiToken>("Cloudflare.UserApiToken");

type UserApiTokenAttributes = UserApiToken["Attributes"];

const resolveName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id }));
  });

export const UserApiTokenProvider = () =>
  Provider.effect(
    UserApiToken,
    Effect.gen(function* () {
      const createToken = yield* user.createToken;
      const updateToken = yield* user.updateToken;
      const deleteToken = yield* user.deleteToken;
      const getToken = yield* user.getToken;
      const listTokens = yield* user.listTokens;
      const putTokenValue = yield* user.putTokenValue;

      const buildAttributes = (
        tokenData: {
          id?: string | null;
          name?: string | null;
          status?: "active" | "disabled" | "expired" | null;
        },
        value: Redacted.Redacted<string>,
        rolledFor: string | undefined,
      ): UserApiTokenAttributes => ({
        tokenId: tokenData.id ?? "",
        name: tokenData.name ?? "",
        status: tokenData.status ?? "active",
        value,
        rolledFor,
      });

      const findTokenByName = (name: string) =>
        Effect.gen(function* () {
          const perPage = 50;
          let page = 1;
          while (true) {
            const response = yield* listTokens({ page, perPage });
            const match = response.result.find((t) => t.name === name);
            if (match) return match;
            const total = response.resultInfo.totalCount ?? 0;
            if (page * perPage >= total) return undefined;
            page += 1;
          }
        });

      return {
        stables: ["tokenId"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return undefined;
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
          const name = yield* resolveName(id, news.name);
          const desiredPolicies = resolvePolicies(news.policies);
          const desiredPolicyFp = policyFingerprint(desiredPolicies);
          const desiredCondFp = conditionFingerprint(news.condition);

          // Observe — fetch current state if we know the token id;
          // Cloudflare reports a deleted token as `TokenNotFound`, which
          // we treat as "create from scratch".
          const observed = output?.tokenId
            ? yield* getToken({ tokenId: output.tokenId }).pipe(
                Effect.catchTag("TokenNotFound", () =>
                  Effect.succeed(undefined),
                ),
                Effect.catchTag("InvalidRoute", () =>
                  Effect.succeed(undefined),
                ),
              )
            : undefined;

          // Ensure — create if missing. Cloudflare returns the plaintext
          // token value exactly once on create, so we must persist it.
          // No idempotency token is available; we accept a duplicate over
          // losing the secret value.
          if (observed === undefined) {
            const result = yield* createToken({
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
              news.rollKey,
            );
          }

          // Sync — diff observed cloud state against desired and call
          // `updateToken` only if something actually drifted.
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
              tokenId: output!.tokenId,
              name,
              policies: desiredPolicies,
              condition: buildConditionPayload(news.condition),
              expiresOn: news.expiresOn,
              notBefore: news.notBefore,
            });
          }

          // Sync — rotate the token's secret value when `rollKey`
          // changed since the last successful roll.
          let value = output!.value;
          let rolledFor = output!.rolledFor;
          if (
            news.rollKey !== undefined &&
            news.rollKey !== output!.rolledFor
          ) {
            const newValue = yield* putTokenValue({
              tokenId: output!.tokenId,
            });
            if (!newValue) {
              return yield* Effect.die(
                `Cloudflare did not return a value when rolling token "${name}".`,
              );
            }
            value = Redacted.make(newValue);
            rolledFor = news.rollKey;
          } else if (news.rollKey === undefined) {
            rolledFor = undefined;
          }

          return buildAttributes(current, value, rolledFor);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteToken({ tokenId: output.tokenId }).pipe(
            Effect.catchTag("TokenNotFound", () => Effect.void),
            Effect.catchTag("InvalidRoute", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          if (output?.tokenId) {
            return yield* getToken({ tokenId: output.tokenId }).pipe(
              Effect.map((token) =>
                buildAttributes(token, output.value, output.rolledFor),
              ),
              Effect.catchTag("TokenNotFound", () =>
                Effect.succeed(undefined),
              ),
              Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)),
            );
          }
          const name = yield* resolveName(id, olds?.name);
          const match = yield* findTokenByName(name);
          if (!match) return undefined;
          const attrs = buildAttributes(
            match,
            output?.value ?? Redacted.make(""),
            output?.rolledFor,
          );
          return Unowned(attrs);
        }),
      };
    }),
  );
