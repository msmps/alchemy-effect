import { readFile } from "node:fs/promises";
import tls from "node:tls";

// `workerd`'s `trustBrowserCas` should probably be named `trustSystemCas`.
// Rather than using a bundled CA store like Node, it uses
// `SSL_CTX_set_default_verify_paths()` to use the system CA store:
// https://github.com/capnproto/capnproto/blob/6e26d260d1d91e0465ca12bbb5230a1dfa28f00d/c%2B%2B/src/kj/compat/tls.c%2B%2B#L745
// Unfortunately, this doesn't work on Windows. Luckily, Node exposes its own
// bundled CA store's certificates, so we just use those.
export const trustedCertificates =
  process.platform === "win32" ? Array.from(tls.rootCertificates) : [];

if (process.env.NODE_EXTRA_CA_CERTS !== undefined) {
  // Try load extra CA certs if defined, ignoring errors. Node will log a
  // warning if it fails to load this anyway. Note, this we only load this once
  // at process startup to match Node's behaviour:
  // https://nodejs.org/api/cli.html#node_extra_ca_certsfile
  try {
    const extra = await readFile(process.env.NODE_EXTRA_CA_CERTS, "utf8");
    // Split bundle into individual certificates and add each individually:
    // https://github.com/cloudflare/miniflare/pull/587/files#r1271579671
    const certs = extra.match(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
    );

    if (certs !== null) {
      trustedCertificates.push(...certs);
    }
  } catch {}
}
