import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Drizzle from "@/Drizzle/index.ts";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Hyperdrive } from "../Stack.ts";
import { relations, Widgets } from "./schema.ts";

/**
 * Worker fixture exercising Cloudflare.Hyperdrive over Neon Postgres via
 * Drizzle's Effect-native client.
 */
export default class HyperdriveWorker extends Cloudflare.Worker<HyperdriveWorker>()(
  "NeonHyperdriveDrizzleWorker",
  {
    main: import.meta.filename,
    subdomain: { enabled: true },
  },
  Effect.gen(function* () {
    const conn = yield* Cloudflare.Hyperdrive.bind(Hyperdrive);
    const db = yield* Drizzle.postgres(conn.connectionString, { relations });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (request.method === "GET" && url.pathname === "/widgets") {
          const widgets = yield* db.select().from(Widgets);
          return yield* HttpServerResponse.json({ widgets });
        }

        if (request.method === "POST" && url.pathname === "/widgets") {
          const body = (yield* request.json) as { id: number; name: string };
          const [inserted] = yield* db
            .insert(Widgets)
            .values({ id: body.id, name: body.name })
            .onConflictDoUpdate({
              target: Widgets.id,
              set: { name: body.name },
            })
            .returning();
          return yield* HttpServerResponse.json({ widget: inserted });
        }

        const idMatch = url.pathname.match(/^\/widgets\/(\d+)$/);
        if (request.method === "DELETE" && idMatch) {
          const id = Number(idMatch[1]);
          const [deleted] = yield* db
            .delete(Widgets)
            .where(eq(Widgets.id, id))
            .returning();
          return yield* HttpServerResponse.json({ widget: deleted ?? null });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }).pipe(
        Effect.catchAll((cause) =>
          HttpServerResponse.json(
            { ok: false, error: String(cause) },
            { status: 500 },
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.HyperdriveBindingLive)),
) {}
