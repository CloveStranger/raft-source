import pg from "pg";
import { attachPoolClientErrorHandler } from "./pgPoolErrorHandler";
import { performance } from "node:perf_hooks";
import { recordExternalSinkInsideTransaction } from "./ambientTransaction";
import { isPoolAcquireTimeoutError, observeStatement, recordStatementError, statementKindFromText } from "./statementMetrics";

export { isPoolAcquireTimeoutError };

export const RISINGWAVE_UNREAD_INBOX_CONTRACT_VERSION = 2;
/**
 * The unified chain's reader-facing views. Every reader of one request-path -- the
 * Activity list, the Activity badge, the mobile push badge, agent recovery and the
 * sidebar -- takes its views from this ONE set, so no two of them can count by
 * different rules. There is no generation switch: rolling back is a deploy revert.
 *
 * The totals are stacked ON the serving view on purpose (tygg's ruling
 * 2026-09-20): they inherit every serving predicate (mention-only zeroing, target
 * kinds, watermark, free-tier cutoff) by construction, so a badge is
 * definitionally the sum of what its list shows. Rebuild scripts must carry this
 * dependent.
 *
 * The set is the chain on mention v6 (infra/risingwave/sql/067-mention-v6.sql;
 * consumers first in 068-chain-mention-v6-consumers.sql, now
 * 076-cursor-decouple-consumers.sql), carrying the v5 semantics
 * (infra/risingwave/sql/063-chain-v5.sql: mute acts at admission, the watermark is
 * per (receiver, server), every (user, server) membership has a totals row).
 * message_mentions.channel_id of a joint conversation is the SENDER's local
 * projection while the message lives in canonical storage; rw_inbox_mention_v5
 * keyed mentions by that raw id and dropped every one of them. rw_inbox_mention_v6
 * maps a projection id to its canonical storage first, then fans out to local
 * targets (projected targets are membership-gated). Every older reader view sits
 * on the dropping arm.
 *
 * agentInbox (rw_agent_inbox_v5) owns the offer rules (offered rows only, thread
 * deliverability, a mention beyond the admitted stream pierces a mute,
 * offered_unread / activity_seq), and the app reads its columns without
 * re-deriving them.
 *
 * conversationUnread (rw_conversation_unread_v3; rw_inbox_muted_full_v2 in
 * infra/risingwave/sql/075-inbox-cursor-decouple.sql) is the sidebar's unread
 * source -- GET /channels/unread (bare and summary) and the per-server pink badge
 * (GET /servers/unread-summary).
 *
 * The set is the cursor-decoupled generation (075 arms, 076 consumers): same
 * columns and semantics as 068's, but a read-cursor move no longer rewrites
 * every message of the conversation in the arm views.
 */
export const CONVERSATION_UNREAD_VIEW = "rw_conversation_unread_v3";
export const UNIFIED_CHAIN_VIEWS = {
  serving: "rw_inbox_serving_v8",
  totals: "rw_activity_totals_v6",
  agentInbox: "rw_agent_inbox_v6",
  conversationUnread: CONVERSATION_UNREAD_VIEW,
} as const;
/**
 * TRANSITION: a read that finds a current view missing reads the newest older
 * generation that exists instead of failing the endpoint
 * (withUnifiedChainTransition); the columns are identical across generations.
 * Each entry lists the older generations, newest first.
 *   - serving/totals: 077 (task #333) -> 076 -> 068. An environment that has not
 *     built 077 reads 076's serving v7 / totals v5, which still show threads
 *     below a deleted parent, as before 077; one that has not built 076 either
 *     reads 068's v6 / v4. Drop the 068 step once 076 is built everywhere, and
 *     the whole entry once 077 is built everywhere and traces show no fallback.
 *   - agent inbox/conversation unread (076): 068's v5 / v2. Remove with the 068
 *     views.
 */
