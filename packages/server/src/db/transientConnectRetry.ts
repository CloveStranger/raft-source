/**
 * Retry for a short-lived, idempotent database job (deploy-time checks) when the
 * failure is a transient *connect* error: Neon's proxy briefly refusing new
 * connections ("Failed to acquire permit to connect to the database. Too many
 * database connection attempts are currently ongoing."), a reset, or a connect
 * timeout. A single such blip failed the v1.21.11 deploy at the privilege
 * check after migrations had already succeeded. Anything else is rethrown at once.
 */
const TRANSIENT_CONNECT_PATTERNS = [
  /failed to acquire permit to connect/i,
  /too many database connection attempts/i,
  /connection terminated unexpectedly/i,
  /timeout expired/i,
  /connection timeout/i,
];
const TRANSIENT_CONNECT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE"]);

export function isTransientConnectError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_CONNECT_CODES.has(code)) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && TRANSIENT_CONNECT_PATTERNS.some((pattern) => pattern.test(message));
}

export async function withTransientConnectRetry<T>(
  run: () => Promise<T>,
  options: {
    /** Waits before each retry; its length is the number of retries. */
    delaysMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (attempt: number, error: unknown) => void;
  } = {},
): Promise<T> {
  const delays = options.delaysMs ?? [2_000, 5_000];
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= delays.length || !isTransientConnectError(error)) throw error;
      options.onRetry?.(attempt + 1, error);
      await sleep(delays[attempt]!);
    }
  }
}
