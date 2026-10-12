// The agent_event_tail attachment of a feedback report (task #1230): a
// bounded, whitelisted projection of ONE agent's local daemon trace events in
// the 15 minutes before the report. The contract (table, counts, strict
// parser, reader rules) lives in @botiverse/raft-shared feedbackAgentEventTail.
//
// Failure boundary:
// - started only AFTER the transcript result frame was sent, beside the
//   transcript_outcome upload; nothing on the existing path awaits it;
// - its own budget (`AGENT_EVENT_TAIL_BUDGET_MS`) aborts the corpus read and
//   every in-flight upload hop through one AbortController;
// - exactly one outcome per request, logged and recorded on a span; never
//   retried; late completions after the budget are not reclassified.
//
// Compatibility (conservative): `unsupported` only on a distinguishable
// signal — the server did not sign the kind, or the old worker's exact 400
// string at create. Everything else is `failed`.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  AgentEventTailAccumulator,
  buildBoundedFeedbackAgentEventTail,
  buildFailedFeedbackAgentEventTail,
  FEEDBACK_AGENT_EVENT_TAIL_WINDOW_MS,
  type AgentEventTailWindow,
  type FeedbackAgentEventTailBuildResult,
  type FeedbackAgentEventTailScan,
  type FeedbackAgentEventTailScanStopReason,
  type Tracer,
} from "@botiverse/raft-shared";
import { traceFileFamily } from "@botiverse/raft-trace-client";
import { HttpStatusError } from "./chatBridgeRequest";
import { uploadWithSignedCapability } from "./directUploadCapability";
import { logger } from "./logger";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Whole budget of one tail: scan + build + all upload hops. */
export const AGENT_EVENT_TAIL_BUDGET_MS = 30_000;
/** Per-hop timeout of the upload (each hop is also bounded by the budget). */
export const AGENT_EVENT_TAIL_UPLOAD_TIMEOUT_MS = 15_000;
/** Independent INPUT caps. They do not replace the 32 KiB output cap. */
export const AGENT_EVENT_TAIL_SCAN_LIMITS = { maxFiles: 16, maxBytes: 32 * 1024 * 1024, timeBudgetMs: 10_000 } as const;
/**
 * The exact error an older worker answers (HTTP 400, stage create) for a kind
 * it does not know: trace-upload-worker/src/traces/bundles.ts at the
 * inspected commit b064fce3. The only message ever matched; any other 400 is
 * `failed`. A future worker signals support by echoing the kind instead.
 */
export const AGENT_EVENT_TAIL_OLD_WORKER_UNSUPPORTED_ERROR = "attestation.metadata.feedbackAttachmentKind is not supported by this worker";

const LINES_PER_CHECK = 2000;

export function agentEventTailWindow(reportGeneratedAt: string): AgentEventTailWindow | null {
  const toMs = Date.parse(reportGeneratedAt);
  if (!Number.isFinite(toMs)) return null;
  return { requestedFrom: new Date(toMs - FEEDBACK_AGENT_EVENT_TAIL_WINDOW_MS).toISOString(), requestedTo: new Date(toMs).toISOString() };
}

class AgentEventTailAbortError extends Error {
  constructor() {
    super("agent event tail aborted");
    this.name = "AbortError";
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AgentEventTailAbortError();
}

export interface AgentEventTailScanLimits {
  maxFiles: number;
  maxBytes: number;
  timeBudgetMs: number;
}

/**
 * Single-flight scan slot: at most one tail scan reads the corpus per daemon
 * at a time. A later scan waits for the slot within its own scan time budget
 * and otherwise records `stopReason: "busy"` (nothing read).
 */
let scanSlotTail: Promise<void> = Promise.resolve();

async function acquireScanSlot(deadlineMs: number, now: () => number, signal: AbortSignal | undefined): Promise<(() => void) | null> {
  const previous = scanSlotTail;
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  // The slot chain advances past this waiter only when it releases (or gives up).
  scanSlotTail = previous.then(() => mine);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const acquired = await Promise.race([
    previous.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, deadlineMs - now()));
      timer.unref?.();
      if (signal) {
        onAbort = () => resolve(false);
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }),
  ]);
  clearTimeout(timer);
  if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  if (!acquired) {
    release();
    return null;
  }
  return release;
}

