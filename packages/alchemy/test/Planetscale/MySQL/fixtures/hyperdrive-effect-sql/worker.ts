import * as MysqlClient from "@effect/sql-mysql2/MysqlClient";
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
 * Worker fixture exercising Cloudflare.Hyperdrive over Planetscale
 * MySQL via `@effect/sql-mysql2` directly — raw `sql\`...\`` templates,
 * no ORM.
 */
export default class HyperdriveWorker extends Cloudflare.Worker<HyperdriveWorker>()(
  "PlanetscaleMysqlEffectSqlWorker",
  {
    main: import.meta.filename,
    subdomain: { enabled: true },
  },
  Effect.gen(function* () {
    const hd = yield* Cloudflare.Hyperdrive.bind(Hyperdrive);
    const SqlLive = Layer.unwrapEffect(
      hd.connectionString.pipe(Effect.map((url) => MysqlClient.layer({ url }))),
    );

    return {
      fetch: Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (request.method === "GET" && url.pathname === "/widgets") {
          const widgets = yield* sql<Widget>`
            SELECT id, name FROM alchemy_mysql_widgets ORDER BY id
          `;
          return yield* HttpServerResponse.json({ widgets });
        }

        if (request.method === "POST" && url.pathname === "/widgets") {
          const body = (yield* request.json) as { id: number; name: string };
          yield* sql`
            INSERT INTO alchemy_mysql_widgets (id, name)
            VALUES (${body.id}, ${body.name})
            ON DUPLICATE KEY UPDATE name = VALUES(name)
          `;
          const [inserted] = yield* sql<Widget>`
            SELECT id, name FROM alchemy_mysql_widgets WHERE id = ${body.id}
          `;
          return yield* HttpServerResponse.json({ widget: inserted });
        }

        const idMatch = url.pathname.match(/^\/widgets\/(\d+)$/);
        if (request.method === "DELETE" && idMatch) {
          const id = Number(idMatch[1]);
          const [existing] = yield* sql<Widget>`
            SELECT id, name FROM alchemy_mysql_widgets WHERE id = ${id}
          `;
          yield* sql`DELETE FROM alchemy_mysql_widgets WHERE id = ${id}`;
          return yield* HttpServerResponse.json({ widget: existing ?? null });
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
