import type { Page, Request, Response, TestInfo } from "@playwright/test";

import type { ProfileOpenDiagnosticTimeline } from "../../../src/utils/profileOpenE2eTimeline";

const MAX_CHUNK_REQUESTS = 8;
const DIAGNOSTIC_OPERATION_DEADLINE_MS = 250;

export type ProfileOpenEvidenceConsumer = "channel-avatar" | "thread-avatar" | "channel-avatar-retarget";
export type ProfileOpenChunk = "profile-panel" | "agent-detail";

interface ProfileOpenChunkRequest {
  id: number;
  chunk: ProfileOpenChunk;
  startedAtMs: number;
  responseAtMs?: number;
  status?: number;
  finishedAtMs?: number;
  failedAtMs?: number;
  failureKind?: "aborted" | "connection-reset" | "connection-refused" | "timeout" | "other";
}

type ProfileOpenTestInfo = Pick<TestInfo, "attach" | "retry">;

export function classifyProfileOpenChunkRequest(method: string, rawUrl: string): ProfileOpenChunk | null {
  if (method !== "GET") return null;
  let filename: string;
  try {
    filename = new URL(rawUrl).pathname.split("/").at(-1) ?? "";
  } catch {
    return null;
  }
  if (/^ProfilePanel(?:-[A-Za-z0-9_-]+)?\.js$/.test(filename)) return "profile-panel";
  if (/^AgentDetailPanel(?:-[A-Za-z0-9_-]+)?\.js$/.test(filename)) return "agent-detail";
  return null;
}

function classifyRequestFailure(errorText: string | undefined) {
  const normalized = errorText?.toLowerCase() ?? "";
  if (normalized.includes("aborted")) return "aborted" as const;
  if (normalized.includes("reset")) return "connection-reset" as const;
  if (normalized.includes("refused")) return "connection-refused" as const;
  if (normalized.includes("timeout") || normalized.includes("timed out")) return "timeout" as const;
  return "other" as const;
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

async function withDiagnosticDeadline<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(fallback), DIAGNOSTIC_OPERATION_DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Observe one Profile-open contract without changing its assertion, timeout,
 * or retry behavior. A failure emits one bounded attachment containing only
 * enum/timestamp/status data; diagnostic failures never replace the original
 * assertion error.
 */
export async function withProfileOpenEvidence<T>(
  page: Page,
  testInfo: ProfileOpenTestInfo,
  consumer: ProfileOpenEvidenceConsumer,
  action: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const chunks: ProfileOpenChunkRequest[] = [];
  const chunkEntries = new Map<Request, ProfileOpenChunkRequest>();
  let chunkRequestsTruncated = 0;
  let requestObserverAvailable = false;
  let browserTimelineAvailable = false;

  const onRequest = (request: Request) => {
    const chunk = classifyProfileOpenChunkRequest(request.method(), request.url());
    if (!chunk) return;
    if (chunks.length >= MAX_CHUNK_REQUESTS) {
      chunkRequestsTruncated += 1;
      return;
    }
    const entry: ProfileOpenChunkRequest = {
      id: chunks.length + 1,
      chunk,
      startedAtMs: elapsedMs(startedAt),
    };
    chunks.push(entry);
    chunkEntries.set(request, entry);
  };
  const onResponse = (response: Response) => {
    const entry = chunkEntries.get(response.request());
    if (!entry) return;
    entry.responseAtMs = elapsedMs(startedAt);
    entry.status = response.status();
  };
  const onFinished = (request: Request) => {
    const entry = chunkEntries.get(request);
    if (entry) entry.finishedAtMs = elapsedMs(startedAt);
  };
  const onFailed = (request: Request) => {
    const entry = chunkEntries.get(request);
    if (!entry) return;
    entry.failedAtMs = elapsedMs(startedAt);
    entry.failureKind = classifyRequestFailure(request.failure()?.errorText);
  };

  try {
    page.on("request", onRequest);
    page.on("response", onResponse);
    page.on("requestfinished", onFinished);
    page.on("requestfailed", onFailed);
    requestObserverAvailable = true;
  } catch {
    // Diagnostic observation must not block the product action.
  }

  try {
    browserTimelineAvailable = await withDiagnosticDeadline(
      () => page.evaluate((receiptStartedAtEpochMs) => {
        const hook = window.__SLOCK_E2E__;
        if (!hook) return false;
        hook.startProfileOpenTimeline(receiptStartedAtEpochMs);
        return true;
      }, startedAt),
      false,
    );
  } catch {
    // The attachment records hook availability if the assertion later fails.
  }

  let actionSucceeded = false;
  let actionResult: T | undefined;
  let actionError: unknown;
  let assertionEndedAtMs = 0;
  let browser: ProfileOpenDiagnosticTimeline | null = null;
  try {
    try {
      actionResult = await action();
      actionSucceeded = true;
    } catch (error) {
      actionError = error;
    }
    assertionEndedAtMs = elapsedMs(startedAt);
    if (!actionSucceeded && browserTimelineAvailable) {
      browser = await withDiagnosticDeadline(
        () => page.evaluate(() => window.__SLOCK_E2E__?.readProfileOpenTimeline() ?? null),
        null,
      ).catch(() => null);
    }
  } finally {
    if (browserTimelineAvailable) {
      await withDiagnosticDeadline(
        () => page.evaluate(() => {
          window.__SLOCK_E2E__?.stopProfileOpenTimeline();
        }),
        undefined,
      ).catch(() => undefined);
    }
    try {
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfinished", onFinished);
      page.off("requestfailed", onFailed);
    } catch {
      // Listener cleanup is diagnostic-only.
    }
  }
  if (actionSucceeded) return actionResult as T;

  const receipt = {
    schema: "profile-open-e2e-evidence",
    version: 1,
    consumer,
    retry: testInfo.retry,
    timeline: { origin: "receipt-start-before-click", unit: "ms" },
    assertionEndedAtMs,
    requestObserverAvailable,
    browser: browser ?? {
      available: false,
      reason: browserTimelineAvailable ? "capture-unavailable" : "hook-unavailable",
    },
    chunks,
    chunkRequestsTruncated,
    chunkEvidence: {
      source: "playwright-page-request-events",
      interpretation: "client-side asset observation only; absence is not server non-arrival evidence",
    },
    privacy: {
      retained: ["event kind", "bounded state enums", "relative milliseconds", "HTTP status"],
      excluded: ["entity ids", "message text", "raw URLs", "request headers", "tokens", "error text"],
    },
  };

  try {
    await withDiagnosticDeadline(
      () => testInfo.attach(`profile-open-${consumer}.json`, {
        body: Buffer.from(JSON.stringify(receipt, null, 2)),
        contentType: "application/json",
      }),
      undefined,
    );
  } catch {
    console.error("[profile-open-evidence] diagnostic attachment unavailable");
  }
  throw actionError;
}
