import {
  PERMISSION_GROUPS_BY_NAME,
  type PermissionGroupName,
} from "./PermissionGroups.ts";

/**
 * Resource keys recognized by Cloudflare API token policies.
 *
 * Cloudflare requires the account ID to be embedded directly in the resource
 * key (e.g. `com.cloudflare.api.account.<accountId>`); pass the fully-qualified
 * key — no rewriting is performed.
 *
 * @see https://developers.cloudflare.com/fundamentals/api/reference/permissions/
 */
export type ApiTokenResourceKey =
  | `com.cloudflare.api.account.${string}`
  | `com.cloudflare.api.account.zone.${string}`
  | `com.cloudflare.edge.r2.bucket.${string}`
  | (string & {});

/**
 * A permission group reference: either a typed Cloudflare permission-group
 * name (resolved against the static catalog) or an explicit `{ id }` for
 * names that aren't in the catalog or have multiple scopes.
 */
export type ApiTokenPermissionGroupRef =
  | PermissionGroupName
  | { id: string; meta?: { key?: string; value?: string } };

export interface ApiTokenPolicy {
  effect: "allow" | "deny";
  permissionGroups: ApiTokenPermissionGroupRef[];
  resources: { [K in ApiTokenResourceKey]?: string };
}

export interface ApiTokenCondition {
  requestIp?: {
    in?: string[];
    notIn?: string[];
  };
}

export type ApiTokenProps = {
  /**
   * Token name. Defaults to a generated physical name based on the
   * resource's logical id, app name, and stage.
   */
  name?: string;
  /**
   * The Cloudflare account ID that owns this token. Defaults to the
   * account ID resolved from the ambient {@link CloudflareEnvironment}.
   */
  accountId?: string;
  /**
   * Access policies attached to the token. At least one policy is required
   * by Cloudflare.
   */
  policies: ApiTokenPolicy[];
  /** ISO 8601 expiration timestamp. */
  expiresOn?: string;
  /** ISO 8601 "not before" timestamp. */
  notBefore?: string;
  /** Optional usage conditions (e.g. IP allowlist). */
  condition?: ApiTokenCondition;
  /**
   * Rotate the token's secret value. Cloudflare returns the plaintext value
   * only once (on create), so to rotate it later we must call the
   * `roll` endpoint. Provide any opaque string here (e.g. an ISO date or
   * version label); when the value differs from the previously persisted
   * value, the next reconcile rolls the secret and stores the new
   * Redacted value in `output.value`.
   */
  rollKey?: string;
};

export type ResolvedPolicy = {
  effect: "allow" | "deny";
  permissionGroups: { id: string; meta?: { key?: string; value?: string } }[];
  resources: Record<string, unknown>;
};

export const resolvePermissionGroup = (ref: ApiTokenPermissionGroupRef) => {
  if (typeof ref === "string") {
    const group = PERMISSION_GROUPS_BY_NAME[ref];
    if (!group) {
      // Should be unreachable due to the typed union, but guard anyway in
      // case Cloudflare retires a name we still have in the catalog.
      throw new Error(
        `Unknown Cloudflare permission group: "${ref}". Pass an explicit { id } instead.`,
      );
    }
    return { id: group.id };
  }
  return ref.meta ? { id: ref.id, meta: ref.meta } : { id: ref.id };
};

const resolveResources = (
  resources: ApiTokenPolicy["resources"],
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(resources)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
};

export const resolvePolicies = (policies: ApiTokenPolicy[]): ResolvedPolicy[] =>
  policies.map((policy) => ({
    effect: policy.effect,
    permissionGroups: policy.permissionGroups.map(resolvePermissionGroup),
    resources: resolveResources(policy.resources),
  }));

export const policyFingerprint = (policies: ResolvedPolicy[]): string =>
  JSON.stringify(
    policies.map((p) => ({
      effect: p.effect,
      permissionGroups: [...p.permissionGroups]
        .map((g) => ({ id: g.id, meta: g.meta ?? null }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      resources: Object.keys(p.resources)
        .sort()
        .map((k) => [k, p.resources[k]]),
    })),
  );

export const conditionFingerprint = (
  condition: ApiTokenCondition | undefined,
): string =>
  JSON.stringify({
    in: [...(condition?.requestIp?.in ?? [])].sort(),
    notIn: [...(condition?.requestIp?.notIn ?? [])].sort(),
  });

/**
 * Compute a fingerprint of an *observed* token (`getToken` response)'s
 * policies. The observed shape is more permissive (nullable fields,
 * extra `id`/`name` on permission groups), so normalize before hashing
 * so we can compare with `policyFingerprint(resolvePolicies(...))`.
 */
export const observedPolicyFingerprint = (
  policies:
    | {
        effect: "allow" | "deny";
        permissionGroups: { id: string; meta?: unknown }[];
        resources: Record<string, unknown>;
      }[]
    | null
    | undefined,
): string =>
  policyFingerprint(
    (policies ?? []).map((p) => ({
      effect: p.effect,
      permissionGroups: p.permissionGroups.map((g) => {
        const meta = g.meta as
          | { key?: string; value?: string }
          | null
          | undefined;
        return meta && (meta.key !== undefined || meta.value !== undefined)
          ? {
              id: g.id,
              meta: {
                key: meta.key,
                value: meta.value,
              },
            }
          : { id: g.id };
      }),
      resources: p.resources ?? {},
    })),
  );

/**
 * Normalize an observed `condition` payload (which may have nullable
 * inner fields) to the shape `conditionFingerprint` expects.
 */
export const observedCondition = (
  condition:
    | {
        requestIp?:
          | { in?: string[] | null; notIn?: string[] | null }
          | null;
      }
    | null
    | undefined,
): ApiTokenCondition | undefined => {
  if (!condition?.requestIp) return undefined;
  const { in: ins, notIn } = condition.requestIp;
  return {
    requestIp: {
      in: ins ?? undefined,
      notIn: notIn ?? undefined,
    },
  };
};

export const buildConditionPayload = (
  condition: ApiTokenCondition | undefined,
) =>
  condition
    ? {
        requestIp: condition.requestIp
          ? {
              in: condition.requestIp.in,
              notIn: condition.requestIp.notIn,
            }
          : undefined,
      }
    : undefined;