export const UNIFIED_CHAIN_TRANSITION_VIEWS: ReadonlyMap<string, readonly string[]> = new Map([
  [UNIFIED_CHAIN_VIEWS.serving, ["rw_inbox_serving_v7", "rw_inbox_serving_v6"]],
  [UNIFIED_CHAIN_VIEWS.totals, ["rw_activity_totals_v5", "rw_activity_totals_v4"]],
  [UNIFIED_CHAIN_VIEWS.agentInbox, ["rw_agent_inbox_v5"]],
  [UNIFIED_CHAIN_VIEWS.conversationUnread, ["rw_conversation_unread_v2"]],
]);
// A missing generation is remembered for this long, so the read path does not pay
// a failed round-trip per request while an environment is still building it.
const UNIFIED_CHAIN_TRANSITION_MEMO_MS = 60_000;
const unifiedChainViewMissingUntil = new Map<string, number>();

/**
 * "relation does not exist": RisingWave answers SQLSTATE 42704 with "table or
 * source not found: <name>"; Postgres 42P01 with "relation ... does not exist".
 */
export function isMissingRelationError(error: unknown, relation: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  return message.includes(relation)
    && (code === "42P01" || code === "42704" || /does not exist|not found/i.test(message));
}

/**
 * Every generation of a unified-chain view was found missing within the memo
 * window. Thrown instead of running SQL with no relation to name, so the error
 * says which view and which generations, not `relation "null"` (Rill, #9463).
 */
export class UnifiedChainViewUnavailableError extends Error {
  readonly code = "UNIFIED_CHAIN_VIEW_UNAVAILABLE";
  constructor(readonly view: string, readonly generations: readonly string[]) {
    super(`RisingWave has none of the generations of ${view}: ${generations.join(", ")}`);
    this.name = "UnifiedChainViewUnavailableError";
  }
}

/** The newest generation of `view` not remembered as missing, or null if none is left. */
function unifiedChainReadName(view: string, at: number): string | null {
  for (const name of [view, ...UNIFIED_CHAIN_TRANSITION_VIEWS.get(view)!]) {
    if ((unifiedChainViewMissingUntil.get(name) ?? 0) <= at) return name;
  }
  return null;
}

/**
 * Runs `run` with `queryText`; if that fails because a view of the unified chain
 * is missing, remembers that generation as missing for a minute and reruns with
 * the next older one, until a run succeeds, fails for another reason, or a view
 * has no older generation left (then the last error is thrown). Every rerun on
 * older generations reports to `onFallback`: the current views it replaced and
 * the names it read instead (for a trace event).
 */
export async function withUnifiedChainTransition<T>(
  queryText: string,
  run: (queryText: string) => Promise<T>,
  onFallback: (missingViews: string[], readViews: string[]) => void = () => {},
  now: () => number = Date.now,
): Promise<T> {
  const named = [...UNIFIED_CHAIN_TRANSITION_VIEWS.keys()]
    .filter((view) => new RegExp(`\\b${view}\\b`).test(queryText));
  if (named.length === 0) return run(queryText);
  for (;;) {
    const at = now();
    const chosen = named.map((view) => [view, unifiedChainReadName(view, at)] as const);
    const exhausted = chosen.find(([, name]) => name === null);
    if (exhausted) {
      const view = exhausted[0];
      throw new UnifiedChainViewUnavailableError(view, [view, ...UNIFIED_CHAIN_TRANSITION_VIEWS.get(view)!]);
    }
    const swapped = chosen.filter(([view, name]) => name !== view);
    let text = queryText;
    for (const [view, name] of swapped) text = text.replace(new RegExp(`\\b${view}\\b`, "g"), name!);
    if (swapped.length > 0) onFallback(swapped.map(([view]) => view), swapped.map(([, name]) => name!));
    try {
      return await run(text);
    } catch (error) {
      const missing = chosen.map(([, name]) => name!).filter((name) => isMissingRelationError(error, name));
      if (missing.length === 0) throw error;
      for (const name of missing) unifiedChainViewMissingUntil.set(name, at + UNIFIED_CHAIN_TRANSITION_MEMO_MS);
      if (named.some((view) => unifiedChainReadName(view, at) === null)) throw error;
    }
  }
}

