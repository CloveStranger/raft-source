// agent_event_tail objects (task #1230) are validated BEFORE they are stored:
// raw UTF-8 JSON under the shared 32 KiB cap, the strict shared parser (every
// count relation and the per-kind attribute table), and report / agent /
// request identity equal to what the server signed. They are never trace
// JSONL and are never routed into OTLP ingest.
import { FEEDBACK_AGENT_EVENT_TAIL_MAX_BYTES, parseFeedbackAgentEventTailJson, type FeedbackAgentEventTail } from "@botiverse/raft-shared";
import { HttpError } from "../shared/http";
import { gunzipWithLimit } from "./machineEvidence";

export async function validateAgentEventTailObject(
  body: ArrayBuffer,
  signed: { feedbackReportId?: string; agentId?: string; requestId?: string },
): Promise<void> {
  const raw = await gunzipWithLimit(body, FEEDBACK_AGENT_EVENT_TAIL_MAX_BYTES, "agent event tail");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new HttpError(400, "agent event tail is not valid UTF-8");
  }
  let envelope: FeedbackAgentEventTail;
  try {
    envelope = parseFeedbackAgentEventTailJson(text);
  } catch (err) {
    throw new HttpError(400, `agent event tail rejected: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (
    envelope.feedbackReportId !== signed.feedbackReportId
    || envelope.agentId !== signed.agentId
    || envelope.requestId !== signed.requestId
  ) {
    throw new HttpError(400, "agent event tail report/agent/request does not match the attestation");
  }
}
