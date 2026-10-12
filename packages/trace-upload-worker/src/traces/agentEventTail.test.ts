// task #1230: the worker accepts the agent_event_tail kind, validates the
// object strictly BEFORE storing it, files it in the report ledger, and never
// treats it as traces (no OTLP ingest, no re-ingest).
import { createHash, createHmac } from "node:crypto";
import { gzipSync } from "node:zlib";
import assert from "node:assert/strict";
import { AgentEventTailAccumulator, buildBoundedFeedbackAgentEventTail } from "@botiverse/raft-shared";
import { handleRequest, type TraceUploadWorkerEnv } from "../index";
import { reingestCandidates } from "../reingest";

const SECRET = "agent-event-tail-secret";
const REPORT = "1d6f0b7a-3c2e-4a59-9e8d-5f4b3a2c1e01";
const AGENT = "0b0e2a8e-1d2c-4f3a-9a1b-0c0d0e0f1a2b";
const WINDOW = { requestedFrom: "2026-10-08T03:15:00.000Z", requestedTo: "2026-10-08T03:30:00.000Z" };
const OBJECT_KEY = "feedback-agent-event-tails/server-1/machine-1/upload-aet.json.gz";

class MockR2Bucket {
  puts: Array<{ key: string; body: ArrayBuffer | string }> = [];
  async put(key: string, value: ArrayBuffer | string) {
    this.puts.push({ key, body: value });
    return { etag: "etag" };
  }
  async get(key: string) {
    const put = [...this.puts].reverse().find((p) => p.key === key);
    return put ? { body: new Response(put.body).body } : null;
  }
}

class Ctx {
  promises: Promise<unknown>[] = [];
  waitUntil(p: Promise<unknown>) { this.promises.push(p); }
}