export const __testUnifiedChainTransition = {
  reset() {
    unifiedChainViewMissingUntil.clear();
  },
};
export type RisingWaveInboxItemsServingVersion = 2 | 3;
export type RisingWaveInboxRfc056ServingMode = "off" | "shadow" | "on";
export const RISINGWAVE_UNREAD_INBOX_SERVING_VERSION: RisingWaveInboxItemsServingVersion = 2;
const DEFAULT_RISINGWAVE_CONNECTION_TIMEOUT_MS = 1_000;
const MIN_RISINGWAVE_CONNECTION_TIMEOUT_MS = 250;
const MAX_RISINGWAVE_CONNECTION_TIMEOUT_MS = 10_000;

export type RisingWavePoolState = {
  rw_pool_total: number;
  rw_pool_idle: number;
  rw_pool_waiting: number;
};

export type RisingWaveQueryRead<T extends pg.QueryResultRow = any> = {
  result: pg.QueryResult<T>;
  acquireWaitMs: number;
  poolState: RisingWavePoolState;
};

export function getRisingWaveInboxItemsServingVersion(): RisingWaveInboxItemsServingVersion {
  return RISINGWAVE_UNREAD_INBOX_SERVING_VERSION;
}

export function getRisingWaveInboxRfc056ServingMode(
  env: NodeJS.ProcessEnv = process.env,
): RisingWaveInboxRfc056ServingMode {
  const value = env.RISINGWAVE_INBOX_RFC056_SERVING_MODE?.trim().toLowerCase();
  if (value === "shadow" || value === "on") return value;
  // Fail closed for missing and invalid values. Operators must explicitly
  // authorize every RFC056 candidate read or serving transition.
  return "off";
}

let _risingWavePool: pg.Pool | null = null;
let _risingWaveUrl: string | null = null;

export function getRisingWaveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.RISINGWAVE_DATABASE_URL?.trim();
  return value ? value : null;
}

export function isRisingWaveConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(getRisingWaveDatabaseUrl(env));
}

/**
 * RisingWave is a hard dependency of the server: the Activity, followed-thread
 * and sidebar unread reads are served from it only. With no RisingWave
 * configured those reads fail with this error; there is no Postgres fallback.
 */
export class RisingWaveNotConfiguredError extends Error {
  constructor(surface: string) {
    super(`RisingWave is not configured (RISINGWAVE_DATABASE_URL is unset); cannot serve ${surface}`);
    this.name = "RisingWaveNotConfiguredError";
  }
}

/**
 * Every RisingWave pool connection stayed busy past the acquire timeout
 * (RISINGWAVE_CONNECTION_TIMEOUT_MS): RisingWave is slow, not down, and the
 * request can be retried. Routes answer it with 503 + Retry-After instead of
 * 500 (respondToRisingWaveOverload). The message keeps pg-pool's wording so
 * trace classification still reads it as rw_acquire_timeout.
 */
