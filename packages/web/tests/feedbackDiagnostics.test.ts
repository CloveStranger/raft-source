import assert from "node:assert/strict";
import { createDiagnosticsSubmission, FEEDBACK_DIAGNOSTICS_EVENT } from "../src/feedback/standalone/diagnostics";
import type { DiagnosticsActions, DiagnosticsState } from "../src/feedback/standalone/diagnostics";
import type { FeedbackHost } from "../src/feedback/standalone/host";

function fixture(timeoutMs = 120_000, prepared?: { ref: typeof ref | null; submissionId: string | null }) {
  const events = new EventTarget();
  const abort = new AbortController();
  const starts: string[] = [], cancels: string[] = [];
  const host: FeedbackHost = { version: "raft-feedback-v1", session: { accountId: "a", sessionGeneration: 1, webViewGeneration: 2, accessToken: "synthetic", apiOrigin: "https://raft.test", clientKind: "android", clientVersion: "1", locale: "en", theme: "elegant", mode: "light" }, emit: () => {}, capabilities: ["diagnostics-upload-v1"], diagnostics: { start: r => { starts.push(r.requestId); }, cancel: r => { cancels.push(r.requestId); } } };
  let current: FeedbackHost | null = host;
  let actions!: DiagnosticsActions;
  let state!: DiagnosticsState;
  const calls: { ref: unknown; id: string | null; signal: AbortSignal }[] = [];
  let failure: unknown = null;
  const flow = createDiagnosticsSubmission({ host, readHost: () => current, events, signal: abort.signal, timeoutMs, prepared,
    submit: async (ref, id, signal) => { calls.push({ ref, id, signal }); if (failure) throw failure; return "ticket"; },
    onState: (s, a) => { state = s; actions = a; },
  });
  function emit(detail: object) {
    const e = new Event(FEEDBACK_DIAGNOSTICS_EVENT);
    Object.assign(e, { detail: { requestId: starts[0], binding: { accountId: "a", sessionGeneration: 1, webViewGeneration: 2 }, ...detail } });
    events.dispatchEvent(e);
  }
  return { flow, emit, calls, cancels, starts, abort, get actions() { return actions; }, get state() { return state; }, changeAccount: () => { current = null; events.dispatchEvent(new Event("raft:feedback-session-updated")); }, fail: (code: string, status = 400) => { failure = new Error("failed", { cause: { response: { status, data: { code } } } }); }, recover: () => { failure = null; } };
}
const ref = { r2_key: "feedback/synthetic/presigned/11111111-1111-4111-8111-111111111111-diagnostics.zip", filename: "diagnostics.zip", content_type: "application/zip", size: 12 };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("matching done submits only copied reference once; stale and duplicate events do not submit", async () => {
  const f = fixture();
  f.emit({ type: "done", requestId: "stale", ref });
  f.emit({ type: "done", binding: { accountId: "b", sessionGeneration: 1, webViewGeneration: 2 }, ref });
  f.emit({ type: "done", ref: { ...ref, size: 201 * 1024 * 1024 } });
  f.emit({ type: "done", ref: { ...ref, filename: "/private/local/diagnostics.zip" } });
  assert.equal(f.calls.length, 0);
  f.emit({ type: "done", ref: { ...ref, client_key: "must-not-forward", upload_url: "must-not-forward" } });
  f.emit({ type: "done", ref });
  assert.equal(await f.flow.result, "ticket");
  assert.deepEqual(f.calls.map(c => c.ref), [ref]);
});
test("skip invalidates before native cancel and late completion; exactly one create", async () => {
  const f = fixture();
  f.actions.skip(); f.actions.skip(); f.emit({ type: "done", ref });
  assert.equal(await f.flow.result, "ticket");
  assert.equal(f.cancels.length, 1);
  assert.deepEqual(f.calls.map(c => c.ref), [null]);
});
test("watchdog continues without diagnostics and repeated non-progress cannot keep it alive", async () => {
  const f = fixture(10);
  f.emit({ type: "progress", sent: 0, total: 12 });
  assert.equal(f.state.phase, "uploading");
  for (let i = 0; i < 3; i++) { f.emit({ type: "progress", sent: 0, total: 12 }); await tick(); }
  assert.equal(await f.flow.result, "ticket");
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].ref, null);
});
test("close/account change cancels without creating; ignores old terminal", async () => {
  for (const kind of ["close", "account"]) {
    const f = fixture();
    const rejected = assert.rejects(f.flow.result, { name: "AbortError" });
    if (kind === "close") f.abort.abort(); else f.changeAccount();
    f.emit({ type: "done", ref }); await rejected;
    assert.equal(f.calls.length, 0); assert.equal(f.cancels.length, 1);
  }
});
test("ordinary and 409 failures retry original reference/ID without uploading again", async () => {
  for (const [code, status] of [["feedback_invalid", 400], ["feedback_submission_conflict", 409], ["feedback_diagnostics_rejected", 503]] as const) {
    const f = fixture(); f.fail(code, status); f.emit({ type: "done", ref }); await tick();
    assert.deepEqual(f.state, { phase: "failed", canOmit: false, rejected: status >= 400 && status < 500 });
    f.actions.omit(); assert.equal(f.calls.length, 1);
    f.recover(); f.actions.retry(); assert.equal(await f.flow.result, "ticket");
    assert.deepEqual(f.calls.map(c => ({ ref: c.ref, id: c.id })), [{ ref, id: null }, { ref, id: null }]);
    assert.equal(f.starts.length, 1);
  }
});
test("explicit definitive rejection omission changes ID once; duplicate click ignored", async () => {
  for (const code of ["feedback_diagnostics_invalid", "feedback_diagnostics_rejected"]) {
    const f = fixture(); f.fail(code); f.emit({ type: "done", ref }); await tick();
    assert.deepEqual(f.state, { phase: "failed", canOmit: true, rejected: true });
    f.recover(); f.actions.omit(); f.actions.omit();
    assert.equal(await f.flow.result, "ticket");
    assert.equal(f.calls.length, 2); assert.equal(f.calls[1].ref, null);
    assert.match(f.calls[1].id!, /^[0-9a-f-]{36}$/); assert.equal(f.starts.length, 1);
  }
});
test("native fixed failure continues once; unknown failure is ignored", async () => {
  const f = fixture(); f.emit({ type: "failed", reason: "unknown" }); assert.equal(f.calls.length, 0);
  f.emit({ type: "failed", reason: "generate_failed" }); assert.equal(await f.flow.result, "ticket");
  assert.equal(f.calls[0].ref, null);
});