function sign(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${createHmac("sha256", SECRET).update(payload).digest("base64url")}`;
}
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const gz = (text: string) => new Uint8Array(gzipSync(Buffer.from(text, "utf8")));

function env() {
  const bucket = new MockR2Bucket();
  const otlpCalls: number[] = [];
  return {
    bucket,
    otlpCalls,
    env: {
      SCOPE_ATTESTATION_SECRET: SECRET,
      TRACE_BUNDLES: bucket,
      TRACE_INGEST_OTLP_ENDPOINT: "https://telescope.test/v1/traces",
      TRACE_INGEST_FETCH: async () => { otlpCalls.push(1); return new Response(null, { status: 200 }); },
    } as unknown as TraceUploadWorkerEnv,
  };
}

function claims(metadata: Record<string, unknown>) {
  return {
    v: 1, typ: "scope-attestation", scope: "daemon-trace-bundle:create", sub: "machine:machine-1", actorType: "machine",
    machineId: "machine-1", serverId: "server-1", aud: "trace-ingest-worker", resource: "servers/server-1/machines/machine-1/trace-bundles",
    nonce: "n", exp: Math.floor(Date.now() / 1000) + 60, metadata,
  };
}

function tailObject(): Record<string, any> {
  const acc = new AgentEventTailAccumulator({ agentId: AGENT, window: WINDOW });
  acc.addRecord({ type: "event", name: "daemon.agent.inbox.dropped_on_exit", time: "2026-10-08T03:16:00.000Z", attrs: { agentId: AGENT, exit_reason: "silent_stop", dropped_count: 2, expected: true } });
  const built = buildBoundedFeedbackAgentEventTail({
    feedbackReportId: REPORT, agentId: AGENT, requestId: "req-1", window: WINDOW, accumulator: acc,
    scan: { status: "complete", stopReason: null, filesListed: 1, filesScanned: 1, filesUnreadable: 0, bytesScanned: 100, maxFiles: 16, maxBytes: 1024 },
  });
  if (!built.ok) throw new Error("fixture did not build");
  return JSON.parse(built.json) as Record<string, any>;
}

function metadata(body: Uint8Array, extra: Record<string, unknown> = {}) {
  const m: Record<string, unknown> = {
    uploadId: "upload-aet",
    objectKey: OBJECT_KEY,
    bundleId: "bundle-aet",
    bundleSha256: sha(body),
    bundleSizeBytes: body.byteLength,
    maxBytes: 32 * 1024 + 4096,
    bundleContentType: "application/json",
    bundleContentEncoding: "gzip",
    feedbackReportId: REPORT,
    agentId: AGENT,
    feedbackTranscriptRequestId: "req-1",
    feedbackAttachmentKind: "agent_event_tail",
    ...extra,
  };
  for (const k of Object.keys(m)) if (m[k] === undefined) delete m[k];
  return m;
}

async function createAndPut(e: TraceUploadWorkerEnv, ctx: Ctx, meta: Record<string, unknown>, body: Uint8Array<ArrayBuffer>) {
  const createRes = await handleRequest(new Request("https://worker.test/api/trace-bundles", {
    method: "POST",
    body: JSON.stringify({ attestation: sign(claims(meta)), bundleSha256: sha(body), bundleSizeBytes: body.byteLength }),
  }), e);
  if (createRes.status !== 200) return { createRes, putRes: null, session: null };
  const session = await createRes.clone().json() as { upload: { url: string }; feedbackAttachmentKind?: string };
  const putRes = await handleRequest(new Request(session.upload.url, { method: "PUT", body }), e, ctx);
  return { createRes, putRes, session };
}

const reportLedger = (bucket: MockR2Bucket) => {
  const put = [...bucket.puts].reverse().find((p) => p.key === `feedback-report-ledgers/server-1/${REPORT}/trace-upload-aet.json`);
  return put ? JSON.parse(String(put.body)) as Record<string, unknown> : null;
};

test("T12 create echoes the kind; a valid object is stored at its own key, filed in the report ledger, never ingested as traces", async () => {
  const { env: e, bucket, otlpCalls } = env();
  const ctx = new Ctx();
  const body = gz(JSON.stringify(tailObject()));
  const { session, putRes } = await createAndPut(e, ctx, metadata(body), body);
  assert.equal(session?.feedbackAttachmentKind, "agent_event_tail");
  assert.equal(putRes?.status, 200, await putRes?.clone().text());
  await Promise.all(ctx.promises);
  assert.equal(otlpCalls.length, 0);
  assert.ok(bucket.puts.some((p) => p.key === OBJECT_KEY));
  assert.ok(!bucket.puts.some((p) => p.key.startsWith("trace-bundles/")));
  const record = reportLedger(bucket);
  assert.equal(record?.feedback_attachment_kind, "agent_event_tail");
  assert.equal(record?.object_key, OBJECT_KEY);
  assert.equal(record?.request_id, "req-1");
  assert.equal(record?.agent_id, AGENT);
  assert.equal(record?.scopedb_status, "skipped");
});

test("T12 create rejects a tail without report / agent / request binding or not gzipped JSON", async () => {
  const body = gz(JSON.stringify(tailObject()));
  for (const extra of [{ agentId: undefined }, { feedbackReportId: undefined }, { feedbackTranscriptRequestId: undefined }, { bundleContentType: "text/plain" }, { bundleContentEncoding: undefined }]) {
    const { env: e } = env();
    const { createRes } = await createAndPut(e, new Ctx(), metadata(body, extra), body);
    assert.equal(createRes.status, 400, JSON.stringify(extra));
  }
});

test("T12 PUT rejects before storing: identity mismatch, unknown field, broken invariant, over 32 KiB raw", async () => {
  const cases: Array<[string, Record<string, any>]> = [
    ["other report", { ...tailObject(), feedbackReportId: "2e7a1c8b-4d3f-4b6a-8f9e-6a5c4b3d2f02" }],
    ["other agent", { ...tailObject(), agentId: "1b0e2a8e-1d2c-4f3a-9a1b-0c0d0e0f1a2b" }],
    ["other request", { ...tailObject(), requestId: "req-2" }],
    ["unknown field", { ...tailObject(), note: "free text" }],
    ["truncated disagrees", { ...tailObject(), truncated: true }],
    ["coverage claimed", { ...tailObject(), coverage: { status: "complete_with_evidence", coveredFrom: WINDOW.requestedFrom, coveredTo: WINDOW.requestedTo } }],
    ["over cap", { ...tailObject(), pad: "x".repeat(40 * 1024) }],
  ];
  for (const [name, object] of cases) {
    const { env: e, bucket } = env();
    const body = gz(JSON.stringify(object));
    const { putRes } = await createAndPut(e, new Ctx(), metadata(body), body);
    assert.ok(putRes && putRes.status >= 400 && putRes.status < 500, `${name}: ${putRes?.status}`);
    assert.equal(bucket.puts.length, 0, name);
  }
});

test("T12 re-ingest never replays an agent_event_tail ledger as traces", async () => {
  const { env: e, bucket } = env();
  const body = gz(JSON.stringify(tailObject()));
  await createAndPut(e, new Ctx(), metadata(body), body);
  const ledgerKey = "trace-ledgers/server-1/machine-1/upload-aet.json";
  assert.ok(bucket.puts.some((p) => p.key === ledgerKey));
  const { outcomes, failures } = await reingestCandidates(e, [{ upload_id: "upload-aet", ledger_key: ledgerKey }], { entries: { "upload-aet": { group: "zero", row_count: 0 } } }, false);
  assert.equal(failures, 0);
  assert.equal(outcomes[0]?.action, "skipped_not_trace");
});