/** Lines longer than this are not buffered: counted unparseable and skipped to the next newline. */
const MAX_LINE_BYTES = 256 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

type FileScanStop = "time_budget" | "max_bytes" | null;

/**
 * Stream one file line by line (memory O(chunk + longest kept line)),
 * yielding to the event loop every `LINES_PER_CHECK` lines; the abort signal
 * and the scan deadline are checked at every yield, so both interrupt a large
 * file mid-way. Returns the bytes consumed and why it stopped early, if it did.
 */
async function scanFile(
  file: string,
  accumulator: AgentEventTailAccumulator,
  budget: { remainingBytes: number; deadlineMs: number; now: () => number; signal: AbortSignal | undefined },
): Promise<{ bytes: number; stop: FileScanStop }> {
  const stream = createReadStream(file, { highWaterMark: READ_CHUNK_BYTES });
  let bytes = 0;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let skippingLongLine = false;
  let lines = 0;
  const handleLine = (buf: Buffer) => {
    const text = buf.toString("utf8");
    if (text.trim().length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      accumulator.addUnparseable();
      return;
    }
    accumulator.addRecord(parsed);
  };
  try {
    for await (const raw of stream) {
      let chunk = raw as Buffer;
      if (bytes + chunk.byteLength > budget.remainingBytes) {
        // Never count past the cap: consume only up to it, then stop.
        chunk = chunk.subarray(0, Math.max(0, budget.remainingBytes - bytes));
        bytes += chunk.byteLength;
        await consume(chunk);
        return { bytes, stop: "max_bytes" };
      }
      bytes += chunk.byteLength;
      const stop = await consume(chunk);
      if (stop) return { bytes, stop };
    }
    if (pendingBytes > 0 && !skippingLongLine) handleLine(Buffer.concat(pending));
    return { bytes, stop: null };
  } finally {
    stream.destroy();
  }

  async function consume(chunk: Buffer): Promise<FileScanStop> {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const nl = chunk.indexOf(0x0a, offset);
      const end = nl === -1 ? chunk.byteLength : nl;
      const piece = chunk.subarray(offset, end);
      if (!skippingLongLine) {
        if (pendingBytes + piece.byteLength > MAX_LINE_BYTES) {
          skippingLongLine = true;
          pending = [];
          pendingBytes = 0;
          accumulator.addUnparseable();
        } else if (piece.byteLength > 0) {
          pending.push(Buffer.from(piece));
          pendingBytes += piece.byteLength;
        }
      }
      if (nl === -1) break;
      if (!skippingLongLine) handleLine(pending.length === 1 ? pending[0]! : Buffer.concat(pending));
      pending = [];
      pendingBytes = 0;
      skippingLongLine = false;
      offset = nl + 1;
      lines += 1;
      if (lines % LINES_PER_CHECK === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        throwIfAborted(budget.signal);
        if (budget.now() >= budget.deadlineMs) return "time_budget";
      }
    }
    return null;
  }
}

/**
 * Read the local trace corpus and build the bounded object. Only the sink's
 * ROTATING family is read (`traceFileFamily`, trace-client's own
 * classifier): the diag and cli-transport families have their own budgets and
 * no byte cap, and must never consume this scan's caps. Rotating files are
 * read newest first in the sink's own (name) order and are NEVER skipped by
 * their name/creation time (clock steps, pid reuse and late-written spans make
 * that unsafe); the input cost is bounded by `limits` instead, and an early
 * stop is recorded in `scan`. Throws only when `signal` aborts.
 */