export class RisingWaveOverloadedError extends Error {
  constructor(cause: unknown) {
    super(`RisingWave pool saturated: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "RisingWaveOverloadedError";
  }
}

/** True when `error` (or its cause chain) is a RisingWaveOverloadedError. */
export function isRisingWaveOverloadedError(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; depth += 1) {
    if (current instanceof RisingWaveOverloadedError) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * A RisingWave read failed for a reason other than overload or missing
 * configuration (connection refused, query error, ...). The original error is
 * the `cause`. Routes that adopted the typed contract (task #162) answer it
 * with 502 rw_read_failed instead of 500, which would read as a server bug.
 */
export class RisingWaveReadError extends Error {
  constructor(cause: unknown) {
    super(`RisingWave read failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "RisingWaveReadError";
  }
}

/** Wrap a RisingWave read failure as RisingWaveReadError unless it is already typed. */
export function asRisingWaveReadError(error: unknown): unknown {
  return error instanceof RisingWaveNotConfiguredError
    || error instanceof RisingWaveReadError
    || isRisingWaveOverloadedError(error)
    ? error
    : new RisingWaveReadError(error);
}

/** Rethrow a RisingWave pool acquire timeout as RisingWaveOverloadedError. */
export function asRisingWaveOverload(error: unknown): unknown {
  return isPoolAcquireTimeoutError(error) && !(error instanceof RisingWaveOverloadedError)
    ? new RisingWaveOverloadedError(error)
    : error;
}

export function getRisingWaveConnectionTimeoutMillis(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RISINGWAVE_CONNECTION_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_RISINGWAVE_CONNECTION_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_RISINGWAVE_CONNECTION_TIMEOUT_MS;
  return Math.min(
    Math.max(Math.trunc(parsed), MIN_RISINGWAVE_CONNECTION_TIMEOUT_MS),
    MAX_RISINGWAVE_CONNECTION_TIMEOUT_MS,
  );
}

export async function queryRisingWave<T extends pg.QueryResultRow = any>(
  pool: pg.Pool,
  queryText: string,
  values?: unknown[],
): Promise<RisingWaveQueryRead<T>> {
  // A RisingWave read is an external round-trip; if it runs while a Postgres
  // transaction is open, that transaction sits idle holding a connection waiting
  // on RisingWave. Report it to the audit file (when enabled) so the test suite
  // can surface any such call site at any depth.
  recordExternalSinkInsideTransaction("risingwave");
  const acquireStartedAt = performance.now();
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    recordStatementError("risingwave", error);
    throw asRisingWaveOverload(error);
  }
  const acquireWaitMs = performance.now() - acquireStartedAt;
  const poolState = getRisingWavePoolState(pool);
  const statementStartMs = Date.now();
  try {
    const result = await client.query<T>(queryText, values);
    observeStatement("risingwave", statementKindFromText(queryText), statementStartMs);
    return { result, acquireWaitMs, poolState };
  } catch (error) {
    observeStatement("risingwave", statementKindFromText(queryText), statementStartMs, error);
    throw error;
  } finally {
    client.release();
  }
}

export function getRisingWavePool(): pg.Pool | null {
  const databaseUrl = getRisingWaveDatabaseUrl();
  if (!databaseUrl) return null;

  if (_risingWavePool && _risingWaveUrl === databaseUrl) {
    return _risingWavePool;
  }

  if (_risingWavePool) {
    void _risingWavePool.end().catch((err) => {
      console.error("[risingwave] failed to close replaced pool:", err.message);
    });
  }

  _risingWaveUrl = databaseUrl;
  _risingWavePool = new pg.Pool({
    connectionString: databaseUrl,
    max: Number(process.env.RISINGWAVE_POOL_MAX || "10"),
    connectionTimeoutMillis: getRisingWaveConnectionTimeoutMillis(),
    idleTimeoutMillis: 60_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    ssl: databaseUrl.includes("risingwave.cloud") ? { rejectUnauthorized: false } : undefined,
  });
  _risingWavePool.on("error", (err) => {
    console.error("[risingwave] unexpected pool error:", err.message);
  });
  // Same crash guard as the primary pool (task #269): pg-pool detaches its
  // idle 'error' listener from checked-out clients, so a dropped connection
  // between queries would otherwise take the process down.
  attachPoolClientErrorHandler(_risingWavePool, "risingwave");
  return _risingWavePool;
}

export function getRisingWavePoolState(pool: pg.Pool | null = _risingWavePool): RisingWavePoolState {
  return {
    rw_pool_total: pool?.totalCount ?? 0,
    rw_pool_idle: pool?.idleCount ?? 0,
    rw_pool_waiting: pool?.waitingCount ?? 0,
  };
}

export async function closeRisingWavePool() {
  if (_risingWavePool) {
    await _risingWavePool.end();
  }
  _risingWavePool = null;
  _risingWaveUrl = null;
}
