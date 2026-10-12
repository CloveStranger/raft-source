import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DaemonTraceBundleUploader, selectFilesForPass } from "./traceBundleUpload";

// Task #364: the uploader could not keep up with a busy machine. One pass took
// the first 4 files of a single sorted list, so every rotating file
// (`daemon-trace-2…`) went ahead of `cli-transport-` and `diag-`, and those
// families were pruned before they were ever uploaded.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const OLD = new Date("2026-05-08T00:00:00.000Z");

async function writeTraceFiles(traceDir: string, names: string[]): Promise<void> {
  await mkdir(traceDir, { recursive: true });
  for (const name of names) {
    const file = path.join(traceDir, name);
    await writeFile(file, "{\"type\":\"span\",\"schema_version\":1,\"trace_id\":\"t\",\"span_id\":\"s\"}\n");
    await utimes(file, OLD, OLD);
  }
}

function acceptingFetch(uploadedNames: string[]) {
  let seq = 0;
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url === "https://server.test/internal/machine/scope-attestation") {
      const body = JSON.parse(String(init?.body)) as { metadata: Record<string, unknown> };
      seq += 1;
      return jsonResponse({
        attestation: "signed",
        scope: "daemon-trace-bundle:create",
        audience: "trace-ingest-worker",
        resource: "servers/server-1/machines/machine-1/trace-bundles",
        metadata: { ...body.metadata, uploadId: `upload-${seq}`, objectKey: `k-${seq}`, maxBytes: 50 * 1024 * 1024 },
        expiresAt: "2026-05-08T00:00:00.000Z",
      });
    }
    if (url === "https://worker.test/api/trace-bundles") {
      return jsonResponse({ upload: { method: "PUT", url: `https://storage.test/${seq}`, headers: {} } });
    }
    if (url.startsWith("https://storage.test/")) {
      uploadedNames.push(url);
      return new Response(null, { status: 200 });
    }
    return jsonResponse({ error: `unexpected ${url}` }, 500);
  };
}

async function receipts(machineDir: string): Promise<string[]> {
  try {
    return (await readdir(path.join(machineDir, "trace-uploads")))
      .filter((name) => name.endsWith(".uploaded.json"))
      .map((name) => name.replace(/\.uploaded\.json$/, ""));
  } catch {
    return [];
  }
}

const ROTATING = Array.from({ length: 6 }, (_, i) => `daemon-trace-2026-05-08T00-0${i}-00-000Z-1000-000${i}.jsonl`);
const CLI = "daemon-trace-cli-transport-2026-05-08T00-00-00-000Z-1000.jsonl";
const DIAG = "daemon-trace-diag-2026-05-08T00-00-00-000Z-1000.jsonl";

test("selectFilesForPass takes families in turn, oldest first within each", () => {
  const sorted = [...ROTATING, CLI, DIAG].sort().map((name) => `/t/${name}`);
  assert.deepEqual(
    selectFilesForPass(sorted, 4).map((file) => path.basename(file)),
    [ROTATING[0], CLI, DIAG, ROTATING[1]],
  );
  assert.equal(selectFilesForPass(sorted, 100).length, sorted.length, "everything is taken when the budget allows");
});