test("closing during create aborts the request and never accepts a late success", async () => {
  const f = fixture();
  const rejected = assert.rejects(f.flow.result, { name: "AbortError" });
  f.emit({ type: "done", ref });
  assert.equal(f.calls.length, 1);
  f.abort.abort();
  await rejected;
  assert.equal(f.calls[0].signal.aborted, true);
});

test("return to editing rejects original error, unlocks workspace and makes no extra request", async () => {
  for (const [code, status] of [["feedback_invalid", 400], ["too_large", 413], ["feedback_submission_conflict", 409], ["feedback_integration_unavailable", 503]] as const) {
    const f = fixture(); f.fail(code, status);
    const rejected = assert.rejects(f.flow.result, error => error instanceof Error && error.message === "failed");
    f.emit({ type: "done", ref }); await tick();
    f.actions.returnToEdit(); f.actions.retry(); f.emit({ type: "done", ref });
    await rejected;
    assert.deepEqual(f.state, { phase: "idle" });
    assert.equal(f.calls.length, 1);
  }
});

test("resuming an unchanged draft uses prepared reference and chosen ID without another upload", async () => {
  for (const value of [ref, null]) {
    const f = fixture(120_000, { ref: value, submissionId: "replacement-id" });
    assert.equal(await f.flow.result, "ticket");
    assert.equal(f.starts.length, 0);
    assert.deepEqual(f.calls.map(c => ({ ref: c.ref, id: c.id })), [{ ref: value, id: "replacement-id" }]);
  }
});
