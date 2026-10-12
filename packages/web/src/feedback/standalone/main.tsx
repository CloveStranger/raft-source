import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { FeedbackProvider, FeedbackWorkspace } from "@botiverse/hands-feedback-react";
import type { HandsFeedbackTransport } from "@botiverse/hands-feedback-react";
import { ThemeProvider, Button, Lightbox, LightboxContent, LightboxClose, LightboxStage, LightboxMedia } from "raft-ui";
import { createHandsFeedbackTransport } from "../createHandsFeedbackTransport";
import { FEEDBACK_SESSION_UPDATED, createNativeFeedbackClient, emitFeedbackEvent, readFeedbackHost, sameFeedbackSession } from "./host";
import type { FeedbackHost, FeedbackHostEvent } from "./host";
import { createDiagnosticsSubmission } from "./diagnostics";
import type { DiagnosticsActions, DiagnosticsState, DiagnosticsReference } from "./diagnostics";
declare const __RAFT_FEEDBACK_COPY__: Record<"en" | "zh-CN", Record<string, string>>;
import "./styles.css";

function FeedbackPage({ host, authPending, onTerminal }: { host: FeedbackHost; authPending: boolean; onTerminal: (event: FeedbackHostEvent) => void }) {
  const initial = useRef(host);
  const client = useMemo(() => createNativeFeedbackClient(initial.current, readFeedbackHost, onTerminal), [onTerminal]);
  const [diagnosticsState, setDiagnosticsState] = useState<DiagnosticsState>({ phase: "idle" });
  const [withoutDiagnostics, setWithoutDiagnostics] = useState(false);
  const diagnosticsDialog = useRef<HTMLDivElement | null>(null);
  // Focus only after the asynchronous status dialog has mounted.
  // oxlint-disable-next-line react-doctor/no-event-handler
  useEffect(() => { if (diagnosticsState.phase !== "idle") diagnosticsDialog.current?.focus(); }, [diagnosticsState.phase]);
  const diagnosticsActions = useRef<DiagnosticsActions | null>(null);
  const skipDiagnostics = useCallback(() => diagnosticsActions.current?.skip(), []);
  const retrySubmission = useCallback(() => diagnosticsActions.current?.retry(), []);
  const omitDiagnostics = useCallback(() => diagnosticsActions.current?.omit(), []);
  const returnToEdit = useCallback(() => diagnosticsActions.current?.returnToEdit(), []);
  const pendingSubmission = useRef<{ id: string; input: Parameters<HandsFeedbackTransport["createTicket"]>[0]; metadata: Promise<Record<string, string> | null>; prepared?: { ref: DiagnosticsReference | null; submissionId: string | null } } | null>(null);
  const activeSubmission = useRef<{ dispose: () => void } | null>(null);
  const transport = useMemo(() => {
    const metadata = async () => { const current = readFeedbackHost() ?? initial.current; return { client_kind: current.session.clientKind, platform: current.session.clientKind, client_version: current.session.clientVersion, locale: current.session.locale }; };
    const ordinary = createHandsFeedbackTransport(client, { metadata });
    return { ...ordinary, async createTicket(input: Parameters<typeof ordinary.createTicket>[0]) {
      const current = readFeedbackHost();
      if (!current?.capabilities?.includes("diagnostics-upload-v1") || !current.diagnostics) return ordinary.createTicket(input);
      if (activeSubmission.current) throw new Error("feedback_submission_in_progress");
      // Keep the exact payload and metadata for every attempt, even if the form or token changes.
      setWithoutDiagnostics(false);
      if (pendingSubmission.current?.id !== input.submissionId) {
        pendingSubmission.current = { id: input.submissionId, input: { ...input, attachments: [...input.attachments] }, metadata: metadata() };
      }
      const pending = pendingSubmission.current;
      const snapshot = { ...pending.input, onAttachmentProgress: input.onAttachmentProgress };
      const snapshotMetadata = pending.metadata;
      const flow = createDiagnosticsSubmission({
        prepared: pending.prepared,
        onPrepared: (ref, submissionId) => { pending.prepared = { ref, submissionId }; },
        onWithoutDiagnostics: () => setWithoutDiagnostics(true),
        host: current, readHost: readFeedbackHost, events: window, signal: input.signal,
        submit: (ref, newSubmissionId, signal) => createHandsFeedbackTransport(client, { metadata: async () => snapshotMetadata, diagnostics: ref })
          .createTicket({ ...snapshot, signal, submissionId: newSubmissionId ?? snapshot.submissionId }),
        onState: (state, actions) => { diagnosticsActions.current = actions; setDiagnosticsState(state); },
      });
      activeSubmission.current = flow;
      try { const result = await flow.result; pendingSubmission.current = null; return result; } finally { activeSubmission.current = null; }
    } };
  }, [client]);
  useEffect(() => () => { activeSubmission.current?.dispose(); }, []);
  const alive = useRef(true);
  const attachmentController = useMemo(() => new AbortController(), []);
  useEffect(() => () => { alive.current = false; attachmentController.abort(); }, [attachmentController]);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState(false);
  // Object URLs must also be released when the native view is destroyed.
  // oxlint-disable-next-line react-doctor/no-event-handler
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const showAttachment = useCallback(async ({ ticketId, attachmentId }: { ticketId: string; attachmentId: string }) => {
    setError(false);
    try {
      const blob = await transport.getAttachment?.({ ticketId, attachmentId, signal: attachmentController.signal });
      if (blob && alive.current) setPreview(URL.createObjectURL(blob));
    } catch { if (alive.current) setError(true); }
  }, [transport, attachmentController]);
  const openAttachment = useCallback((input: { ticketId: string; attachmentId: string }) => { void showAttachment(input); }, [showAttachment]);
  const openPending = useCallback(({ file }: { file: File }) => setPreview(URL.createObjectURL(file)), []);
  const changePreview = useCallback((open: boolean) => { if (!open) setPreview(null); }, []);
  const messages = __RAFT_FEEDBACK_COPY__[host.session.locale];
  const sdkMessages = useMemo(() => ({ errorUnauthorized: messages[authPending ? "feedback.native.authRequired" : "feedback.native.authRestored"] }), [messages, authPending]);
  return <ThemeProvider theme={host.session.theme} mode={host.session.mode}>
    <div className="feedback-entry">
      {withoutDiagnostics && <p className="feedback-diagnostics-notice" role="status">{messages["feedback.native.diagnostics.unavailable"]}</p>}
      {error && <p role="alert">{messages["settings.about.feedbackAttachmentOpenError"]}</p>}
      <div inert={diagnosticsState.phase !== "idle" || undefined} style={{ height: "100%" }}><FeedbackProvider transport={transport} locale={host.session.locale} theme={host.session.theme} messages={sdkMessages}>
        <FeedbackWorkspace enablePullToRefresh hideHeaderTitle onOpenAttachment={openAttachment} onOpenPendingAttachment={openPending} />
      </FeedbackProvider></div>
      {diagnosticsState.phase !== "idle" && <div className="feedback-diagnostics-status" ref={diagnosticsDialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={messages["feedback.native.diagnosticsTitle"]}>
        <div className="feedback-diagnostics-card">
          <p role="status">{messages[diagnosticsState.phase === "failed" && diagnosticsState.rejected ? "feedback.native.diagnostics.rejected" : `feedback.native.diagnostics.${diagnosticsState.phase}`]}</p>
          {diagnosticsState.phase === "preparing" && <progress aria-label={messages["feedback.native.diagnostics.preparing"]} />}
          {diagnosticsState.phase === "uploading" && <progress max={diagnosticsState.total} value={diagnosticsState.sent} aria-label={messages["feedback.native.diagnostics.uploading"]} />}
          {(diagnosticsState.phase === "preparing" || diagnosticsState.phase === "uploading") && <Button type="button" onClick={skipDiagnostics}>{messages["feedback.native.diagnostics.skip"]}</Button>}
          {diagnosticsState.phase === "failed" && <>
            <Button type="button" onClick={returnToEdit}>{messages["feedback.native.diagnostics.edit"]}</Button>
            <Button type="button" onClick={retrySubmission}>{messages["feedback.native.diagnostics.retry"]}</Button>
            {diagnosticsState.canOmit && <Button type="button" onClick={omitDiagnostics}>{messages["feedback.native.diagnostics.omit"]}</Button>}
          </>}
        </div>
      </div>}
      {preview && <Lightbox open onOpenChange={changePreview}><LightboxContent aria-label={messages["settings.about.feedbackTitle"]}><LightboxClose aria-label={messages["common.lightbox.close"]} /><LightboxStage><LightboxMedia><img src={preview} alt="" /></LightboxMedia></LightboxStage></LightboxContent></Lightbox>}
    </div>
  </ThemeProvider>;
}
function FeedbackEntry() {
  const [host, setHost] = useState(readFeedbackHost);
  const [authPending, setAuthPending] = useState(false);
  const lastHost = useRef(host);
  const binding = useRef(host?.session ?? null);
  const readySent = useRef(false);
  const onTerminal = useCallback((event: FeedbackHostEvent) => { if (event === "auth-required") setAuthPending(true); else setHost(null); }, []);
  useEffect(() => {
    if (host && !readySent.current) { readySent.current = true; emitFeedbackEvent(host, "ready"); }
    const update = () => {
      const next = readFeedbackHost();
      if (binding.current && next && !sameFeedbackSession(binding.current, next.session)) {
        emitFeedbackEvent({ ...next, session: binding.current }, "close");
        setHost(null);
      } else { if (next && !binding.current) binding.current = next.session; setHost(next); if (next) { lastHost.current = next; setAuthPending(false); } }
    };
    window.addEventListener(FEEDBACK_SESSION_UPDATED, update);
    return () => window.removeEventListener(FEEDBACK_SESSION_UPDATED, update);
  }, [host]);
  // No login UI, token storage, main App, account bootstrap or server load.
  const session = host?.session ?? lastHost.current?.session;
  const locale = session?.locale ?? (navigator.language.startsWith("zh") ? "zh-CN" : "en");
  return <ThemeProvider theme={session?.theme ?? "elegant"} mode={session?.mode ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")}>
    {host ? <><div inert={authPending || undefined}><FeedbackPage host={host} authPending={authPending} onTerminal={onTerminal} /></div>{authPending && <p className="feedback-host-status feedback-auth-status" role="status">{__RAFT_FEEDBACK_COPY__[locale]["feedback.native.authRequired"]}</p>}</> : <p className="feedback-host-status" role="status">{__RAFT_FEEDBACK_COPY__[locale]["feedback.native.hostRequired"]}</p>}
  </ThemeProvider>;
}
createRoot(document.getElementById("root")!).render(<FeedbackEntry />);
