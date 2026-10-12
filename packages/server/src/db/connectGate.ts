import pg from "pg";

// Caps how many new PG connections one pool is opening at the same moment.
//
// Neon's proxy limits connection attempts that are in progress per endpoint,
// not open connections: it refuses with "Failed to acquire permit to connect
// to the database. Too many database connection attempts are currently
// ongoing." while the database side has a few hundred of 4000 connections
// open. pg.Pool opens one connection per waiting request with no limit, so a
// burst of requests on an empty or idle-trimmed pool sends dozens of
// handshakes at once from every task (48 h to 10-12: 575 refusal waves, 68 of
// them on all 12 tasks in the same second).
//
// The gate holds a permit from the start of the handshake until it succeeds or
// fails; further connects queue in FIFO order. Queue time counts toward the
// pool's connectionTimeoutMillis: a client whose deadline passed while it was
// queued fails as soon as it reaches the front instead of opening a connection
// nobody waits for.

// A Neon handshake takes 600-700 ms (TLS + auth through the proxy), so 8
// permits let one task open about 12 connections a second. In refusal waves a
// task had p50 9 / p90 18 / max 45 handshakes in flight at once.
export const DEFAULT_PG_CONNECT_CONCURRENCY = 8;

/** `PG_CONNECT_CONCURRENCY` (default 8). 0 disables the cap. */
export function resolveConnectConcurrency(env: NodeJS.ProcessEnv): number {
  const raw = env.PG_CONNECT_CONCURRENCY;
  const parsed = raw === undefined || raw.trim() === "" ? DEFAULT_PG_CONNECT_CONCURRENCY : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_PG_CONNECT_CONCURRENCY;
  return Math.floor(parsed);
}

export interface ConnectPermit {
  waitMs: number;
  release: () => void;
}

export interface ConnectGate {
  readonly limit: number;
  /** Rejects with `signal.reason` (and leaves the queue) if `signal` aborts before a permit is granted. */
  acquire(signal?: AbortSignal): Promise<ConnectPermit>;
  /** Handshakes holding a permit, and connects waiting for one. */
  state(): { connecting: number; queued: number };
}

export function createConnectGate(limit: number, now: () => number = Date.now): ConnectGate {
  let connecting = 0;
  const queue: Array<() => void> = [];

  const grant = (startedAt: number): ConnectPermit => {
    connecting += 1;
    let released = false;
    return {
      waitMs: now() - startedAt,
      release: () => {
        if (released) return;
        released = true;
        connecting -= 1;
        const next = queue.shift();
        if (next) next();
      },
    };
  };

  return {
    limit,
    acquire(signal) {
      const startedAt = now();
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (limit <= 0 || connecting < limit) return Promise.resolve(grant(startedAt));
      return new Promise<ConnectPermit>((resolve, reject) => {
        const onAbort = () => {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          reject(signal!.reason);
        };
        const waiter = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve(grant(startedAt));
        };
        queue.push(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    state: () => ({ connecting, queued: queue.length }),
  };
}

export const CONNECT_PERMIT_WAIT_MS = Symbol("slock.connectPermitWaitMs");

/** How long this client waited for a connect permit (unset if never gated). */
export function connectPermitWaitMs(client: object): number | undefined {
  return (client as { [CONNECT_PERMIT_WAIT_MS]?: number })[CONNECT_PERMIT_WAIT_MS];
}

type SocketLike = {
  destroyed?: boolean;
  once?: (event: "close", listener: () => void) => unknown;
  removeListener?: (event: "close", listener: () => void) => unknown;
};

type ConnectCallback = ((err: Error) => void) | ((err: null, client: pg.Client) => void);

/** A pg.Client subclass for `new pg.Pool({ Client })` whose connect() goes through `gate`. */
export function gatedClientClass(
  gate: ConnectGate,
  onPermit: (waitMs: number) => void = () => {},
): typeof pg.Client {
  return class GatedClient extends pg.Client {
    // pg-pool constructs the client right before starting its connect timer,
    // so time since construction is never less than the timer's elapsed time.
    readonly #createdAtMs = Date.now();

    override connect(): Promise<pg.Client>;
    override connect(callback: ConnectCallback): void;
    override connect(callback?: ConnectCallback): Promise<pg.Client> | void {
      // pg-pool's connect timeout only destroys the client's socket, and the
      // caller hears nothing until connect() settles. So a queued client
      // watches its socket and leaves the queue as soon as it is closed,
      // instead of failing only once a permit frees up (up to ~2x the timeout
      // behind a hanging handshake).
      const stream = (this as unknown as { connection?: { stream?: SocketLike } }).connection?.stream;
      const queued = new AbortController();
      const onClose = () => queued.abort(new Error("Connection timed out while waiting for a connect permit"));
      stream?.once?.("close", onClose);
      const permitted = gate.acquire(queued.signal).finally(() => stream?.removeListener?.("close", onClose));
      const connecting = permitted.then(async (permit) => {
        (this as { [CONNECT_PERMIT_WAIT_MS]?: number })[CONNECT_PERMIT_WAIT_MS] = permit.waitMs;
        onPermit(permit.waitMs);
        try {
          // pg-pool passes its options to the client, so this is the pool's
          // connectionTimeoutMillis. Its timer may not have fired yet when the
          // permit arrives at the deadline; don't dial in that case either.
          const self = this as unknown as {
            connection?: { stream?: { destroyed?: boolean } };
            _connectionTimeoutMillis?: number;
          };
          const timeoutMs = self._connectionTimeoutMillis ?? 0;
          if (self.connection?.stream?.destroyed || (timeoutMs > 0 && Date.now() - this.#createdAtMs >= timeoutMs)) {
            throw new Error("Connection timed out while waiting for a connect permit");
          }
          return await super.connect();
        } finally {
          permit.release();
        }
      });
      if (!callback) return connecting;
      const done = callback as (err: Error | null, client?: pg.Client) => void;
      connecting.then((client) => done(null, client), (err: Error) => done(err));
    }
  };
}
