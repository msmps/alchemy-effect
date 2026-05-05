import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as accounts from "@distilled.cloud/cloudflare/accounts";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { describe } from "node:test";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const randomSuffix = () => Math.random().toString(36).slice(2, 8);

describe.skip("AccountApiToken", () => {
  test.provider("create and delete account token with default props", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const token = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AccountApiToken("DefaultToken", {
            policies: [
              {
                effect: "allow",
                permissionGroups: ["Workers Scripts Read"],
                resources: {
                  [`com.cloudflare.api.account.${accountId}`]: "*",
                },
              },
            ],
          });
        }),
      );

      expect(token.tokenId).toBeDefined();
      expect(token.name).toBeDefined();
      expect(token.status).toEqual("active");
      expect(Redacted.value(token.value)).toMatch(/.+/);

      const actualToken = yield* accounts.getToken({
        accountId,
        tokenId: token.tokenId,
      });
      expect(actualToken.id).toEqual(token.tokenId);
      expect(actualToken.name).toEqual(token.name);

      yield* stack.destroy();

      yield* waitForTokenToBeDeleted(token.tokenId, accountId);
    }).pipe(logLevel),
  );

  test.provider("redeploy with same props is a no-op", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const props = {
        name: "alchemy-test-acct-noop",
        policies: [
          {
            effect: "allow" as const,
            permissionGroups: ["Workers Scripts Read" as const],
            resources: {
              [`com.cloudflare.api.account.${accountId}`]: "*",
            },
          },
        ],
      };

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AccountApiToken("NoopToken", props);
        }),
      );

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AccountApiToken("NoopToken", props);
        }),
      );

      // Same id, same secret value — confirms diff returned undefined
      // and reconcile didn't re-roll.
      expect(second.tokenId).toEqual(first.tokenId);
      expect(Redacted.value(second.value)).toEqual(Redacted.value(first.value));

      yield* stack.destroy();
    }).pipe(logLevel),
  );

  test.provider("update changes name and policies", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const token = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AccountApiToken("UpdateToken", {
            name: "alchemy-test-acct-update-initial",
            policies: [
              {
                effect: "allow",
                permissionGroups: ["Workers Scripts Read"],
                resources: {
                  [`com.cloudflare.api.account.${accountId}`]: "*",
                },
              },
            ],
          });
        }),
      );

      const initialValue = Redacted.value(token.value);

      // Name change forces replace; policies change is a regular update.
      // We exercise policies-only here so the secret value is preserved
      // (replace would mint a new one).
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AccountApiToken("UpdateToken", {
            name: "alchemy-test-acct-update-initial",
            policies: [
              {
                effect: "allow",
                permissionGroups: [
                  "Workers Scripts Read",
                  "Workers KV Storage Read",
                ],
                resources: {
                  [`com.cloudflare.api.account.${accountId}`]: "*",
                },
              },
            ],
          });
        }),
      );

      expect(updated.tokenId).toEqual(token.tokenId);
      expect(Redacted.value(updated.value)).toEqual(initialValue);

      const actual = yield* accounts.getToken({
        accountId,
        tokenId: updated.tokenId,
      });
      expect(actual.policies?.[0]?.permissionGroups.length).toEqual(2);

      yield* stack.destroy();

      yield* waitForTokenToBeDeleted(token.tokenId, accountId);
    }).pipe(logLevel),
  );

  test.provider(
    "reconcile resets permissions mutated out-of-band",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* CloudflareEnvironment;

        yield* stack.destroy();

        const desiredPolicies = [
          {
            effect: "allow" as const,
            permissionGroups: ["Workers Scripts Read" as const],
            resources: {
              [`com.cloudflare.api.account.${accountId}`]: "*",
            },
          },
        ];

        const token = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.AccountApiToken("DriftToken", {
              name: `alchemy-test-acct-drift-${randomSuffix()}`,
              policies: desiredPolicies,
            });
          }),
        );

        // Mutate the token out-of-band: add an extra permission group.
        yield* accounts.updateToken({
          accountId,
          tokenId: token.tokenId,
          name: token.name,
          policies: [
            {
              effect: "allow",
              permissionGroups: [
                { id: "82e64a83756745bbbb1c9c2701bf816b" }, // Workers Scripts Read
                { id: "f7f0eda5697f475c90846e879bab8666" }, // KV Read
              ],
              resources: {
                [`com.cloudflare.api.account.${accountId}`]: "*",
              },
            },
          ],
        });

        // Redeploy with the *same* desired props. Reconcile observes
        // the drifted live state and converges back to one permission.
        const reconciled = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.AccountApiToken("DriftToken", {
              name: token.name,
              policies: desiredPolicies,
            });
          }),
        );

        expect(reconciled.tokenId).toEqual(token.tokenId);
        const actual = yield* accounts.getToken({
          accountId,
          tokenId: token.tokenId,
        });
        expect(actual.policies?.[0]?.permissionGroups.length).toEqual(1);

        yield* stack.destroy();
        yield* waitForTokenToBeDeleted(token.tokenId, accountId);
      }).pipe(logLevel),
  );

  test.provider("rollKey rotation advances the secret value", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const baseProps = {
        name: `alchemy-test-acct-roll-${randomSuffix()}`,
        policies: [
          {
            effect: "allow" as const,
            permissionGroups: ["Workers Scripts Read" as const],
            resources: {
              [`com.cloudflare.api.account.${accountId}`]: "*",
            },
          },
        ],
      };

      const before = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AccountApiToken("RollToken", {
            ...baseProps,
            rollKey: "v1",
          });
        }),
      );
      const beforeValue = Redacted.value(before.value);

      const after = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AccountApiToken("RollToken", {
            ...baseProps,
            rollKey: "v2",
          });
        }),
      );

      expect(after.tokenId).toEqual(before.tokenId);
      expect(Redacted.value(after.value)).not.toEqual(beforeValue);

      yield* stack.destroy();
      yield* waitForTokenToBeDeleted(before.tokenId, accountId);
    }).pipe(logLevel),
  );

  test.provider("reconcile re-creates a token deleted out-of-band", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const physicalName = `alchemy-test-acct-recreate-${randomSuffix()}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AccountApiToken("RecreateToken", {
            name: physicalName,
            policies: [
              {
                effect: "allow",
                permissionGroups: ["Workers Scripts Read"],
                resources: {
                  [`com.cloudflare.api.account.${accountId}`]: "*",
                },
              },
            ],
          });
        }),
      );

      // Delete out-of-band.
      yield* accounts.deleteToken({
        accountId,
        tokenId: initial.tokenId,
      });

      const recreated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AccountApiToken("RecreateToken", {
            name: physicalName,
            policies: [
              {
                effect: "allow",
                permissionGroups: ["Workers Scripts Read"],
                resources: {
                  [`com.cloudflare.api.account.${accountId}`]: "*",
                },
              },
            ],
          });
        }),
      );

      expect(recreated.tokenId).not.toEqual(initial.tokenId);
      expect(recreated.name).toEqual(physicalName);

      yield* stack.destroy();
      yield* waitForTokenToBeDeleted(recreated.tokenId, accountId);
    }).pipe(logLevel),
  );

  test.provider("changing name triggers replace", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const policies = [
        {
          effect: "allow" as const,
          permissionGroups: ["Workers Scripts Read" as const],
          resources: {
            [`com.cloudflare.api.account.${accountId}`]: "*",
          },
        },
      ];

      const before = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AccountApiToken("RenameToken", {
            name: `alchemy-test-acct-before-${randomSuffix()}`,
            policies,
          });
        }),
      );

      const after = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AccountApiToken("RenameToken", {
            name: `alchemy-test-acct-after-${randomSuffix()}`,
            policies,
          });
        }),
      );

      expect(after.tokenId).not.toEqual(before.tokenId);
      // Old token gone (replace deletes after creating new).
      yield* waitForTokenToBeDeleted(before.tokenId, accountId);

      yield* stack.destroy();
      yield* waitForTokenToBeDeleted(after.tokenId, accountId);
    }).pipe(logLevel),
  );

  test.provider("destroying an already-deleted token is a no-op", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const token = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AccountApiToken("DoubleDestroyToken", {
            name: `alchemy-test-acct-double-${randomSuffix()}`,
            policies: [
              {
                effect: "allow",
                permissionGroups: ["Workers Scripts Read"],
                resources: {
                  [`com.cloudflare.api.account.${accountId}`]: "*",
                },
              },
            ],
          });
        }),
      );

      // Delete out-of-band, then destroy via engine — should not raise.
      yield* accounts.deleteToken({
        accountId,
        tokenId: token.tokenId,
      });

      yield* stack.destroy();
    }).pipe(logLevel),
  );

  test.provider("adopt(true) re-claims a foreign token", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const physicalName = `alchemy-test-acct-adopt-${randomSuffix()}`;

      // Phase 1: normal deploy creates the cloud token.
      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AccountApiToken("AdoptableToken", {
            name: physicalName,
            policies: [
              {
                effect: "allow",
                permissionGroups: ["Workers Scripts Read"],
                resources: {
                  [`com.cloudflare.api.account.${accountId}`]: "*",
                },
              },
            ],
          });
        }),
      );

      // Phase 2: wipe local state — the token survives on Cloudflare.
      yield* Effect.gen(function* () {
        const state = yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableToken",
        });
      }).pipe(Effect.provide(stack.state));

      // Phase 3: redeploy with `adopt(true)` so the engine takes over
      // the foreign-by-tags token discovered via `findTokenByName`.
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AccountApiToken("AdoptableToken", {
            name: physicalName,
            policies: [
              {
                effect: "allow",
                permissionGroups: ["Workers Scripts Read"],
                resources: {
                  [`com.cloudflare.api.account.${accountId}`]: "*",
                },
              },
            ],
          }).pipe(adopt(true));
        }),
      );

      expect(adopted.tokenId).toEqual(initial.tokenId);

      yield* stack.destroy();
      yield* waitForTokenToBeDeleted(initial.tokenId, accountId);
    }).pipe(logLevel),
  );

  const waitForTokenToBeDeleted = Effect.fn(function* (
    tokenId: string,
    accountId: string,
  ) {
    yield* accounts.getToken({ accountId, tokenId }).pipe(
      Effect.flatMap(() => Effect.fail(new TokenStillExists())),
      Effect.retry({
        while: (e): e is TokenStillExists => e instanceof TokenStillExists,
        schedule: Schedule.exponential(200).pipe(
          Schedule.both(Schedule.recurs(8)),
        ),
      }),
      Effect.catchTag("TokenStillExists", () =>
        Effect.die(
          `Cloudflare API token ${tokenId} was not deleted after retries`,
        ),
      ),
      Effect.catchTag("TokenNotFound", () => Effect.void),
      Effect.catchTag("InvalidRoute", () => Effect.void),
    );
  });
});
class TokenStillExists extends Data.TaggedError("TokenStillExists") {}