export async function collectFeedbackAgentEventTail(input: {
  machineDir: string | null;
  agentId: string;
  feedbackReportId: string;
  requestId: string;
  window: AgentEventTailWindow;
  signal?: AbortSignal;
  limits?: Partial<AgentEventTailScanLimits>;
  nowMs?: () => number;
}): Promise<FeedbackAgentEventTailBuildResult> {
  const limits = { ...AGENT_EVENT_TAIL_SCAN_LIMITS, ...input.limits };
  const now = input.nowMs ?? Date.now;
  const identity = { feedbackReportId: input.feedbackReportId, agentId: input.agentId, requestId: input.requestId, window: input.window };
  if (!input.machineDir) return buildFailedFeedbackAgentEventTail({ ...identity, failure: "corpus_unavailable" });
  const traceDir = path.join(input.machineDir, "traces");
  let names: string[];
  try {
    names = (await readdir(traceDir))
      .filter((n) => n.endsWith(".jsonl") && traceFileFamily(n) === "rotating")
      .sort()
      .reverse();
  } catch {
    throwIfAborted(input.signal);
    return buildFailedFeedbackAgentEventTail({ ...identity, failure: "corpus_unreadable" });
  }
  const accumulator = new AgentEventTailAccumulator({ agentId: input.agentId, window: input.window });
  const deadline = now() + limits.timeBudgetMs;
  let stopReason: FeedbackAgentEventTailScanStopReason | null = null;
  let filesScanned = 0;
  let filesUnreadable = 0;
  let bytesScanned = 0;
  const release = await acquireScanSlot(deadline, now, input.signal);
  if (!release) {
    throwIfAborted(input.signal);
    stopReason = "busy";
  } else {
    // Every exit after the slot is taken goes through `finally`, including an
    // abort that landed while waiting for it: a cancelled scan must never keep
    // the slot (later reports would all read as busy).
    try {
      throwIfAborted(input.signal);
      for (const name of names) {
        throwIfAborted(input.signal);
        if (filesScanned + filesUnreadable >= limits.maxFiles) {
          stopReason = "max_files";
          break;
        }
        if (now() >= deadline) {
          stopReason = "time_budget";
          break;
        }
        const file = path.join(traceDir, name);
        let result: { bytes: number; stop: FileScanStop };
        try {
          const size = (await stat(file)).size;
          if (bytesScanned + size > limits.maxBytes) {
            stopReason = "max_bytes";
            break;
          }
          result = await scanFile(file, accumulator, { remainingBytes: limits.maxBytes - bytesScanned, deadlineMs: deadline, now, signal: input.signal });
        } catch (err) {
          throwIfAborted(input.signal);
          void err;
          filesUnreadable += 1;
          continue;
        }
        // A file stopped mid-way still counts as scanned; its counts are partial.
        bytesScanned += result.bytes;
        filesScanned += 1;
        if (result.stop) {
          stopReason = result.stop;
          break;
        }
        // Yield between files so a large corpus never monopolises the event loop.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      release();
    }
  }
  throwIfAborted(input.signal);
  const scan: FeedbackAgentEventTailScan = {
    status: stopReason !== null || filesUnreadable > 0 ? "incomplete" : "complete",
    stopReason,
    filesListed: names.length,
    filesScanned,
    filesUnreadable,
    bytesScanned,
    maxFiles: limits.maxFiles,
    maxBytes: limits.maxBytes,
  };
  try {
    return buildBoundedFeedbackAgentEventTail({ ...identity, scan, accumulator });
  } catch (err) {
    logger.warn(`[FeedbackAgentEventTail] projection failed for report=${input.feedbackReportId} agent=${input.agentId}: ${err instanceof Error ? err.message : String(err)}`);
    return buildFailedFeedbackAgentEventTail({ ...identity, failure: "projection_error" });
  }
}

export type AgentEventTailStage = "collect" | "attestation" | "create" | "put";

export type FeedbackAgentEventTailOutcome =
  | { status: "uploaded"; traceBundleId: string; bytes: number; collection: "ok" | "failed" }
  | { status: "unsupported"; stage: "attestation" | "create"; error: string }
  | { status: "failed"; stage: AgentEventTailStage | null; reason?: "session_kind_not_acknowledged"; error: string }
  /** The budget elapsed. `storage: unknown` when the abort hit the PUT (the object may have been stored). */
  | { status: "timeout"; stage: AgentEventTailStage; storage: "not_stored" | "unknown" }
  /** Even the failure object exceeds the cap: nothing uploaded. */
  | { status: "omitted"; reason: "over_byte_cap"; bytes: number };

class AgentEventTailUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentEventTailUnsupportedError";
  }
}

