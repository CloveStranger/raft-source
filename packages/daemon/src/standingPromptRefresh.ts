import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentConfig } from "@botiverse/raft-shared";
import { axSurface, composeAxSurfaces, type AxSurfaceText } from "./agentRuntimeInput";

/**
 * task #13 — keeping a resumed session's standing prompt current.
 *
 * Several runtimes keep the standing prompt their session started with and
 * ignore a new one passed at resume, until their next context compaction:
 * Codex from 0.105 (`developerInstructions` on `thread/resume`; 0.104 and
 * earlier appended it), Claude Code (`--append-system-prompt*` on `--resume`,
 * 2.1.288). Runtimes without a native standing prompt (Cursor, Gemini,
 * Copilot) only ever get it in a fresh session's first input. So a rule added
 * to the standing prompt never reached an existing session.
 *
 * The daemon records, per agent, a hash of the standing prompt each session
 * runs on. When a resumed session's recorded hash differs from the current
 * one, the full current prompt is put at the front of that launch's first
 * input, marked as replacing the earlier standing instructions. Nothing
 * earlier in the conversation changes, so the runtime's prompt cache stays
 * valid. A session with no record yet gets one written (`baseline_unknown`)
 * without an injection, so rolling this out does not inject into every agent
 * at once. Runtimes that rebuild the prompt on every launch (driver flag
 * `standingPromptRefreshesOnResume`: Pi / Built-in, OpenCode) are skipped.
 *
 * The hash ignores the parts of the prompt that change on every release or
 * launch (STANDING_PROMPT_VOLATILE_FIELDS): those reach a running session in
 * other ways (the daemon release notice), and hashing them would re-inject the
 * whole prompt into every agent on every release.
 */

/**
 * Config fields whose changes alone never count as a new standing prompt.
 * Pinned by a test: adding one here (or a new volatile field to the prompt)
 * is a deliberate decision.
 */
export const STANDING_PROMPT_VOLATILE_FIELDS = [
  // "- Daemon: vX" in Current Runtime Context; changes on every release.
  "runtimeContext.daemonVersion",
  // The daemon release notice section and its startup step; per launch.
  "runtimeProfileControl",
] as const;

/** `config` with the volatile fields cleared: the prompt built from it is what is hashed (and injected). */
export function stableStandingPromptConfig(config: AgentConfig): AgentConfig {
  return {
    ...config,
    runtimeProfileControl: null,
    ...(config.runtimeContext ? { runtimeContext: { ...config.runtimeContext, daemonVersion: undefined } } : {}),
  };
}

export function standingPromptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 32);
}

interface LedgerRecord {
  version: 1;
  sessionId: string;
  promptHash: string;
  recordedAtMs: number;
}

const FILE_NAME = "standing-prompt.json";

/** One record per agent, in its workspace's hidden `.raft/` (never listed). Ids, a hash and a time only. */
export class StandingPromptLedger {
  constructor(private readonly agentsDir: string, private readonly now: () => number = Date.now) {}

  private file(agentId: string): string {
    return path.join(this.agentsDir, agentId, ".raft", FILE_NAME);
  }

  read(agentId: string): LedgerRecord | null {
    try {
      const value = JSON.parse(readFileSync(this.file(agentId), "utf8")) as Partial<LedgerRecord>;
      if (value?.version !== 1 || typeof value.sessionId !== "string" || typeof value.promptHash !== "string") return null;
      return { version: 1, sessionId: value.sessionId, promptHash: value.promptHash, recordedAtMs: typeof value.recordedAtMs === "number" ? value.recordedAtMs : 0 };
    } catch {
      return null;
    }
  }

  write(agentId: string, sessionId: string, promptHash: string): void {
    const file = this.file(agentId);
    mkdirSync(path.dirname(file), { recursive: true });
    const record: LedgerRecord = { version: 1, sessionId, promptHash, recordedAtMs: this.now() };
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(record));
    renameSync(tmp, file);
  }
}

export type StandingPromptRefreshPlan =
  /** Not a resume, or the runtime rebuilds the prompt itself. */
  | { action: "none" }
  /** Resumed session already on this prompt. */
  | { action: "unchanged" }
  /** Resumed session with no record (or a record of another session): record it, inject nothing. */
  | { action: "baseline_unknown" }
  /** Resumed session on an older prompt: inject the current one. */
  | { action: "inject"; staleForMs: number };

export function planStandingPromptRefresh(input: {
  ledger: StandingPromptLedger;
  agentId: string;
  /** The session this launch resumes; null for a fresh session. */
  resumeSessionId: string | null;
  refreshesOnResume: boolean;
  promptHash: string;
  nowMs: number;
}): StandingPromptRefreshPlan {
  if (!input.resumeSessionId || input.refreshesOnResume) return { action: "none" };
  let record: LedgerRecord | null;
  try {
    record = input.ledger.read(input.agentId);
  } catch {
    record = null;
  }
  if (!record || record.sessionId !== input.resumeSessionId) return { action: "baseline_unknown" };
  if (record.promptHash === input.promptHash) return { action: "unchanged" };
  return { action: "inject", staleForMs: Math.max(0, input.nowMs - record.recordedAtMs) };
}

export const formatStandingPromptUpdate = axSurface(
  "Current standing prompt re-delivered at the front of a resumed session's first input, when the runtime keeps the session's original standing prompt (task #13).",
  (standingPrompt: string): string => [
    "<raft-standing-prompt-update>",
    "Raft updated your standing instructions since this session started. The instructions below replace the earlier standing instructions (system or developer prompt) for the rest of this session; where they differ, follow these.",
    "",
    standingPrompt,
    "</raft-standing-prompt-update>",
    "",
    "",
  ].join("\n"),
  { examples: [{ args: ["You are \"Example\", an AI agent in Raft. <standing prompt>"] }] },
);

export function applyStandingPromptUpdate(
  plan: StandingPromptRefreshPlan,
  standingPrompt: string,
  prompt: AxSurfaceText,
  promptSource: string,
): { prompt: AxSurfaceText; promptSource: string } {
  if (plan.action !== "inject") return { prompt, promptSource };
  return { prompt: composeAxSurfaces(formatStandingPromptUpdate(standingPrompt), prompt), promptSource: `${promptSource}_with_standing_prompt_update` };
}
