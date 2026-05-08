/**
 * GitHub webhook signature verification utilities.
 *
 * GitHub signs every webhook delivery with an HMAC SHA-256 of the raw
 * request body using the shared secret configured on the webhook, and
 * sends the result in the `X-Hub-Signature-256` header (lowercased
 * hex, prefixed with `sha256=`). These helpers are runtime-agnostic —
 * they only depend on the Web Crypto API (available in Workers, Node
 * 18+, Deno, Bun).
 */

const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a[i]! ^ b[i]!;
  return result === 0;
};

const hexToBytes = (hex: string): Uint8Array => {
  if (hex.length % 2 !== 0) return new Uint8Array(0);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};

/**
 * Verify a GitHub webhook delivery's `X-Hub-Signature-256` header
 * against the raw body bytes using the shared webhook secret.
 *
 * @returns `true` iff the header is present, well-formed, and the
 *   computed HMAC SHA-256 matches in constant time.
 */
export const verifyWebhookSignature = async (
  secret: string,
  rawBody: string,
  signatureHeader: string | null,
): Promise<boolean> => {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const provided = hexToBytes(signatureHeader.slice("sha256=".length));
  if (provided.length !== 32) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, enc.encode(rawBody)),
  );
  return constantTimeEqual(provided, expected);
};
