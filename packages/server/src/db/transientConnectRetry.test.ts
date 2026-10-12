import { describe, expect, it, vi } from "vitest";
import { isTransientConnectError, withTransientConnectRetry } from "./transientConnectRetry";

const neonPermit = new Error(
  "Failed to acquire permit to connect to the database. Too many database connection attempts are currently ongoing.",
);

describe("isTransientConnectError", () => {
  it("recognizes Neon's proxy refusal and socket-level connect failures", () => {
    expect(isTransientConnectError(neonPermit)).toBe(true);
    expect(isTransientConnectError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe(true);
    expect(isTransientConnectError(new Error("Connection terminated unexpectedly"))).toBe(true);
  });

  it("does not treat real failures as transient", () => {
    expect(isTransientConnectError(new Error("permission denied for table feature_flags"))).toBe(false);
    expect(isTransientConnectError(Object.assign(new Error("syntax error"), { code: "42601" }))).toBe(false);
    expect(isTransientConnectError(undefined)).toBe(false);
  });
});

describe("withTransientConnectRetry", () => {
  const noSleep = vi.fn(async () => {});

  it("retries a transient connect failure and returns the later success", async () => {
    const run = vi.fn().mockRejectedValueOnce(neonPermit).mockResolvedValueOnce("ok");
    const onRetry = vi.fn();
    await expect(withTransientConnectRetry(run, { sleep: noSleep, onRetry })).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(1, neonPermit);
  });

  it("gives up after the configured retries and rethrows the last error", async () => {
    const run = vi.fn().mockRejectedValue(neonPermit);
    await expect(withTransientConnectRetry(run, { sleep: noSleep, delaysMs: [1, 1] })).rejects.toBe(neonPermit);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("never retries a non-transient failure", async () => {
    const denied = new Error("permission denied");
    const run = vi.fn().mockRejectedValue(denied);
    await expect(withTransientConnectRetry(run, { sleep: noSleep })).rejects.toBe(denied);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
