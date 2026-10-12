// task #1230: the daemon side of the agent_event_tail attachment.
//
// - it starts only AFTER the transcript result frame is sent and nothing on
//   the existing path awaits it;
// - it has its own budget whose abort reaches the in-flight fetch;
// - unsupported is claimed only on a distinguishable signal (the server did
//   not sign the kind; the old worker's exact 400 string), never retried;
// - the input scan is bounded by independent caps and says when it stopped;
// - the table survives the REAL local trace writer (which drops `*path*`,
//   `*_id` and `*message*` keys).
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, chmod, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import {
  BasicTracer,
  FEEDBACK_AGENT_EVENT_TAIL_EVENT_SPECS,
  MemoryTraceSink,
  parseFeedbackAgentEventTailJson,
  type AgentEventTailAttrSpec,
  type FeedbackAgentEventTailOk,
} from "@botiverse/raft-shared";
import { createTraceClient, LocalRotatingTraceSink } from "@botiverse/raft-trace-client";
import {
  AGENT_EVENT_TAIL_OLD_WORKER_UNSUPPORTED_ERROR,
  agentEventTailWindow,
  collectFeedbackAgentEventTail,
  startFeedbackAgentEventTail,
  type FeedbackAgentEventTailOutcome,
} from "./feedbackAgentEventTail";
import { runFeedbackTranscriptRequest } from "./feedbackTranscriptOutcomeUpload";
import { logger } from "./logger";
import { feedbackTranscriptCollectorErrorResult, type FeedbackTranscriptCollectionResult } from "./feedbackTranscriptCollector";

const REPORT = "6f1c2a52-0d4e-4c8b-9a51-3e2f7b9d1c40";
const AGENT = "0b7e4f9a-5c21-4d36-8e1f-a2c94d7b6e15";
const REQUEST = "req-1";
const SERVER_URL = "https://server.test";
const WORKER_URL = "https://worker.test";
const SENTINEL = "SENTINEL_EVENT_CONTENT";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-event-tail-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

interface Hops {
  calls: Array<{ hop: "attestation" | "create" | "put"; body: string; signal: AbortSignal | null | undefined }>;
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
}

