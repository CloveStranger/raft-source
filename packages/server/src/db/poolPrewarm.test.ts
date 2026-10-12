import assert from "node:assert/strict";
import type pg from "pg";
import { DEFAULT_PG_POOL_PREWARM, prewarmPool, resolvePoolPrewarmCount } from "./poolPrewarm";

// A pool double that behaves like pg.Pool for connect/release: a released
// client goes back to the idle list and is handed out again, so holding clients
// is the only way to end up with N distinct connections.
function fakePool(connectImpl?: (attempt: number) => Promise<void> | void) {
  const idle: { id: number }[] = [];
  const opened: number[] = [];
  let attempts = 0;
  let checkedOut = 0;
  let maxCheckedOut = 0;
  const pool = {
    async connect() {
      const attempt = attempts++;
      const reused = idle.pop();
      if (!reused) await connectImpl?.(attempt);
      const conn = reused ?? { id: opened.push(opened.length) - 1 };
      checkedOut += 1;
      maxCheckedOut = Math.max(maxCheckedOut, checkedOut);
      return {
        release() {
          checkedOut -= 1;
          idle.push(conn);
        },
      } as unknown as pg.PoolClient;
    },
  };
  return {
    pool: pool as unknown as pg.Pool,
    stats: () => ({ opened: opened.length, idle: idle.length, checkedOut, maxCheckedOut, attempts }),
  };
}

const quiet = { log: () => {}, sleep: async () => {} };

test("opens `count` distinct connections and returns them all to the pool", async () => {
  const { pool, stats } = fakePool();
  const result = await prewarmPool(pool, { count: 10, ...quiet });
  assert.deepEqual({ opened: result.opened, stoppedBy: result.stoppedBy }, { opened: 10, stoppedBy: "done" });
  assert.deepEqual(stats(), { opened: 10, idle: 10, checkedOut: 0, maxCheckedOut: 10, attempts: 10 });
});

test("connects one at a time with a stagger between connects", async () => {
  const { pool } = fakePool();
  const sleeps: number[] = [];
  await prewarmPool(pool, { count: 3, staggerMs: 50, log: () => {}, sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(sleeps, [50, 50]);
});

test("a failed connect is logged and startup continues without throwing", async () => {
  const { pool, stats } = fakePool((attempt) => {
    if (attempt === 3) throw new Error("pooler refused");
  });
  const logs: string[] = [];
  const result = await prewarmPool(pool, { count: 10, log: (m) => logs.push(m), sleep: async () => {} });
  assert.equal(result.opened, 3);
  assert.equal(result.stoppedBy, "error");
  assert.equal(stats().checkedOut, 0);
  assert.ok(logs.some((m) => m.includes("pooler refused")));
});

test("a hung connect times out, stops pre-warm, and the late client is released when it arrives", async () => {
  let finishLate: () => void = () => {};
  const { pool, stats } = fakePool((attempt) => {
    if (attempt === 2) return new Promise<void>((resolve) => { finishLate = resolve; });
  });
  const result = await prewarmPool(pool, { count: 10, connectTimeoutMs: 20, ...quiet });
  assert.equal(result.opened, 2);
  assert.equal(result.stoppedBy, "timeout");
  assert.equal(stats().checkedOut, 0);
  finishLate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stats().checkedOut, 0, "late client must be released, not leaked");
  assert.equal(stats().idle, 3);
});

test("stops starting new connects once the overall deadline passes", async () => {
  const { pool } = fakePool();
  let clock = 0;
  const result = await prewarmPool(pool, {
    count: 10,
    deadlineMs: 1_000,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    staggerMs: 300,
    log: () => {},
  });
  // Connects at t=0, 300, 600, 900; t=1200 is past the deadline.
  assert.equal(result.opened, 4);
  assert.equal(result.stoppedBy, "deadline");
});

test("PG_POOL_PREWARM defaults to 10, 0 disables, and it never exceeds the pool max", () => {
  assert.equal(resolvePoolPrewarmCount({}, 50), DEFAULT_PG_POOL_PREWARM);
  assert.equal(resolvePoolPrewarmCount({ PG_POOL_PREWARM: "" }, 50), DEFAULT_PG_POOL_PREWARM);
  assert.equal(resolvePoolPrewarmCount({ PG_POOL_PREWARM: "0" }, 50), 0);
  assert.equal(resolvePoolPrewarmCount({ PG_POOL_PREWARM: "4" }, 50), 4);
  assert.equal(resolvePoolPrewarmCount({ PG_POOL_PREWARM: "80" }, 50), 50);
  assert.equal(resolvePoolPrewarmCount({ PG_POOL_PREWARM: "nope" }, 50), DEFAULT_PG_POOL_PREWARM);
  assert.equal(resolvePoolPrewarmCount({ PG_POOL_PREWARM: "-1" }, 50), DEFAULT_PG_POOL_PREWARM);
});

test("createPool keeps `min` idle clients for the primary pool and none by default", async () => {
  const { createPool } = await import("./index");
  const primary = createPool("postgres://prewarm-test@127.0.0.1:1/none", { min: 10 });
  const search = createPool("postgres://prewarm-test@127.0.0.1:1/none");
  try {
    assert.equal((primary as unknown as { options: { min: number } }).options.min, 10);
    assert.equal((search as unknown as { options: { min: number } }).options.min, 0);
  } finally {
    await Promise.all([primary.end(), search.end()]);
  }
});

test("PG_POOL_IDLE_TIMEOUT_MS defaults to 5 minutes and createPool uses it", async () => {
  const { createPool, DEFAULT_PG_POOL_IDLE_TIMEOUT_MS, resolvePoolIdleTimeoutMs } = await import("./index");
  assert.equal(DEFAULT_PG_POOL_IDLE_TIMEOUT_MS, 300_000);
  assert.equal(resolvePoolIdleTimeoutMs({}), 300_000);
  assert.equal(resolvePoolIdleTimeoutMs({ PG_POOL_IDLE_TIMEOUT_MS: "" }), 300_000);
  assert.equal(resolvePoolIdleTimeoutMs({ PG_POOL_IDLE_TIMEOUT_MS: "60000" }), 60_000);
  assert.equal(resolvePoolIdleTimeoutMs({ PG_POOL_IDLE_TIMEOUT_MS: "0" }), 300_000);
  assert.equal(resolvePoolIdleTimeoutMs({ PG_POOL_IDLE_TIMEOUT_MS: "nope" }), 300_000);

  const pool = createPool("postgres://idle-test@127.0.0.1:1/none");
  try {
    const options = (pool as unknown as { options: { idleTimeoutMillis: number; keepAlive: boolean } }).options;
    assert.equal(options.idleTimeoutMillis, 300_000);
    // Holding idle clients for minutes relies on keepalive probes keeping NAT flows open.
    assert.equal(options.keepAlive, true);
  } finally {
    await pool.end();
  }
});
