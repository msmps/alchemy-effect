import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import Api from "./Api.ts";
import { TokenValue } from "./Token.ts";

export default Alchemy.Stack(
  "CloudflareStateStore",
  {
    providers: Cloudflare.providers(),
  },
  Effect.gen(function* () {
    const token = yield* TokenValue;
    const api = yield* Api;

    // Surface the bearer token so tests and clients can authenticate
    // after deploy. The underlying value lives in the Cloudflare
    // Secrets Store; this output carries the same generated string.
    return {
      url: api.url.as<string>(),
      authToken: token.text.pipe(Output.map(Redacted.value)),
    };
  }),
);