/** A fake server + worker. Each hop handler may return a Response or a never-settling promise. */
function hops(handlers: {
  attestation?: (metadata: Record<string, unknown>) => Response | Promise<Response>;
  create?: () => Response | Promise<Response>;
  put?: () => Response | Promise<Response>;
} = {}): Hops {
  const calls: Hops["calls"] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (input.endsWith("/internal/machine/scope-attestation")) {
      calls.push({ hop: "attestation", body, signal: init?.signal });
      const metadata = (JSON.parse(body) as { metadata: Record<string, unknown> }).metadata;
      return handlers.attestation
        ? handlers.attestation(metadata)
        : json({ attestation: "att", scope: "daemon-trace-bundle:create", audience: "trace-ingest-worker", resource: null, metadata, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    }
    if (input === `${WORKER_URL}/api/trace-bundles`) {
      calls.push({ hop: "create", body, signal: init?.signal });
      return handlers.create ? handlers.create() : json({ id: "upload-1", feedbackAttachmentKind: "agent_event_tail", upload: { method: "PUT", url: `${WORKER_URL}/put/upload-1` } });
    }
    if (input === `${WORKER_URL}/put/upload-1`) {
      calls.push({ hop: "put", body: "", signal: init?.signal });
      return handlers.put ? handlers.put() : new Response(null, { status: 200 });
    }
    throw new Error(`unexpected fetch ${input}`);
  };
  return { calls, fetchImpl };
}

function startInput(machineDir: string | null, h: Hops, extra: Partial<Parameters<typeof startFeedbackAgentEventTail>[0]> = {}) {
  return {
    agentId: AGENT,
    feedbackReportId: REPORT,
    requestId: REQUEST,
    reportGeneratedAt: new Date(Date.now() + 1000).toISOString(),
    machineDir,
    serverUrl: SERVER_URL,
    daemonApiKey: "key",
    workerUrl: WORKER_URL,
    tracer: new BasicTracer({ sink: new MemoryTraceSink() }),
    fetchImpl: h.fetchImpl,
    ...extra,
  };
}

async function corpus(dir: string, files: Record<string, unknown[]>): Promise<string> {
  await mkdir(path.join(dir, "traces"), { recursive: true });
  for (const [name, records] of Object.entries(files)) {
    await writeFile(path.join(dir, "traces", name), records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");
  }
  return dir;
}

function dropped(time: string, extra: Record<string, unknown> = {}) {
  return { type: "event", name: "daemon.agent.inbox.dropped_on_exit", time, attrs: { agentId: AGENT, agent_id: AGENT, exit_reason: "silent_stop", dropped_count: 2, expected: true, ...extra } };
}

const never = <T>() => new Promise<T>(() => undefined);

// --- T1′ / T8′: after the frame, never awaited ---------------------------------

const FRAME: FeedbackTranscriptCollectionResult = { ...feedbackTranscriptCollectorErrorResult("baseline"), machineEvidence: { status: "timeout", error: "machine evidence did not finish within 10000ms" } };

test("T1′/T8′ the tail starts only after send, is never awaited by the frame or by transcript_outcome, and a hanging tail changes nothing", async () => {
  const order: string[] = [];
  const baselineSent: unknown[] = [];
  await runFeedbackTranscriptRequest({
    collect: async () => FRAME,
    send: (r) => { baselineSent.push(r); },
    uploadOutcome: async () => undefined,
    workerConfigured: true,
    tag: "baseline",
  });

  const sent: unknown[] = [];
  let tailStarted = false;
  const run = await runFeedbackTranscriptRequest({
    collect: async () => { order.push("collect"); return FRAME; },
    send: (r) => { order.push(`send:tailStarted=${tailStarted}`); sent.push(r); },
    uploadOutcome: async () => { order.push("outcome"); },
    uploadAgentEventTail: () => { tailStarted = true; order.push("tail"); return never(); },
    workerConfigured: true,
    tag: "with-tail",
  });
  assert.deepEqual(sent, baselineSent, "the frame is identical with and without the tail");
  assert.deepEqual(order.slice(0, 2), ["collect", "send:tailStarted=false"]);
  assert.ok(order.includes("tail"), "the tail was started");
  // transcript_outcome settles while the tail is still pending forever.
  await run.outcome;
  assert.ok(order.includes("outcome"));
  assert.ok(run.agentEventTail, "the tail promise is exposed, never awaited");
});

test("T8′ a tail that throws synchronously or rejects never escapes, never changes the frame", async () => {
  for (const tail of [() => { throw new Error("sync"); }, () => Promise.reject(new Error("async"))]) {
    const sent: unknown[] = [];
    const run = await runFeedbackTranscriptRequest({
      collect: async () => FRAME,
      send: (r) => { sent.push(r); },
      uploadOutcome: async () => undefined,
      uploadAgentEventTail: tail as () => Promise<unknown>,
      workerConfigured: true,
      tag: "t",
    });
    await run.outcome;
    await run.agentEventTail;
    assert.equal(sent.length, 1);
  }
});

test("T8′ no worker configured → the tail is not started", async () => {
  let started = false;
  await runFeedbackTranscriptRequest({
    collect: async () => FRAME,
    send: () => undefined,
    uploadOutcome: async () => undefined,
    uploadAgentEventTail: async () => { started = true; },
    workerConfigured: false,
    tag: "t",
  });
  assert.equal(started, false);
});

// --- T8b: own budget, real cancellation ------------------------------------------

test("T8b slow collection past the budget → timeout at stage collect, no fetch at all, exactly one outcome", async () => {
  const h = hops();
  const outcome = await startFeedbackAgentEventTail({ ...startInput(null, h), budgetMs: 30, collect: () => never() });
  assert.deepEqual(outcome, { status: "timeout", stage: "collect", storage: "not_stored" });
  assert.equal(h.calls.length, 0);
});

test("T8b a hanging PUT past the budget: the abort reaches fetch, outcome timeout/put with storage unknown, no further fetch", async () => {
  await withTempDir(async (dir) => {
    await corpus(dir, { "daemon-trace-2026-10-08T03-00-00-000Z-1-0000.jsonl": [dropped(new Date().toISOString())] });
    const h = hops({ put: () => never() });
    const outcome = await startFeedbackAgentEventTail({ ...startInput(dir, h), budgetMs: 200 });
    assert.deepEqual(outcome, { status: "timeout", stage: "put", storage: "unknown" });
    assert.deepEqual(h.calls.map((c) => c.hop), ["attestation", "create", "put"]);
    assert.ok(h.calls.every((c) => c.signal?.aborted === true), "every hop saw the budget's (now aborted) signal");
  });
});

test("T8b a failing upload is one failed outcome; no retry", async () => {
  const h = hops({ create: () => json({ error: "boom" }, 500) });
  const outcome = await startFeedbackAgentEventTail(startInput(null, h));
  assert.equal(outcome.status, "failed");
  assert.deepEqual(h.calls.map((c) => c.hop), ["attestation", "create"]);
});

// --- T9′ / T10′: conservative compatibility ---------------------------------------

test("T9′ server did not sign the kind (old server) → unsupported at attestation, zero worker contact", async () => {
  const h = hops({
    attestation: (metadata) => {
      const { feedbackAttachmentKind: _drop, ...signed } = metadata;
      return json({ attestation: "att", scope: "s", audience: "a", resource: null, metadata: signed, expiresAt: new Date().toISOString() });
    },
  });
  const outcome = await startFeedbackAgentEventTail(startInput(null, h));
  assert.equal(outcome.status, "unsupported");
  assert.equal((outcome as { stage?: string }).stage, "attestation");
  assert.deepEqual(h.calls.map((c) => c.hop), ["attestation"]);
});

test("T10′ worker classification: only stage create + 400 + the exact string is unsupported", async () => {
  const cases: Array<[string, () => Response, FeedbackAgentEventTailOutcome["status"]]> = [
    ["exact old-worker string", () => json({ error: AGENT_EVENT_TAIL_OLD_WORKER_UNSUPPORTED_ERROR }, 400), "unsupported"],
    ["another validation 400", () => json({ error: "attestation.metadata.feedbackReportId is invalid" }, 400), "failed"],
    ["string with a suffix", () => json({ error: `${AGENT_EVENT_TAIL_OLD_WORKER_UNSUPPORTED_ERROR}!` }, 400), "failed"],
    ["non-JSON 400", () => new Response("<html>bad</html>", { status: 400 }), "failed"],
    ["exact string but 500", () => json({ error: AGENT_EVENT_TAIL_OLD_WORKER_UNSUPPORTED_ERROR }, 500), "failed"],
    ["session without the kind echo", () => json({ id: "upload-1", upload: { method: "PUT", url: `${WORKER_URL}/put/upload-1` } }), "failed"],
  ];
  for (const [name, create, expected] of cases) {
    const h = hops({ create });
    const outcome = await startFeedbackAgentEventTail(startInput(null, h));
    assert.equal(outcome.status, expected, name);
    assert.deepEqual(h.calls.map((c) => c.hop), ["attestation", "create"], `${name}: one request per hop, no PUT, no retry`);
    if (expected === "unsupported") assert.equal((outcome as { stage?: string }).stage, "create");
  }
});

test("T11′ the signed request carries bounded ids only: no events, counts or scan facts", async () => {
  await withTempDir(async (dir) => {
    await corpus(dir, { "daemon-trace-2026-10-08T03-00-00-000Z-1-0000.jsonl": [dropped(new Date().toISOString(), { launchId: SENTINEL.replaceAll("_", "-") })] });
    const h = hops();
    const outcome = await startFeedbackAgentEventTail(startInput(dir, h));
    assert.equal(outcome.status, "uploaded");
    const attestation = h.calls.find((c) => c.hop === "attestation")!;
    const metadata = (JSON.parse(attestation.body) as { metadata: Record<string, unknown> }).metadata;
    assert.deepEqual(Object.keys(metadata).sort(), [
      "agentId", "bundleContentEncoding", "bundleContentType", "bundleId", "bundleSha256", "bundleSizeBytes",
      "feedbackAttachmentKind", "feedbackReportId", "feedbackTranscriptRequestId",
    ]);
    for (const c of h.calls) {
      assert.ok(!c.body.includes(SENTINEL.replaceAll("_", "-")), `${c.hop} body carries event content`);
      assert.ok(!/"(counts|events|scan|coverage)"/.test(c.body), `${c.hop} body carries object fields`);
    }
  });
});

// --- scan caps and corpus states -------------------------------------------------

function windowNow() {
  return agentEventTailWindow(new Date(Date.now() + 1000).toISOString())!;
}

async function collect(dir: string | null, limits?: Parameters<typeof collectFeedbackAgentEventTail>[0]["limits"]) {
  const built = await collectFeedbackAgentEventTail({ machineDir: dir, agentId: AGENT, feedbackReportId: REPORT, requestId: REQUEST, window: windowNow(), ...(limits ? { limits } : {}) });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error("unreachable");
  return parseFeedbackAgentEventTailJson(built.json);
}

test("scan caps: max files / max bytes / time budget each stop the scan with an explicit marker; counts cover the scanned part", async () => {
  await withTempDir(async (dir) => {
    const now = new Date().toISOString();
    await corpus(dir, {
      "daemon-trace-2026-01-01-1-0000.jsonl": [dropped(now)],
      "daemon-trace-2026-01-01-1-0001.jsonl": [dropped(now)],
      "daemon-trace-2026-01-01-1-0002.jsonl": [dropped(now)],
    });
    const full = await collect(dir) as FeedbackAgentEventTailOk;
    assert.equal(full.scan.status, "complete");
    assert.equal(full.counts.matched, 3);

    const files = await collect(dir, { maxFiles: 2 }) as FeedbackAgentEventTailOk;
    assert.deepEqual([files.scan.status, files.scan.stopReason, files.scan.filesScanned, files.scan.filesListed], ["incomplete", "max_files", 2, 3]);
    assert.equal(files.counts.matched, 2);

    const bytes = await collect(dir, { maxBytes: 300 }) as FeedbackAgentEventTailOk;
    assert.equal(bytes.scan.stopReason, "max_bytes");
    assert.ok(bytes.scan.bytesScanned <= 300);

    const time = await collect(dir, { timeBudgetMs: 0 }) as FeedbackAgentEventTailOk;
    assert.equal(time.scan.stopReason, "time_budget");
  });
});

test("scan does not skip files by name/creation time: an event in a file 'created' long before the window is still read", async () => {
  await withTempDir(async (dir) => {
    await corpus(dir, { "daemon-trace-2001-01-01T00-00-00-000Z-1-0000.jsonl": [dropped(new Date().toISOString())] });
    const p = await collect(dir) as FeedbackAgentEventTailOk;
    assert.equal(p.counts.matched, 1);
  });
});

test("corpus states: no machine dir → corpus_unavailable; unlistable dir → corpus_unreadable; unreadable file → scan incomplete", async () => {
  assert.deepEqual((await collect(null)).collection, { status: "failed", failure: "corpus_unavailable" });
  await withTempDir(async (dir) => {
    assert.deepEqual((await collect(dir)).collection, { status: "failed", failure: "corpus_unreadable" });
    await corpus(dir, { "daemon-trace-2026-10-08T03-00-00-000Z-1-0000.jsonl": [dropped(new Date().toISOString())], "daemon-trace-2026-10-08T03-05-00-000Z-1-0001.jsonl": [dropped(new Date().toISOString())] });
    if (process.getuid?.() !== 0) {
      await chmod(path.join(dir, "traces", "daemon-trace-2026-10-08T03-00-00-000Z-1-0000.jsonl"), 0o000);
      const p = await collect(dir) as FeedbackAgentEventTailOk;
      assert.equal(p.scan.status, "incomplete");
      assert.equal(p.scan.filesUnreadable, 1);
      assert.equal(p.scan.stopReason, null);
      assert.equal(p.counts.matched, 1);
    }
  });
});

test("uploaded object round-trips through gzip and the strict parser", async () => {
  await withTempDir(async (dir) => {
    await corpus(dir, { "daemon-trace-2026-10-08T03-00-00-000Z-1-0000.jsonl": [dropped(new Date().toISOString()), "{not json"] });
    let putBody: Uint8Array | null = null;
    const h = hops();
    const fetchImpl = async (input: string, init?: RequestInit) => {
      if (input.endsWith("/put/upload-1") && init?.body instanceof Blob) putBody = new Uint8Array(await init.body.arrayBuffer());
      return h.fetchImpl(input, init);
    };
    const outcome = await startFeedbackAgentEventTail({ ...startInput(dir, h), fetchImpl });
    assert.equal(outcome.status, "uploaded");
    const p = parseFeedbackAgentEventTailJson(gunzipSync(putBody!).toString("utf8")) as FeedbackAgentEventTailOk;
    assert.equal(p.counts.unparseable, 1);
    assert.equal(p.requestId, REQUEST);
  });
});

// --- the real local trace writer ------------------------------------------------

function sample(spec: AgentEventTailAttrSpec): unknown {
  switch (spec.kind) {
    case "enum": case "enum_or_other": return spec.values[0];
    case "count": return 3;
    case "integer": return 1;
    case "boolean": return true;
    case "id": return "c0ffee00-0000-4000-8000-000000000001";
    case "signal": return "SIGTERM";
    case "runtime_input_source": return "recycled_wake_inbox_update_with_memory";
  }
}

test("T7 every whitelisted attribute survives the REAL LocalRotatingTraceSink (keys with path / _id / message segments would be dropped)", async () => {
  await withTempDir(async (dir) => {
    const tracer = createTraceClient({ source: "daemon", sinks: [new LocalRotatingTraceSink({ machineDir: dir, maxFileBytes: 1024 * 1024, maxFiles: 4 })] });
    for (const [name, spec] of Object.entries(FEEDBACK_AGENT_EVENT_TAIL_EVENT_SPECS)) {
      const attrs: Record<string, string | number | boolean> = { agentId: AGENT, agent_id: AGENT };
      for (const source of Object.values(spec.attrs)) {
        const key = source.from[0]!;
        if (!key.startsWith("@")) attrs[key] = sample(source.spec) as string | number | boolean;
      }
      if (spec.record === "span") {
        tracer.startSpan(name, { surface: "daemon", kind: "internal", attrs }).end("ok");
      } else {
        tracer.emitEvent(name, { surface: "daemon", attrs: { ...attrs, status: "ok" } });
      }
    }
    // Positive control, identified by a marker count: keys the sink is known to
    // drop (`exit_path`, `wake_message_transient`) do not survive it.
    const CONTROL_MARKER = 987_654;
    tracer.emitEvent("daemon.agent.inbox.dropped_on_exit", { surface: "daemon", attrs: { agentId: AGENT, exit_path: "silent_stop", wake_message_transient: true, dropped_count: CONTROL_MARKER } });
    const p = await collect(dir) as FeedbackAgentEventTailOk;
    const names = new Set(p.events.map((e) => e.name));
    assert.deepEqual([...names].sort(), Object.keys(FEEDBACK_AGENT_EVENT_TAIL_EVENT_SPECS).sort(), "every whitelisted name reached the corpus and was matched");
    const isControl = (e: { name: string; attrs: Record<string, unknown> }) => e.name === "daemon.agent.inbox.dropped_on_exit" && e.attrs.dropped_count === CONTROL_MARKER;
    const controls = p.events.filter(isControl);
    assert.equal(controls.length, 1, "the positive control reached the corpus");
    assert.equal(controls[0]!.attrs.exit_reason, null, "exit_path never becomes exit_reason");
    const real = p.events.filter((e) => !isControl(e));
    assert.equal(real.length, Object.keys(FEEDBACK_AGENT_EVENT_TAIL_EVENT_SPECS).length, "one real event per whitelisted name");
    for (const e of real) {
      for (const [key, value] of Object.entries(e.attrs)) assert.notEqual(value, null, `${e.name}.${key} was dropped by the real trace writer`);
    }
    assert.equal(p.counts.attrInvalidValues, 0);
  });
});

// --- review round 2 --------------------------------------------------------------

/** The sink's own rotating name: daemon-trace-<ISO with : and . as ->-<pid>-<seq4>.jsonl */
function rotatingName(ms: number, pid: number, seq: number): string {
  return `daemon-trace-${new Date(ms).toISOString().replace(/[:.]/g, "-")}-${pid}-${String(seq).padStart(4, "0")}.jsonl`;
}

test("R1 only the sink's rotating family is scanned: 8 diag + 8 cli-transport files (one huge) never crowd out the rotating files", async () => {
  await withTempDir(async (dir) => {
    const now = Date.now();
    const files: Record<string, unknown[]> = {
      [rotatingName(now - 120_000, 4242, 0)]: [dropped(new Date(now - 60_000).toISOString())],
      [rotatingName(now - 60_000, 4242, 1)]: [dropped(new Date(now - 1_000).toISOString())],
    };
    for (let i = 0; i < 8; i++) {
      files[`daemon-trace-diag-corr-${i}.jsonl`] = [{ type: "event", name: "diag", time: new Date(now).toISOString(), attrs: {} }];
      files[`daemon-trace-cli-transport-${new Date(now - i * 1000).toISOString().replace(/[:.]/g, "-")}-99${i}-abcd.jsonl`] = [{ type: "event", name: "cli", time: new Date(now).toISOString(), attrs: {} }];
    }
    await corpus(dir, files);
    // One unbounded cli-transport file far bigger than the byte cap below.
    const huge = path.join(dir, "traces", `daemon-trace-cli-transport-${new Date(now).toISOString().replace(/[:.]/g, "-")}-7-ffff.jsonl`);
    await appendFile(huge, "x".repeat(2 * 1024 * 1024));
    for (const limits of [undefined, { maxBytes: 1024 * 1024 }]) {
      const p = await collect(dir, limits) as FeedbackAgentEventTailOk;
      assert.equal(p.counts.matched, 2, `limits=${JSON.stringify(limits)}: rotating events found`);
      assert.deepEqual([p.scan.status, p.scan.filesListed, p.scan.filesScanned], ["complete", 2, 2], JSON.stringify(limits));
    }
  });
});

async function bigRotatingFile(dir: string, lines: number): Promise<void> {
  await mkdir(path.join(dir, "traces"), { recursive: true });
  const line = `${JSON.stringify(dropped(new Date().toISOString()))}\n`;
  await writeFile(path.join(dir, "traces", rotatingName(Date.now() - 1000, 1, 0)), line.repeat(lines));
}

test("R2 the time budget interrupts a large file mid-way: scan marker time_budget, partial counts, prompt return", async () => {
  await withTempDir(async (dir) => {
    await bigRotatingFile(dir, 20_000);
    let tick = 0;
    const started = Date.now();
    const built = await collectFeedbackAgentEventTail({
      machineDir: dir, agentId: AGENT, feedbackReportId: REPORT, requestId: REQUEST, window: windowNow(),
      limits: { timeBudgetMs: 5 },
      nowMs: () => tick++,
    });
    assert.ok(Date.now() - started < 5_000, "returned promptly");
    assert.equal(built.ok, true);
    if (!built.ok) return;
    const p = parseFeedbackAgentEventTailJson(built.json) as FeedbackAgentEventTailOk;
    assert.equal(p.scan.stopReason, "time_budget");
    assert.equal(p.scan.filesScanned, 1, "the interrupted file counts as scanned (partially)");
    assert.ok(p.counts.matched > 0 && p.counts.matched < 20_000, `partial: matched=${p.counts.matched}`);
  });
});

test("R2 an abort mid-file stops the read promptly (the signal is checked inside the file, not only between files)", async () => {
  await withTempDir(async (dir) => {
    await bigRotatingFile(dir, 20_000);
    const controller = new AbortController();
    let calls = 0;
    const started = Date.now();
    await assert.rejects(collectFeedbackAgentEventTail({
      machineDir: dir, agentId: AGENT, feedbackReportId: REPORT, requestId: REQUEST, window: windowNow(), signal: controller.signal,
      nowMs: () => { calls += 1; if (calls === 4) controller.abort(); return Date.now(); },
    }), /abort/i);
    assert.ok(Date.now() - started < 5_000);
  });
});

test("R2 single flight: a second scan while one runs waits within its own budget, then records stopReason busy", async () => {
  await withTempDir(async (dir) => {
    await bigRotatingFile(dir, 20_000);
    const first = collectFeedbackAgentEventTail({ machineDir: dir, agentId: AGENT, feedbackReportId: REPORT, requestId: REQUEST, window: windowNow() });
    await new Promise((r) => setImmediate(r));
    const second = await collect(dir, { timeBudgetMs: 0 }) as FeedbackAgentEventTailOk;
    assert.deepEqual([second.scan.status, second.scan.stopReason, second.scan.filesScanned], ["incomplete", "busy", 0]);
    const firstBuilt = await first;
    assert.equal(firstBuilt.ok, true);
    const third = await collect(dir) as FeedbackAgentEventTailOk;
    assert.equal(third.scan.status, "complete", "the lock is released after the first scan");
  });
});

test("R5 a cancelled scan never keeps the single-flight slot: pre-aborted, and aborted while waiting for the slot", async () => {
  await withTempDir(async (dir) => {
    await bigRotatingFile(dir, 2_000);
    // (a) Already aborted: the slot is free, so it is taken, then the abort must release it.
    await assert.rejects(
      collectFeedbackAgentEventTail({ machineDir: dir, agentId: AGENT, feedbackReportId: REPORT, requestId: REQUEST, window: windowNow(), signal: AbortSignal.abort() }),
      (err: unknown) => (err as { name?: string }).name === "AbortError",
    );
    const afterPreAbort = await collect(dir) as FeedbackAgentEventTailOk;
    assert.equal(afterPreAbort.scan.stopReason, null, "a pre-aborted scan left the slot taken (next scan read as busy)");
    assert.equal(afterPreAbort.scan.status, "complete");
    // (b) Aborted while waiting behind a running scan, at the wait/acquire boundary.
    await bigRotatingFile(dir, 20_000);
    const first = collectFeedbackAgentEventTail({ machineDir: dir, agentId: AGENT, feedbackReportId: REPORT, requestId: REQUEST, window: windowNow() });
    await new Promise((r) => setImmediate(r));
    const controller = new AbortController();
    const waiting = collectFeedbackAgentEventTail({ machineDir: dir, agentId: AGENT, feedbackReportId: REPORT, requestId: REQUEST, window: windowNow(), signal: controller.signal });
    await new Promise((r) => setImmediate(r));
    controller.abort();
    await assert.rejects(waiting, (err: unknown) => (err as { name?: string }).name === "AbortError");
    assert.equal((await first).ok, true);
    const afterWaitAbort = await collect(dir) as FeedbackAgentEventTailOk;
    assert.equal(afterWaitAbort.scan.stopReason, null, "an abort while waiting left the slot taken");
    assert.equal(afterWaitAbort.scan.status, "complete");
  });
});

test("R4 a throwing logger inside settle never becomes an unhandled rejection; the outcome still resolves", async () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => { throw new Error("logger broke"); });
  const info = vi.spyOn(logger, "info").mockImplementation(() => { throw new Error("logger broke"); });
  try {
    const failing = await startFeedbackAgentEventTail(startInput(null, hops({ create: () => json({ error: "boom" }, 500) })));
    assert.equal(failing.status, "failed");
    const timedOut = await startFeedbackAgentEventTail({ ...startInput(null, hops()), budgetMs: 20, collect: () => never() });
    assert.equal(timedOut.status, "timeout");
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    warn.mockRestore();
    info.mockRestore();
  }
});
