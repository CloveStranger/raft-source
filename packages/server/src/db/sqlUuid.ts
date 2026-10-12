import { sql, type SQL } from "drizzle-orm";

/** A canonical uuid in text form, any case (matches what Postgres' uuid input accepts for these ids). */
const UUID_TEXT_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

/**
 * `text` as a uuid, or NULL when it is not one. For joining a text column that
 * holds ids (sender_id, uploader_id, stored order elements, peer keys) to a
 * uuid primary key: compare `pk = sqlUuidOrNull(col)` instead of
 * `pk::text = col`, which hides the primary-key index and scans the table.
 *
 * The CASE is what makes the cast safe: SQL does not fix the evaluation order
 * of AND terms, so a type check next to a bare `col::uuid` could still let
 * the cast run on a non-uuid value such as 'system' and fail the statement.
 */
export function sqlUuidOrNull(text: SQL): SQL<string | null> {
  return sql<string | null>`(CASE WHEN ${text} ~* ${sql.raw(`'${UUID_TEXT_PATTERN}'`)} THEN (${text})::uuid END)`;
}
