import * as PgClient from "@effect/sql-pg/PgClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Hyperdrive } from "../Stack.ts";

export interface Widget {
  id: number;
  name: string;
}

/**
 * Worker fixture exercising Cloudflare.Hyperdrive over Neon Postgres via
 * `@effect/sql-pg` directly — raw `sql\`...\`` templates, no ORM.
 */
export default class HyperdriveWorker extends Cloudflare.Worker<HyperdriveWorker>()(
  "NeonHyperdriveEffectSqlWorker",
  {
    main: import.meta.filename,
    subdomain: { enabled: true },
  },
  Effect.gen(function* () {
    const hd = yield* Cloudflare.Hyperdrive.bind(Hyperdrive);
    const SqlLive = Layer.unwrapEffect(
      hd.connectionString.pipe(Effect.map((url) => PgClient.layer({ url }))),
    );

    return {
      fetch: Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (request.method === "GET" && url.pathname === "/widgets") {
          const widgets = yield* sql<Widget>`
            SELECT id, name FROM alchemy_neon_widgets_sql ORDER BY id
          `;
          return yield* HttpServerResponse.json({ widgets });
        }

        if (request.method === "POST" && url.pathname === "/widgets") {
          const body = (yield* request.json) as { id: number; name: string };
          const [inserted] = yield* sql<Widget>`
            INSERT INTO alchemy_neon_widgets_sql (id, name)
            VALUES (${body.id}, ${body.name})
            ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
            RETURNING id, name
          `;
          return yield* HttpServerResponse.json({ widget: inserted });
        }

        const idMatch = url.pathname.match(/^\/widgets\/(\d+)$/);
        if (request.method === "DELETE" && idMatch) {
          const id = Number(idMatch[1]);
          const [deleted] = yield* sql<Widget>`
            DELETE FROM alchemy_neon_widgets_sql
            WHERE id = ${id}
            RETURNING id, name
          `;
          return yield* HttpServerResponse.json({ widget: deleted ?? null });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }).pipe(
        Effect.provide(SqlLive),
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
