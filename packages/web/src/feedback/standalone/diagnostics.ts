import type { FeedbackBinding, FeedbackHost } from "./host";

export const FEEDBACK_DIAGNOSTICS_EVENT = "raft:feedback-diagnostics";
export type DiagnosticsReference = { r2_key: string; filename: string; content_type: string; size: number };
export type DiagnosticsState =
  | { phase: "idle" }
  | { phase: "preparing" }
  | { phase: "uploading"; sent: number; total: number }
  | { phase: "submitting" }
  | { phase: "failed"; canOmit: boolean; rejected: boolean };
export type DiagnosticsActions = { skip: () => void; retry: () => void; omit: () => void; returnToEdit: () => void };

function matches(a: FeedbackBinding, b: unknown): boolean {
  if (!b || typeof b !== "object") return false;
  const v = b as Partial<FeedbackBinding>;
  return a.accountId === v.accountId && a.sessionGeneration === v.sessionGeneration && a.webViewGeneration === v.webViewGeneration;
}
function reference(value: unknown): DiagnosticsReference | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<DiagnosticsReference>;
  // Reference names deliberately reject control characters and local paths.
  // oxlint-disable-next-line no-control-regex
  if (typeof v.r2_key !== "string" || !/^feedback\/[A-Za-z0-9-]{1,64}\/presigned\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[^/\u0000-\u001f\u007f]{1,255}$/.test(v.r2_key)
    // oxlint-disable-next-line no-control-regex
    || typeof v.filename !== "string" || !/^[^/\\\u0000-\u001f\u007f]{1,251}\.zip$/i.test(v.filename)
    || v.content_type !== "application/zip" || !Number.isSafeInteger(v.size) || v.size! <= 0 || v.size! > 200 * 1024 * 1024) return null;
  // Copy only the reference fields: host secrets, URLs and paths are never forwarded.
  return { r2_key: v.r2_key, filename: v.filename, content_type: v.content_type, size: v.size! };
}
function errorResponse(error: unknown): { status?: number; data?: { code?: string } } | undefined {
  const cause = error instanceof Error ? error.cause ?? error : error;
  if (!cause || typeof cause !== "object") return undefined;
  return (cause as { response?: { status?: number; data?: { code?: string } } }).response;
}
function mayOmit(error: unknown): boolean {
  const r = errorResponse(error);
  return r?.status === 400 && (r.data?.code === "feedback_diagnostics_invalid" || r.data?.code === "feedback_diagnostics_rejected");
}

