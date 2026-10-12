// Liveness for the ALB/ECS health check, kept apart from DB readiness.
//
// `/health` answers "is the database reachable right now" with a live
// `SELECT 1`, so every Neon compute pause (~2s, several times an hour) turns
// it 503 on every task at once. If ECS replaced tasks on that signal, a long
// pause would replace the whole fleet together: new tasks cannot fix the
// database, and they all reconnect cold when it returns.
//
// `/livez` never touches the database on the request path. A background ping
// records when the database last answered, and the verdict only fails once
// that is older than LIVEZ_DB_STALE_MS. Short pauses never reach it; a task
// whose pool is truly dead (the case the DB-backed health check was guarding)
// still gets replaced.

/**
 * How long the database may go unanswered before this task reports itself
 * dead. Well above the ~2s Neon pauses and the ALB's own tolerance (3 probes x
 * 15s), so only a sustained outage or a broken pool trips it.
 */
export const LIVEZ_DB_STALE_MS = 60_000;

/** Background ping period. Several pings fit inside the stale window. */
export const LIVEZ_DB_PING_INTERVAL_MS = 5_000;

export interface LivenessVerdict {
  ok: boolean;
  /** "unmonitored" when no probe was started (tests, tools), never a failure. */
  db: "ok" | "stale" | "unmonitored";
  msSinceDbSuccess: number | null;
}

export interface DbLivenessTracker {
  /** Run one ping and record the outcome. Never throws. */
  probeOnce(): Promise<void>;
  verdict(now?: number): LivenessVerdict;
  start(): void;
  stop(): void;
}

export function createDbLivenessTracker(options: {
  ping: () => Promise<unknown>;
  now?: () => number;
  intervalMs?: number;
  staleMs?: number;
}): DbLivenessTracker {
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? LIVEZ_DB_PING_INTERVAL_MS;
  const staleMs = options.staleMs ?? LIVEZ_DB_STALE_MS;
  let monitored = false;
  // Counting from the first probe gives a fresh task the full window before
  // it can be judged, even if the database is slow to answer at startup.
  let lastSuccessAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  const probeOnce = async () => {
    if (!monitored) {
      monitored = true;
      lastSuccessAt = now();
    }
    if (inFlight) return; // a hung ping must not stack up behind itself
    inFlight = true;
    try {
      await options.ping();
      lastSuccessAt = now();
    } catch {
      // The age of lastSuccessAt is the signal; nothing else to record.
    } finally {
      inFlight = false;
    }
  };

  return {
    probeOnce,
    verdict(at = now()) {
      if (!monitored) return { ok: true, db: "unmonitored", msSinceDbSuccess: null };
      const age = at - lastSuccessAt;
      return age > staleMs
        ? { ok: false, db: "stale", msSinceDbSuccess: age }
        : { ok: true, db: "ok", msSinceDbSuccess: age };
    },
    start() {
      if (timer) return;
      void probeOnce();
      timer = setInterval(() => void probeOnce(), intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

/**
 * HTTP status for a verdict. In production an unmonitored tracker means the
 * probe was never started, which would make /livez a permanent 200 that can
 * no longer see a dead pool; surface that as 503 instead of passing silently.
 * Elsewhere (tests, tools) unmonitored stays 200.
 */
export function livezStatus(verdict: LivenessVerdict, nodeEnv = process.env.NODE_ENV): 200 | 503 {
  if (!verdict.ok) return 503;
  if (verdict.db === "unmonitored" && nodeEnv === "production") return 503;
  return 200;
}

let processTracker: DbLivenessTracker | null = null;

/** The process-wide tracker behind `/livez`. Started from server startup. */
export function getDbLivenessTracker(): DbLivenessTracker {
  if (!processTracker) {
    processTracker = createDbLivenessTracker({
      ping: async () => {
        const { pingDatabase } = await import("./db/index");
        await pingDatabase();
      },
    });
  }
  return processTracker;
}
