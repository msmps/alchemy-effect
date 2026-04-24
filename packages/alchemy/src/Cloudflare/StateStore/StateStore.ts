import * as Cloudflare from "alchemy/Cloudflare";
import type { ReplacedResourceState, ResourceState } from "alchemy/State";
import { encodeState } from "alchemy/State";
import * as Effect from "effect/Effect";
import { EncryptionKey } from "./Token.ts";

/**
 * A Durable Object whose storage layout depends on which name the
 * worker addresses:
 *
 * - `getByName("__root__")` — root index. Stores `s:<stackName>`
 *   marker keys so `listStacks` has a quick lookup. No resource
 *   state ever lives here.
 * - `getByName("<stackName>")` — per-stack storage. Keys shaped as
 *   `r<NUL><stage><NUL><fqn>` hold the encrypted `ResourceState`.
 *
 * Both instances share the same method surface; the worker is
 * responsible for calling the right methods on the right instance
 * (see `src/Api.ts`).
 *
 * Values are encrypted with AES-CTR using a 256-bit key pulled from
 * the Cloudflare Secrets Store. There is one shared key across all
 * readers and writers, so AES-CTR's confidentiality guarantee is
 * sufficient — an authenticated cipher (GCM) would only add overhead
 * without a meaningful threat model. A fresh 16-byte nonce is
 * prepended to each ciphertext so updates never reuse a
 * (key, counter) pair.
 *
 * `Redacted<T>` values round-trip via {@link encodeState} so secrets
 * stored in state come back as `{ __redacted__: … }` envelopes the
 * client can revive with `alchemy/State`'s `reviveState` helper.
 */
export default class StateStore extends Cloudflare.DurableObjectNamespace<StateStore>()(
  "StateStore",
  Effect.gen(function* () {
    // Outer (class-level) phase — resolve the binding factory once.
    // The actual secret read happens inside each DO instance below,
    // since `SecretClient.get()` needs the per-instance worker env.
    const encryptionSecret = yield* Cloudflare.Secret.bind(EncryptionKey);

    return Effect.gen(function* () {
      // Inner (per-instance) phase — set up storage and the AES key.
      // The key is imported once per DO boot and reused thereafter.
      const doState = yield* Cloudflare.DurableObjectState;
      const storage = doState.storage;

      const keyHex = yield* encryptionSecret.get().pipe(Effect.orDie);
      const cryptoKey = yield* Effect.tryPromise({
        try: () =>
          crypto.subtle.importKey(
            "raw",
            hexToBytes(keyHex),
            { name: "AES-CTR" },
            false,
            ["encrypt", "decrypt"],
          ),
        catch: (e) => e as Error,
      }).pipe(Effect.orDie);

      const encryptValue = (value: ResourceState) =>
        Effect.tryPromise({
          try: async (): Promise<string> => {
            const plaintext = new TextEncoder().encode(
              JSON.stringify(encodeState(value)),
            );
            const counter = crypto.getRandomValues(allocBytes(NONCE_BYTES));
            const ct = new Uint8Array(
              await crypto.subtle.encrypt(
                { name: "AES-CTR", counter, length: 64 },
                cryptoKey,
                plaintext,
              ),
            );
            // Frame as a single base64 string: nonce || ciphertext.
            const framed = allocBytes(counter.byteLength + ct.byteLength);
            framed.set(counter, 0);
            framed.set(ct, counter.byteLength);
            return toB64(framed);
          },
          catch: (e) => e as Error,
        }).pipe(Effect.orDie);

      // Decrypt and JSON-parse without a reviver: the DO emits the
      // on-wire envelope (`{ __redacted__: ... }` etc.) unchanged so
      // the HTTP client can revive it locally into real `Redacted<T>`
      // values. Reviving here would turn the envelope into a `Redacted`
      // instance that `JSON.stringify` — used by the worker to build
      // the HTTP response — flattens to the `"<redacted>"` placeholder,
      // leaking precisely the value the wrapper is meant to protect.
      const decryptEntry = (entry: string) =>
        Effect.tryPromise({
          try: async (): Promise<ResourceState> => {
            const framed = fromB64(entry);
            const counter = framed.slice(0, NONCE_BYTES);
            const ciphertext = framed.slice(NONCE_BYTES);
            const pt = await crypto.subtle.decrypt(
              { name: "AES-CTR", counter, length: 64 },
              cryptoKey,
              ciphertext,
            );
            return JSON.parse(new TextDecoder().decode(pt)) as ResourceState;
          },
          catch: (e) => e as Error,
        }).pipe(Effect.orDie);

      return {
        // -- Root DO methods -----------------------------------------

        /**
         * (Root DO only) List every stack name ever registered.
         */
        listStacks: () =>
          Effect.gen(function* () {
            const entries = yield* storage.list<number>({
              prefix: STACK_INDEX_PREFIX,
            });
            const stacks: string[] = [];
            for (const key of entries.keys()) {
              stacks.push(key.slice(STACK_INDEX_PREFIX.length));
            }
            return stacks;
          }),

        /**
         * (Root DO only) Register a stack name. Idempotent — safe to
         * call on every `set` to the corresponding stack DO.
         */
        registerStack: ({ stack }: { stack: string }) =>
          storage.put(`${STACK_INDEX_PREFIX}${stack}`, 1),

        // -- Stack DO methods ----------------------------------------

        /** (Stack DO only) List stages with at least one resource. */
        listStages: () =>
          Effect.gen(function* () {
            const entries = yield* storage.list<string>({
              prefix: RESOURCE_PREFIX,
            });
            const stages = new Set<string>();
            for (const key of entries.keys()) {
              const parsed = parseResourceKey(key);
              if (parsed) stages.add(parsed.stage);
            }
            return [...stages];
          }),

        /** (Stack DO only) List every resource FQN in a stage. */
        list: ({ stage }: { stage: string }) =>
          Effect.gen(function* () {
            const entries = yield* storage.list<string>({
              prefix: stagePrefix(stage),
            });
            const fqns: string[] = [];
            for (const key of entries.keys()) {
              const parsed = parseResourceKey(key);
              if (parsed) fqns.push(parsed.fqn);
            }
            return fqns;
          }),

        /**
         * (Stack DO only) Get a resource by (stage, fqn). Returns
         * null if missing.
         */
        get: ({ stage, fqn }: { stage: string; fqn: string }) =>
          Effect.gen(function* () {
            const entry = yield* storage.get<string>(resourceKey(stage, fqn));
            if (!entry) return null;
            return yield* decryptEntry(entry);
          }),

        /**
         * (Stack DO only) Persist a resource. Returns the stored
         * value unchanged.
         */
        set: ({
          stage,
          fqn,
          value,
        }: {
          stage: string;
          fqn: string;
          value: ResourceState;
        }) =>
          Effect.gen(function* () {
            const encrypted = yield* encryptValue(value);
            yield* storage.put<string>(resourceKey(stage, fqn), encrypted);
            return value;
          }),

        /**
         * (Stack DO only) Delete a resource. Idempotent.
         *
         * Exposed as `remove` (not `delete`) because Cloudflare's
         * Durable Object RPC stub reserves `delete` and refuses to
         * proxy the call, surfacing as "RPC receiver does not
         * implement the method 'delete'".
         */
        remove: ({ stage, fqn }: { stage: string; fqn: string }) =>
          Effect.gen(function* () {
            yield* storage.delete(resourceKey(stage, fqn));
          }),

        /**
         * (Stack DO only) Return every resource in a stage whose
         * `status === "replaced"`. Each entry is decrypted so the
         * `status` field can be inspected.
         */
        getReplacedResources: ({ stage }: { stage: string }) =>
          Effect.gen(function* () {
            const entries = yield* storage.list<string>({
              prefix: stagePrefix(stage),
            });
            const replaced: ReplacedResourceState[] = [];
            for (const entry of entries.values()) {
              if (!entry) continue;
              const decoded = yield* decryptEntry(entry);
              if (decoded?.status === "replaced") {
                replaced.push(decoded as ReplacedResourceState);
              }
            }
            return replaced;
          }),
      };
    });
  }),
) {
  /**
   * Well-known DO name whose sole job is to track the set of stacks
   * that have ever had resources written. `listStacks` queries it;
   * every `set` asks it to register the stack (idempotent).
   */
  static readonly ROOT_DO_NAME = "__root__" as const;
}

