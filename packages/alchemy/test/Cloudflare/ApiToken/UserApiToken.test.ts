import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as user from "@distilled.cloud/cloudflare/user";
import { describe, expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const randomSuffix = () => Math.random().toString(36).slice(2, 8);

describe.skip("UserApiToken", () => {
  test.provider("create and delete user token with default props", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const token = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.UserApiToken("DefaultUserToken", {
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

      const actualToken = yield* user.getToken({ tokenId: token.tokenId });
      expect(actualToken.id).toEqual(token.tokenId);
      expect(actualToken.name).toEqual(token.name);

      yield* stack.destroy();

      yield* waitForTokenToBeDeleted(token.tokenId);
    }).pipe(logLevel),
  );

  test.provider("redeploy with same props is a no-op", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const props = {
        name: "alchemy-test-user-noop",
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
          return yield* Cloudflare.UserApiToken("UserNoopToken", props);
        }),
      );

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.UserApiToken("UserNoopToken", props);
        }),
      );

      expect(second.tokenId).toEqual(first.tokenId);
      expect(Redacted.value(second.value)).toEqual(Redacted.value(first.value));

      yield* stack.destroy();
    }).pipe(logLevel),
  );

  test.provider("update changes policies", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const token = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.UserApiToken("UpdateUserToken", {
            name: "alchemy-test-user-update-initial",
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

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.UserApiToken("UpdateUserToken", {
            name: "alchemy-test-user-update-initial",
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

      const actual = yield* user.getToken({ tokenId: updated.tokenId });
      expect(actual.policies?.[0]?.permissionGroups.length).toEqual(2);

      yield* stack.destroy();

      yield* waitForTokenToBeDeleted(token.tokenId);
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
            return yield* Cloudflare.UserApiToken("UserDriftToken", {
              name: `alchemy-test-user-drift-${randomSuffix()}`,
              policies: desiredPolicies,
            });
          }),
        );

        yield* user.updateToken({
          tokenId: token.tokenId,
          name: token.name,
          policies: [
            {
              effect: "allow",
              permissionGroups: [
                { id: "82e64a83756745bbbb1c9c2701bf816b" },
                { id: "f7f0eda5697f475c90846e879bab8666" },
              ],
              resources: {
                [`com.cloudflare.api.account.${accountId}`]: "*",
              },
            },
          ],
        });

        const reconciled = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.UserApiToken("UserDriftToken", {
              name: token.name,
              policies: desiredPolicies,
            });
          }),
        );

        expect(reconciled.tokenId).toEqual(token.tokenId);
        const actual = yield* user.getToken({ tokenId: token.tokenId });
        expect(actual.policies?.[0]?.permissionGroups.length).toEqual(1);

        yield* stack.destroy();
        yield* waitForTokenToBeDeleted(token.tokenId);
      }).pipe(logLevel),
  );

  test.provider("rollKey rotation advances the secret value", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const baseProps = {
        name: `alchemy-test-user-roll-${randomSuffix()}`,
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
          return yield* Cloudflare.UserApiToken("UserRollToken", {
            ...baseProps,
            rollKey: "v1",
          });
        }),
      );
      const beforeValue = Redacted.value(before.value);

      const after = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.UserApiToken("UserRollToken", {
            ...baseProps,
            rollKey: "v2",
          });
        }),
      );

      expect(after.tokenId).toEqual(before.tokenId);
      expect(Redacted.value(after.value)).not.toEqual(beforeValue);

      yield* stack.destroy();
      yield* waitForTokenToBeDeleted(before.tokenId);
    }).pipe(logLevel),
  );

  test.provider("reconcile re-creates a token deleted out-of-band", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const physicalName = `alchemy-test-user-recreate-${randomSuffix()}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.UserApiToken("UserRecreateToken", {
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

      yield* user.deleteToken({ tokenId: initial.tokenId });

      const recreated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.UserApiToken("UserRecreateToken", {
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
      yield* waitForTokenToBeDeleted(recreated.tokenId);
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
          return yield* Cloudflare.UserApiToken("UserRenameToken", {
            name: `alchemy-test-user-before-${randomSuffix()}`,
            policies,
          });
        }),
      );

      const after = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.UserApiToken("UserRenameToken", {
            name: `alchemy-test-user-after-${randomSuffix()}`,
            policies,
          });
        }),
      );

      expect(after.tokenId).not.toEqual(before.tokenId);
      yield* waitForTokenToBeDeleted(before.tokenId);

      yield* stack.destroy();
      yield* waitForTokenToBeDeleted(after.tokenId);
    }).pipe(logLevel),
  );

  test.provider("destroying an already-deleted token is a no-op", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const token = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.UserApiToken("UserDoubleDestroyToken", {
            name: `alchemy-test-user-double-${randomSuffix()}`,
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

      yield* user.deleteToken({ tokenId: token.tokenId });

      yield* stack.destroy();
    }).pipe(logLevel),
  );

  test.provider("adopt(true) re-claims a foreign token", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const physicalName = `alchemy-test-user-adopt-${randomSuffix()}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.UserApiToken("UserAdoptableToken", {
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

      yield* Effect.gen(function* () {
        const state = yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "UserAdoptableToken",
        });
      }).pipe(Effect.provide(stack.state));

      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.UserApiToken("UserAdoptableToken", {
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
      yield* waitForTokenToBeDeleted(initial.tokenId);
    }).pipe(logLevel),
  );

  const waitForTokenToBeDeleted = Effect.fn(function* (tokenId: string) {
    yield* user.getToken({ tokenId }).pipe(
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