/** One submission owns one upload and one immutable snapshot. A retry never starts another upload. */
export function createDiagnosticsSubmission<T>(options: {
  host: FeedbackHost;
  readHost: () => FeedbackHost | null;
  events: EventTarget;
  signal: AbortSignal;
  submit: (ref: DiagnosticsReference | null, newSubmissionId: string | null, signal: AbortSignal) => Promise<T>;
  onState: (state: DiagnosticsState, actions: DiagnosticsActions) => void;
  timeoutMs?: number;
  onWithoutDiagnostics?: () => void;
  prepared?: { ref: DiagnosticsReference | null; submissionId: string | null };
  onPrepared?: (ref: DiagnosticsReference | null, submissionId: string | null) => void;
}): { result: Promise<T>; dispose: () => void } {
  const binding = { accountId: options.host.session.accountId, sessionGeneration: options.host.session.sessionGeneration, webViewGeneration: options.host.session.webViewGeneration };
  const submissionController = new AbortController();
  let requestId: string | null = crypto.randomUUID();
  let ref: DiagnosticsReference | null = options.prepared?.ref ?? null;
  let lastError: unknown;
  let replacementId: string | null = options.prepared?.submissionId ?? null;
  let phase: DiagnosticsState["phase"] = "preparing";
  let terminal = false;
  let uploadFinished = false;
  let canOmit = false;
  let sent = -1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const result = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  const current = () => matches(binding, options.readHost()?.session);
  const cancelUpload = () => {
    const id = requestId;
    requestId = null; // Invalidate before invoking native code, which may synchronously emit.
    clearTimeout(timer);
    if (id) {
      try { void Promise.resolve(options.host.diagnostics!.cancel({ requestId: id }, binding)).catch(() => {}); } catch { /* Best effort; stale events are already fenced. */ }
    }
  };
  const cleanup = () => {
    clearTimeout(timer);
    options.events.removeEventListener(FEEDBACK_DIAGNOSTICS_EVENT, receive);
    options.events.removeEventListener("raft:feedback-session-updated", sessionChanged);
    options.signal.removeEventListener("abort", dispose);
  };
  const finishWithError = (error: unknown) => {
    if (terminal) return;
    terminal = true;
    submissionController.abort();
    cancelUpload();
    cleanup();
    options.onState({ phase: "idle" }, actions);
    reject(error);
  };
  const dispose = () => finishWithError(new DOMException("Feedback view closed", "AbortError"));
  const notify = (state: DiagnosticsState) => { phase = state.phase; options.onState(state, actions); };
  const send = async () => {
    if (terminal || phase === "submitting") return;
    if (!current() || options.signal.aborted) { dispose(); return; }
    notify({ phase: "submitting" });
    try {
      const value = await options.submit(ref, replacementId, submissionController.signal);
      if (terminal) return;
      if (!current() || options.signal.aborted) { dispose(); return; }
      terminal = true;
      cleanup();
      notify({ phase: "idle" });
      resolve(value);
    } catch (error) {
      if (terminal) return;
      if (!current() || options.signal.aborted) { dispose(); return; }
      lastError = error;
      canOmit = ref !== null && mayOmit(error);
      const status = errorResponse(error)?.status;
      notify({ phase: "failed", canOmit, rejected: typeof status === "number" && status >= 400 && status < 500 && status !== 408 });
    }
  };
  const skip = (automatic = true) => {
    if (terminal || uploadFinished) return;
    uploadFinished = true;
    cancelUpload();
    ref = null;
    options.onPrepared?.(null, replacementId);
    if (automatic) options.onWithoutDiagnostics?.();
    void send();
  };
  const actions: DiagnosticsActions = {
    skip: () => skip(false),
    retry: () => { if (phase === "failed") void send(); },
    returnToEdit: () => { if (phase === "failed") finishWithError(lastError); },
    omit: () => {
      if (terminal || phase !== "failed" || !canOmit) return;
      ref = null;
      replacementId = crypto.randomUUID();
      options.onPrepared?.(null, replacementId);
      canOmit = false;
      void send();
    },
  };
  const resetTimeout = () => { clearTimeout(timer); timer = setTimeout(() => skip(), options.timeoutMs ?? 120_000); };
  function sessionChanged() { if (!current()) dispose(); }
  function receive(event: Event) {
    if (terminal || uploadFinished) return;
    if (!current()) { dispose(); return; }
    const v = (event as CustomEvent<unknown>).detail;
    if (!v || typeof v !== "object") return;
    const d = v as { requestId?: unknown; binding?: unknown; type?: unknown; sent?: unknown; total?: unknown; ref?: unknown; reason?: unknown };
    if (d.requestId !== requestId || !matches(binding, d.binding)) return;
    if (d.type === "progress") {
      if (!Number.isSafeInteger(d.sent) || !Number.isSafeInteger(d.total) || (d.sent as number) < 0 || (d.total as number) <= 0 || (d.sent as number) > (d.total as number) || (d.total as number) > 200 * 1024 * 1024 || (d.sent as number) <= sent) return;
      sent = d.sent as number;
      resetTimeout();
      notify({ phase: "uploading", sent, total: d.total as number });
    } else if (d.type === "done") {
      const value = reference(d.ref);
      if (!value) return;
      uploadFinished = true;
      requestId = null;
      clearTimeout(timer);
      ref = value;
      options.onPrepared?.(value, replacementId);
      void send();
    } else if (d.type === "failed" && ["generate_failed", "too_large", "upload_failed"].includes(d.reason as string)) skip();
  }
  options.events.addEventListener(FEEDBACK_DIAGNOSTICS_EVENT, receive);
  options.events.addEventListener("raft:feedback-session-updated", sessionChanged);
  options.signal.addEventListener("abort", dispose, { once: true });
  if (options.signal.aborted || !current()) dispose();
  else if (options.prepared) {
    uploadFinished = true;
    requestId = null;
    void send();
  } else {
    notify({ phase: "preparing" });
    resetTimeout();
    try { void Promise.resolve(options.host.diagnostics!.start({ requestId: requestId! }, binding)).catch(() => skip()); } catch { skip(); }
  }
  return { result, dispose };
}