/** NUL byte separator for composite keys. */
const SEP = "\x00";

/** Key prefix for resource entries in a stack DO. */
const RESOURCE_PREFIX = `r${SEP}`;

/** Key prefix for stack-index entries in the root DO. */
const STACK_INDEX_PREFIX = "s:";

/** AES-CTR counter block length. */
const NONCE_BYTES = 16;

/** Build the resource key inside a *stack DO*. */
const resourceKey = (stage: string, fqn: string) =>
  `${RESOURCE_PREFIX}${stage}${SEP}${fqn}`;

/** Prefix matching every resource key inside a specific stage. */
const stagePrefix = (stage: string) => `${RESOURCE_PREFIX}${stage}${SEP}`;

/**
 * Parse a resource key back into its (stage, fqn) tuple. Returns
 * undefined for keys that do not match the expected shape.
 */
const parseResourceKey = (
  key: string,
): { stage: string; fqn: string } | undefined => {
  if (!key.startsWith(RESOURCE_PREFIX)) return undefined;
  const rest = key.slice(RESOURCE_PREFIX.length);
  const sep = rest.indexOf(SEP);
  if (sep < 0) return undefined;
  return { stage: rest.slice(0, sep), fqn: rest.slice(sep + 1) };
};

/**
 * Allocate a `Uint8Array` over a fresh `ArrayBuffer` (not shared) so
 * the resulting buffer satisfies Web Crypto's `BufferSource` type
 * constraint under strict DOM typings.
 */
const allocBytes = (size: number): Uint8Array<ArrayBuffer> =>
  new Uint8Array(new ArrayBuffer(size));

const toB64 = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.byteLength; i++)
    s += String.fromCharCode(bytes[i]!);
  return btoa(s);
};

const fromB64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s);
  const bytes = allocBytes(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

const hexToBytes = (hex: string): Uint8Array<ArrayBuffer> => {
  const bytes = allocBytes(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};
