import assert from "node:assert/strict";
import { test } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { sqlUuidOrNull } from "./sqlUuid";

test("sqlUuidOrNull casts uuid-shaped text and yields NULL for anything else, without failing", async () => {
  const client = new PGlite();
  try {
    const dialect = new PgDialect();
    const uuid = "3e7ddb22-ab4a-45ab-9e75-c71502a6bb09";
    const inputs = [uuid, uuid.toUpperCase(), "system", "", "not-a-uuid", `${uuid}-extra`, " " + uuid, null];
    const query = dialect.sqlToQuery(sql`
      SELECT input.ord, ${sqlUuidOrNull(sql.raw("input.value"))}::text AS id
      FROM (VALUES ${sql.join(inputs.map((value, ord) => sql`(${ord}::int, ${value}::text)`), sql`, `)}) AS input(ord, value)
      ORDER BY input.ord
    `);
    const result = await client.query<{ id: string | null }>(query.sql, query.params);
    assert.deepEqual(result.rows.map((row) => row.id), [uuid, uuid, null, null, null, null, null, null]);
  } finally {
    await client.close();
  }
});
