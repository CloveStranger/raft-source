import assert from "node:assert/strict";
import { AxiosError } from "axios";
import type { InternalAxiosRequestConfig } from "axios";
import { getWithRwOverloadRetry, rwOverloadRetryDelayMs } from "../src/api/overloadRetry";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
});

function failure(
  config: InternalAxiosRequestConfig,
  status: number,
  data: unknown,
  headers: Record<string, string> = {},
): AxiosError {
  return new AxiosError(`HTTP ${status}`, "ERR_BAD_RESPONSE", config, undefined, {
    config,
    data,
    headers,
    status,
    statusText: "",
  });
}

const rwOverload = { error: "Temporarily overloaded, retry shortly", code: "rw_overloaded", retryable: true };

test("a RisingWave overload 503 is retried once after Retry-After", async () => {
  let attempts = 0;
  const startedAt = Date.now();
  const { data } = await getWithRwOverloadRetry("/channels/unread", {
    params: { summary: 1 },
    adapter: async (config) => {
      attempts += 1;
      if (attempts === 1) throw failure(config, 503, rwOverload, { "retry-after": "0.05" });
      return { data: { channels: {} }, status: 200, statusText: "OK", headers: {}, config };
    },
  });
  assert.deepEqual(data, { channels: {} });
  assert.equal(attempts, 2);
  assert.ok(Date.now() - startedAt >= 45, "waits for the server's Retry-After before retrying");
});

test("a second overload is returned to the caller, not retried again", async () => {
  let attempts = 0;
  const rejection = await getWithRwOverloadRetry("/servers/unread-summary", {
    adapter: async (config) => {
      attempts += 1;
      throw failure(config, 503, rwOverload, { "retry-after": "0" });
    },
  }).then(() => null, (error: unknown) => error);
  assert.ok(rejection instanceof AxiosError);
  assert.equal(rejection.response?.status, 503);
  assert.equal(attempts, 2);
});

test("other failures are not retried", async () => {
  const cases: Array<[number, unknown]> = [
    [503, { code: "rw_unconfigured", retryable: false }],
    [502, { code: "rw_read_failed", retryable: true }],
    [429, { code: "INBOX_BACKPRESSURE" }],
    [500, { error: "boom" }],
  ];
  for (const [status, body] of cases) {
    let attempts = 0;
    await getWithRwOverloadRetry("/channels/inbox", {
      adapter: async (config) => {
        attempts += 1;
        throw failure(config, status, body, { "retry-after": "0" });
      },
    }).catch(() => null);
    assert.equal(attempts, 1, `${status} ${JSON.stringify(body)} must not be retried`);
  }
});

test("an abort while waiting cancels the retry", async () => {
  let attempts = 0;
  const controller = new AbortController();
  const pending = getWithRwOverloadRetry("/channels/inbox", {
    signal: controller.signal,
    adapter: async (config) => {
      attempts += 1;
      throw failure(config, 503, rwOverload, { "retry-after": "5" });
    },
  }).then(() => null, (error: unknown) => error);
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort(new Error("navigated away"));
  const rejection = await pending;
  assert.ok(rejection instanceof Error);
  assert.equal((rejection as Error).message, "navigated away");
  assert.equal(attempts, 1);
});

test("Retry-After parsing: default 2 s when missing or invalid, capped at 10 s", () => {
  const overload = (headers: Record<string, unknown>) => ({ response: { status: 503, data: rwOverload, headers } });
  assert.equal(rwOverloadRetryDelayMs(overload({ "retry-after": "2" })), 2_000);
  assert.equal(rwOverloadRetryDelayMs(overload({})), 2_000);
  assert.equal(rwOverloadRetryDelayMs(overload({ "retry-after": "soon" })), 2_000);
  assert.equal(rwOverloadRetryDelayMs(overload({ "retry-after": "600" })), 10_000);
  assert.equal(rwOverloadRetryDelayMs(new Error("network")), null);
});
