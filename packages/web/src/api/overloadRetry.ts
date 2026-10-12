import api from "./client";

// Inbox and unread reads come from RisingWave. When its pool is saturated the
// server answers 503 `rw_overloaded` with `Retry-After` (2 s); these waves last
// a minute or two. Callers already keep the data they have on failure, but a
// first load (page open, server switch, new filter) has nothing to keep, so
// retry once after the server's hint instead of showing an empty result until
// the next refresh. One retry only: more would add load while RW is behind.

const DEFAULT_RETRY_AFTER_MS = 2_000;
const MAX_RETRY_AFTER_MS = 10_000;

/** The Retry-After delay (ms) if `error` is a retryable RisingWave overload, else null. */
export function rwOverloadRetryDelayMs(error: unknown): number | null {
  const response = (error as { response?: { status?: number; data?: unknown; headers?: Record<string, unknown> } })?.response;
  if (response?.status !== 503) return null;
  const data = response.data as { code?: unknown; retryable?: unknown } | undefined;
  if (data?.code !== "rw_overloaded" || data.retryable !== true) return null;
  const seconds = Number(response.headers?.["retry-after"]);
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
}

const wait = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** `api.get` that retries once after `Retry-After` on a RisingWave overload 503. */
export const getWithRwOverloadRetry = (async (url: string, config?: Parameters<typeof api.get>[1]) => {
  try {
    return await api.get(url, config);
  } catch (error) {
    const delayMs = rwOverloadRetryDelayMs(error);
    if (delayMs === null) throw error;
    await wait(delayMs, config?.signal as AbortSignal | undefined);
    return api.get(url, config);
  }
}) as typeof api.get;
