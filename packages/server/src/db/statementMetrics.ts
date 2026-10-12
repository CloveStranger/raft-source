import { dbQueryDuration, dbQueryErrorsTotal } from "../metrics";

// Statement metrics shared by the instrumented Postgres pools (index.ts) and the
// RisingWave pool (risingwave.ts). Kept apart from both so neither imports the
// other for it.

export type DbStatementKind = "select" | "insert" | "update" | "delete" | "transaction" | "unknown";

export function statementKindFromText(text: string | undefined): DbStatementKind {
  if (!text) return "unknown";
  const keyword = text.trimStart().match(/^[a-zA-Z]+/)?.[0]?.toLowerCase();
  switch (keyword) {
    case "select":
    case "with":
      return "select";
    case "insert":
      return "insert";
    case "update":
      return "update";
    case "delete":
      return "delete";
    case "begin":
    case "commit":
    case "rollback":
    case "savepoint":
      return "transaction";
    default:
      return "unknown";
  }
}

/** pg-pool's "no client within connectionTimeoutMillis" error. */
export function isPoolAcquireTimeoutError(error: unknown): boolean {
  return error instanceof Error && /timeout exceeded when trying to connect/i.test(error.message);
}

// SQLSTATEs worth their own series; everything else folds into "other" so the
// label stays bounded. Errors without a SQLSTATE (socket resets) are
// "no_sqlstate"; a pool that hands out no connection in time is "acquire_timeout".
const TRACKED_SQLSTATES = new Set(["57014", "40001", "40P01", "25006", "53300", "55P03", "57P01"]);

export function sqlstateLabel(err: unknown): string {
  if (isPoolAcquireTimeoutError(err)) return "acquire_timeout";
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== "string" || !/^[0-9][0-9A-Z]{4}$/.test(code)) return "no_sqlstate";
  if (TRACKED_SQLSTATES.has(code)) return code;
  if (code.startsWith("08")) return "08000";
  return "other";
}

export function observeStatement(label: string, statementKind: DbStatementKind, startMs: number, err?: unknown): void {
  dbQueryDuration.observe({ pool: label, statement: statementKind }, Math.max(0, Date.now() - startMs) / 1000);
  if (err) recordStatementError(label, err);
}

/** A failure with no statement to time, e.g. the pool gave no connection. */
export function recordStatementError(label: string, err: unknown): void {
  dbQueryErrorsTotal.inc({ pool: label, sqlstate: sqlstateLabel(err) });
}