test("with a rotating backlog, cli-transport and diag are uploaded in the same pass (task #364)", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-trace-upload-fairness-"));
  try {
    await writeTraceFiles(path.join(machineDir, "traces"), [...ROTATING, CLI, DIAG]);
    const uploader = new DaemonTraceBundleUploader({
      machineDir,
      serverUrl: "https://server.test",
      apiKey: "sk_machine_test",
      workerUrl: "https://worker.test/",
      minFileAgeMs: 0,
      maxFilesPerRun: 4,
      fetchImpl: acceptingFetch([]),
    });
    const result = await uploader.uploadOnce("manual");
    assert.deepEqual(result, { attempted: 8, uploaded: 4, deferred: 4 });
    const done = await receipts(machineDir);
    assert.ok(done.includes(CLI), `cli-transport must get a slot under a rotating backlog, uploaded: ${done.join(", ")}`);
    assert.ok(done.includes(DIAG), `diag must get a slot under a rotating backlog, uploaded: ${done.join(", ")}`);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("a backlog gets bounded catch-up passes after the interval pass, not one pass per 5 min (task #364)", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-trace-upload-catchup-"));
  try {
    const many = Array.from({ length: 30 }, (_, i) => `daemon-trace-2026-05-08T00-${String(i).padStart(2, "0")}-00-000Z-1000-${String(i).padStart(4, "0")}.jsonl`);
    await writeTraceFiles(path.join(machineDir, "traces"), many);
    const pending: Array<{ fn: () => void; ms: number }> = [];
    const timers = {
      setTimeout: ((fn: () => void, ms: number) => { const t = { fn, ms }; pending.push(t); return t; }) as unknown as typeof setTimeout,
      setInterval: globalThis.setInterval.bind(globalThis),
      clearTimeout: ((t: unknown) => { const i = pending.indexOf(t as never); if (i >= 0) pending.splice(i, 1); }) as unknown as typeof clearTimeout,
      clearInterval: globalThis.clearInterval.bind(globalThis),
    };
    const uploader = new DaemonTraceBundleUploader({
      machineDir,
      serverUrl: "https://server.test",
      apiKey: "sk_machine_test",
      workerUrl: "https://worker.test/",
      minFileAgeMs: 0,
      maxFilesPerRun: 4,
      intervalMs: 300_000,
      catchupDelayMs: 15_000,
      maxCatchupPassesPerInterval: 2,
      fetchImpl: acceptingFetch([]),
      timers: timers as never,
    });
    // Fire-and-forget passes do real file I/O, so wait for the effect itself
    // (receipts plus the follow-up timer) rather than a fixed number of ticks.
    const waitFor = async (check: () => Promise<boolean> | boolean, what: string) => {
      const deadline = Date.now() + 10_000;
      while (!(await check())) {
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    const fire = (ms: number) => {
      const t = pending.find((entry) => entry.ms === ms);
      assert.ok(t, `a ${ms} ms timer is pending (have: ${pending.map((e) => e.ms).join(",")})`);
      pending.splice(pending.indexOf(t), 1);
      t.fn();
    };
    const uploadedReaches = (n: number) => waitFor(async () => (await receipts(machineDir)).length >= n, `${n} receipts`);
    const catchupPending = () => pending.some((entry) => entry.ms === 15_000);
    let passes = 0;
    const realUploadOnce = uploader.uploadOnce.bind(uploader);
    uploader.uploadOnce = async (...args) => {
      try { return await realUploadOnce(...args); } finally { passes += 1; }
    };

    uploader.start();
    fire(0); // initial delay (NO_JITTER): first pass, schedules the interval tick
    await uploadedReaches(4);
    await waitFor(catchupPending, "catch-up 1 scheduled");
    fire(15_000);
    await uploadedReaches(8);
    await waitFor(catchupPending, "catch-up 2 scheduled");
    fire(15_000);
    await uploadedReaches(12);
    await waitFor(() => passes >= 3, "third pass finished");
    assert.equal(catchupPending(), false, "no third catch-up within one interval");
    assert.equal((await receipts(machineDir)).length, 12);
    fire(300_000); // next interval tick resets the allowance
    await uploadedReaches(16);
    await waitFor(catchupPending, "the new interval may catch up again");
    uploader.stop();
    assert.equal(pending.length, 0, "stop clears interval and catch-up timers");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

function fakeTimers() {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  const timers = {
    setTimeout: ((fn: () => void, ms: number) => { const t = { fn, ms }; pending.push(t); return t; }) as unknown as typeof setTimeout,
    setInterval: globalThis.setInterval.bind(globalThis),
    clearTimeout: ((t: unknown) => { const i = pending.indexOf(t as never); if (i >= 0) pending.splice(i, 1); }) as unknown as typeof clearTimeout,
    clearInterval: globalThis.clearInterval.bind(globalThis),
  };
  const fire = (ms: number) => {
    const t = pending.find((entry) => entry.ms === ms);
    assert.ok(t, `a ${ms} ms timer is pending (have: ${pending.map((e) => e.ms).join(",")})`);
    pending.splice(pending.indexOf(t), 1);
    t.fn();
  };
  return { pending, timers, fire };
}

async function waitFor(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function writeDistinctTraceFiles(traceDir: string, count: number): Promise<void> {
  await mkdir(traceDir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    const file = path.join(traceDir, `daemon-trace-2026-05-08T00-${String(i).padStart(2, "0")}-00-000Z-1000-${String(i).padStart(4, "0")}.jsonl`);
    await writeFile(file, `{"type":"span","schema_version":1,"trace_id":"t${i}","span_id":"s"}\n`);
    await utimes(file, OLD, OLD);
  }
}

test("an interval tick while a pass is still uploading does not start a second pass on the same files (#9105 review)", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-trace-upload-overlap-"));
  try {
    await writeDistinctTraceFiles(path.join(machineDir, "traces"), 8);
    const { pending, timers, fire } = fakeTimers();
    const shasSent: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let seq = 0;
    const uploader = new DaemonTraceBundleUploader({
      machineDir,
      serverUrl: "https://server.test",
      apiKey: "sk_machine_test",
      workerUrl: "https://worker.test/",
      minFileAgeMs: 0,
      maxFilesPerRun: 4,
      intervalMs: 300_000,
      catchupDelayMs: 15_000,
      maxCatchupPassesPerInterval: 0,
      timers: timers as never,
      fetchImpl: async (url, init) => {
        if (url === "https://server.test/internal/machine/scope-attestation") {
          const body = JSON.parse(String(init?.body)) as { metadata: Record<string, unknown> };
          shasSent.push(String(body.metadata.bundleSha256));
          seq += 1;
          return jsonResponse({
            attestation: "signed",
            scope: "daemon-trace-bundle:create",
            audience: "trace-ingest-worker",
            resource: "servers/server-1/machines/machine-1/trace-bundles",
            metadata: { ...body.metadata, uploadId: `upload-${seq}`, objectKey: `k-${seq}`, maxBytes: 50 * 1024 * 1024 },
            expiresAt: "2026-05-08T00:00:00.000Z",
          });
        }
        if (url === "https://worker.test/api/trace-bundles") {
          return jsonResponse({ upload: { method: "PUT", url: `https://storage.test/${seq}`, headers: {} } });
        }
        if (url.startsWith("https://storage.test/")) {
          await held; // the first upload stays open across the interval tick
          return new Response(null, { status: 200 });
        }
        return jsonResponse({ error: `unexpected ${url}` }, 500);
      },
    });

    uploader.start();
    fire(0); // initial pass starts and blocks on its first upload
    await waitFor(() => shasSent.length === 1, "the first upload to start");
    await waitFor(() => pending.some((entry) => entry.ms === 300_000), "the interval tick to be scheduled");
    fire(300_000); // the tick fires while the initial pass is still uploading
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(shasSent.length, 1, "no second pass started while the first is uploading");
    release();
    await waitFor(async () => (await receipts(machineDir)).length === 4, "the first pass to finish");
    assert.equal(new Set(shasSent).size, shasSent.length, `no file uploaded twice: ${shasSent.length} attestations`);
    uploader.stop();
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("a pass that uploaded nothing does not schedule a catch-up (#9105 review)", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-trace-upload-failing-"));
  try {
    await writeDistinctTraceFiles(path.join(machineDir, "traces"), 8);
    const { pending, timers, fire } = fakeTimers();
    let attempts = 0;
    const uploader = new DaemonTraceBundleUploader({
      machineDir,
      serverUrl: "https://server.test",
      apiKey: "sk_machine_test",
      workerUrl: "https://worker.test/",
      minFileAgeMs: 0,
      maxFilesPerRun: 4,
      intervalMs: 300_000,
      catchupDelayMs: 15_000,
      timers: timers as never,
      fetchImpl: async () => {
        attempts += 1;
        return jsonResponse({ error: "upload server unavailable" }, 503);
      },
    });
    uploader.start();
    fire(0);
    await waitFor(() => attempts >= 4, "the pass to try its 4 files");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await receipts(machineDir)).length, 0);
    assert.equal(pending.some((entry) => entry.ms === 15_000), false, "a failing pass must not speed up retries");
    uploader.stop();
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});
