import type pg from "pg";

// Startup pre-warm for the primary PG pool.
//
// pg.Pool opens connections on demand, so a freshly started task takes its
// first traffic with an empty pool. During a deploy that first traffic is the
// reconnect storm: every concurrent request pays TLS + auth to the pooler at
// once (v1.21.9 cutover: 371 new connections on new tasks in one minute). We
// open a small number before the HTTP server listens, one at a time, so that
// handshake work happens before the load balancer can route here. The pool's
// `min` (set to the same count) keeps them from being closed by the idle timer
// while the task waits for its first request.
//
// Pre-warm must never block startup: every connect has its own timeout, the
// whole step has a deadline, and any failure is logged and startup continues.

export const DEFAULT_PG_POOL_PREWARM = 10;

/** `PG_POOL_PREWARM` (default 10), clamped to [0, max]. 0 disables pre-warm. */
export function resolvePoolPrewarmCount(
  env: NodeJS.ProcessEnv,
  maxConnections: number,
): number {
  const raw = env.PG_POOL_PREWARM;
  const parsed = raw === undefined || raw.trim() === "" ? DEFAULT_PG_POOL_PREWARM : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_PG_POOL_PREWARM;
  return Math.min(Math.floor(parsed), maxConnections);
}

export interface PoolPrewarmOptions {
  count: number;
  /** Per-connection timeout. */
  connectTimeoutMs?: number;
  /** Pause between connects so tasks starting together do not burst. */
  staggerMs?: number;
  /** Stop starting new connects after this long. */
  deadlineMs?: number;
  log?: (message: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PoolPrewarmResult {
  opened: number;
  stoppedBy: "done" | "timeout" | "error" | "deadline";
  durationMs: number;
}

type PrewarmablePool = Pick<pg.Pool, "connect">;

const TIMED_OUT = Symbol("prewarm-timeout");

export async function prewarmPool(
  pool: PrewarmablePool,
  options: PoolPrewarmOptions,
): Promise<PoolPrewarmResult> {
  const connectTimeoutMs = options.connectTimeoutMs ?? 2_000;
  const staggerMs = options.staggerMs ?? 50;
  const deadlineMs = options.deadlineMs ?? 5_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? ((message: string) => console.log(message));
  const startedAt = now();

  // Clients are held until the end: releasing each one right away would let
  // the pool hand the same connection back on the next connect().
  const held: pg.PoolClient[] = [];
  let stoppedBy: PoolPrewarmResult["stoppedBy"] = "done";
  try {
    for (let i = 0; i < options.count; i += 1) {
      if (i > 0 && staggerMs > 0) await sleep(staggerMs);
      if (now() - startedAt >= deadlineMs) {
        stoppedBy = "deadline";
        break;
      }
      const connecting = pool.connect();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        connecting,
        new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), connectTimeoutMs);
        }),
      ]).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)))
        .finally(() => clearTimeout(timer));
      if (result === TIMED_OUT) {
        // A late connect still lands in the pool; hand it back when it does.
        connecting.then((client) => client.release(), () => {});
        stoppedBy = "timeout";
        break;
      }
      if (result instanceof Error) {
        log(`[db] pool pre-warm connect failed, continuing startup: ${result.message}`);
        stoppedBy = "error";
        break;
      }
      held.push(result);
    }
  } finally {
    for (const client of held) client.release();
  }
  const durationMs = now() - startedAt;
  log(`[db] pool pre-warm: ${held.length}/${options.count} connections in ${durationMs}ms (${stoppedBy})`);
  return { opened: held.length, stoppedBy, durationMs };
}