class AgentEventTailSessionNotAcknowledgedError extends Error {
  constructor() {
    super("trace upload worker did not echo feedbackAttachmentKind=agent_event_tail; not uploaded");
    this.name = "AgentEventTailSessionNotAcknowledgedError";
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function httpStatusErrorIn(err: unknown): HttpStatusError | null {
  for (let e: unknown = err, i = 0; e && i < 5; e = (e as { cause?: unknown }).cause, i += 1) {
    if (e instanceof HttpStatusError) return e;
  }
  return null;
}

export interface StartFeedbackAgentEventTailInput {
  agentId: string;
  feedbackReportId: string;
  requestId: string;
  reportGeneratedAt: string;
  machineDir: string | null;
  serverUrl: string;
  daemonApiKey: string;
  workerUrl: string;
  tracer: Tracer;
  fetchImpl: FetchLike;
  budgetMs?: number;
  uploadTimeoutMs?: number;
  scanLimits?: Partial<AgentEventTailScanLimits>;
  /** Test seam: replaces the corpus read. Must honour `signal`. */
  collect?: (signal: AbortSignal) => Promise<FeedbackAgentEventTailBuildResult>;
}

/**
 * Collect and upload one agent_event_tail under its own budget. Never
 * rejects; resolves with exactly one outcome (at the latest when the budget
 * elapses — in-flight work is aborted, and its late result is ignored).
 */
export function startFeedbackAgentEventTail(input: StartFeedbackAgentEventTailInput): Promise<FeedbackAgentEventTailOutcome> {
  const tag = `report=${input.feedbackReportId} agent=${input.agentId} request=${input.requestId}`;
  const controller = new AbortController();
  const budgetMs = input.budgetMs ?? AGENT_EVENT_TAIL_BUDGET_MS;
  // Mutated from the upload callbacks; read when the budget fires.
  const progress: { stage: AgentEventTailStage } = { stage: "collect" };
  // A call, so control-flow narrowing of the assignments above never applies.
  const stageNow = (): AgentEventTailStage => progress.stage;
  const span = input.tracer.startSpan("daemon.feedback_agent_event_tail.upload", {
    surface: "daemon",
    kind: "producer",
    attrs: { agentId: input.agentId, feedbackReportId: input.feedbackReportId },
  });

  const work = async (): Promise<FeedbackAgentEventTailOutcome> => {
    const window = agentEventTailWindow(input.reportGeneratedAt);
    if (!window) return { status: "failed", stage: "collect", error: "report time is not a timestamp" };
    const built = input.collect
      ? await input.collect(controller.signal)
      : await collectFeedbackAgentEventTail({
        machineDir: input.machineDir,
        agentId: input.agentId,
        feedbackReportId: input.feedbackReportId,
        requestId: input.requestId,
        window,
        signal: controller.signal,
        ...(input.scanLimits ? { limits: input.scanLimits } : {}),
      });
    if (!built.ok) return { status: "omitted", reason: "over_byte_cap", bytes: built.bytes };
    progress.stage = "attestation";
    const gzipped = gzipSync(Buffer.from(built.json, "utf8"));
    const bundleSha256 = createHash("sha256").update(gzipped).digest("hex");
    const bundleId = randomUUID();
    try {
      const uploaded = await uploadWithSignedCapability({
        serverUrl: input.serverUrl,
        apiKey: input.daemonApiKey,
        workerUrl: input.workerUrl,
        scope: "daemon-trace-bundle:create",
        createPath: "/api/trace-bundles",
        createBody: { bundleSha256, bundleSizeBytes: gzipped.byteLength },
        // Bounded ids only. The object's content (events, counts, scan) travels
        // in the PUT body and nowhere else.
        attestationMetadata: {
          bundleId,
          bundleSha256,
          bundleSizeBytes: gzipped.byteLength,
          bundleContentType: "application/json",
          bundleContentEncoding: "gzip",
          feedbackReportId: input.feedbackReportId,
          agentId: input.agentId,
          feedbackAttachmentKind: "agent_event_tail",
          feedbackTranscriptRequestId: input.requestId,
        },
        // An older server drops an unknown kind and signs anyway; the object
        // must then never reach the worker (it would be filed as traces).
        verifyCapability: (capability) => {
          if (capability.metadata?.feedbackAttachmentKind !== "agent_event_tail") {
            throw new AgentEventTailUnsupportedError("server did not sign feedbackAttachmentKind=agent_event_tail (older server); not uploaded");
          }
          progress.stage = "create";
        },
        verifySession: (_capability, session) => {
          if (session.feedbackAttachmentKind !== "agent_event_tail") throw new AgentEventTailSessionNotAcknowledgedError();
          progress.stage = "put";
        },
        uploadBody: new Blob([new Uint8Array(gzipped)], { type: "application/json" }),
        fetchImpl: input.fetchImpl,
        timeoutMs: input.uploadTimeoutMs ?? AGENT_EVENT_TAIL_UPLOAD_TIMEOUT_MS,
        signal: controller.signal,
      });
      const traceBundleId = typeof uploaded.session.id === "string" ? uploaded.session.id : bundleId;
      return { status: "uploaded", traceBundleId, bytes: built.bytes, collection: built.envelope.collection.status };
    } catch (err) {
      if (err instanceof AgentEventTailUnsupportedError) return { status: "unsupported", stage: "attestation", error: err.message };
      if (err instanceof AgentEventTailSessionNotAcknowledgedError) {
        return { status: "failed", stage: "create", reason: "session_kind_not_acknowledged", error: err.message };
      }
      const http = httpStatusErrorIn(err);
      if (stageNow() === "create" && http?.status === 400 && http.serverError === AGENT_EVENT_TAIL_OLD_WORKER_UNSUPPORTED_ERROR) {
        return { status: "unsupported", stage: "create", error: http.serverError };
      }
      return { status: "failed", stage: stageNow(), error: messageOf(err) };
    }
  };

  return new Promise<FeedbackAgentEventTailOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: FeedbackAgentEventTailOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Resolve first: a throwing logger or span sink below must not strand the outcome.
      resolve(outcome);
      try {
        record(outcome);
      } catch {
        // Diagnostics only; never an unhandled rejection or uncaught exception.
      }
    };
    const record = (outcome: FeedbackAgentEventTailOutcome) => {
      const level = outcome.status === "uploaded" ? "info" : "warn";
      logger[level](`[FeedbackAgentEventTail] ${outcome.status} ${tag}${"stage" in outcome && outcome.stage ? ` stage=${outcome.stage}` : ""}${"error" in outcome ? `: ${outcome.error}` : ""}`);
      span.end(outcome.status === "uploaded" ? "ok" : "error", {
        attrs: {
          outcome: outcome.status,
          ...("stage" in outcome && outcome.stage ? { stage: outcome.stage } : {}),
          ...(outcome.status === "uploaded" ? { tail_bytes: outcome.bytes, collection_status: outcome.collection } : {}),
          ...(outcome.status === "timeout" ? { storage: outcome.storage } : {}),
        },
      });
    };
    const timer = setTimeout(() => {
      const at = progress.stage;
      controller.abort();
      settle({ status: "timeout", stage: at, storage: at === "put" ? "unknown" : "not_stored" });
    }, budgetMs);
    timer.unref?.();
    Promise.resolve()
      .then(work)
      .then(settle, (err: unknown) => {
        if (controller.signal.aborted) return; // the budget already recorded the outcome
        settle({ status: "failed", stage: progress.stage, error: messageOf(err) });
      })
      .catch(() => undefined); // terminal: nothing here may surface as an unhandled rejection
  });
}
