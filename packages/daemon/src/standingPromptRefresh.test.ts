import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentConfig } from "@botiverse/raft-shared";
import { buildCliTransportSystemPrompt } from "./drivers/cliTransport";
import {
  applyStandingPromptUpdate,
  planStandingPromptRefresh,
  STANDING_PROMPT_VOLATILE_FIELDS,
  stableStandingPromptConfig,
  standingPromptHash,
  StandingPromptLedger,
} from "./standingPromptRefresh";
import type { AxSurfaceText } from "./agentRuntimeInput";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "standing-prompt-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const config = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  name: "agent",
  displayName: "Agent",
  description: "reviews code",
  runtime: "codex",
  model: "gpt-5",
  sessionId: null,
  serverUrl: "http://localhost",
  authToken: "x",
  runtimeContext: { agentId: "a1", serverId: "s1", machineName: "m", machineId: "mid", daemonVersion: "1.0.46", workspacePath: "/w" },
  ...overrides,
} as AgentConfig);
const hashOf = (c: AgentConfig) => standingPromptHash(String(buildCliTransportSystemPrompt(stableStandingPromptConfig(c), { extraCriticalRules: [] })));

test("the volatile fields are pinned: adding one is a deliberate change", () => {
  assert.deepEqual([...STANDING_PROMPT_VOLATILE_FIELDS], ["runtimeContext.daemonVersion", "runtimeProfileControl"]);
});

test("the hash ignores the daemon version and the release notice, and follows everything else", () => {
  const base = hashOf(config());
  assert.equal(hashOf(config({ runtimeContext: { ...config().runtimeContext!, daemonVersion: "1.0.47" } })), base, "a release alone is not a new prompt");
  assert.equal(hashOf(config({ runtimeProfileControl: { kind: "daemon_release_notice", key: "k", message: "Daemon v1.0.47 released" } as never })), base, "nor is its notice");
  assert.notEqual(hashOf(config({ description: "reviews code and docs" })), base, "a real change is");
  // The prompt itself still shows the version to a new session.
  assert.match(String(buildCliTransportSystemPrompt(config(), { extraCriticalRules: [] })), /- Daemon: v1\.0\.46/);
});

test("plan: fresh sessions and self-refreshing runtimes need nothing; a resume is checked against its record", () => {
  const ledger = new StandingPromptLedger(dir, () => 5_000);
  const plan = (resumeSessionId: string | null, promptHash: string, refreshesOnResume = false) =>
    planStandingPromptRefresh({ ledger, agentId: "a1", resumeSessionId, refreshesOnResume, promptHash, nowMs: 9_000 });
  assert.deepEqual(plan(null, "h1"), { action: "none" });
  assert.deepEqual(plan("s1", "h1", true), { action: "none" });
  assert.deepEqual(plan("s1", "h1"), { action: "baseline_unknown" }, "no record yet: no injection");
  ledger.write("a1", "s1", "h1");
  assert.deepEqual(plan("s1", "h1"), { action: "unchanged" });
  assert.deepEqual(plan("s1", "h2"), { action: "inject", staleForMs: 4_000 });
  assert.deepEqual(plan("s2", "h2"), { action: "baseline_unknown" }, "a record of another session says nothing about this one");
  const stored = JSON.parse(readFileSync(path.join(dir, "a1", ".raft", "standing-prompt.json"), "utf8"));
  assert.deepEqual(Object.keys(stored).sort(), ["promptHash", "recordedAtMs", "sessionId", "version"]);
});

test("an injection puts the full current prompt first, marked as replacing the earlier instructions; nothing else is touched", () => {
  const input = "New message received: hello" as AxSurfaceText;
  assert.deepEqual(applyStandingPromptUpdate({ action: "unchanged" }, "PROMPT", input, "wake"), { prompt: input, promptSource: "wake" });
  const applied = applyStandingPromptUpdate({ action: "inject", staleForMs: 1 }, "PROMPT V2", input, "wake");
  assert.equal(applied.promptSource, "wake_with_standing_prompt_update");
  assert.ok(String(applied.prompt).startsWith("<raft-standing-prompt-update>\n"));
  assert.match(String(applied.prompt), /replace the earlier standing instructions/);
  assert.match(String(applied.prompt), /PROMPT V2\n<\/raft-standing-prompt-update>\n\nNew message received: hello$/);
});

test("which runtimes rebuild the standing prompt on resume is pinned (measured, task #13)", async () => {
  const { PiDriver, BuiltInDriver } = await import("./drivers/pi");
  const { OpenCodeDriver } = await import("./drivers/opencode");
  const { KimiSdkDriver } = await import("./drivers/kimi-sdk");
  const { CodexDriver } = await import("./drivers/codex");
  const { ClaudeDriver } = await import("./drivers/claude");
  const { GrokDriver } = await import("./drivers/grok");
  const { CursorDriver } = await import("./drivers/cursor");
  const { GeminiDriver } = await import("./drivers/gemini");
  const { CopilotDriver } = await import("./drivers/copilot");
  const refreshes = (Driver: unknown) =>
    new (Driver as new () => { standingPromptRefreshesOnResume?: boolean })().standingPromptRefreshesOnResume === true;
  // Fresh on resume: Pi / Built-in (systemPromptOverride), OpenCode 1.18.35 and the Kimi SDK 0.34 (measured).
  for (const Driver of [PiDriver, BuiltInDriver, OpenCodeDriver, KimiSdkDriver]) assert.equal(refreshes(Driver), true, Driver.name);
  // Keep the session's original prompt: Codex >= 0.105, Claude Code 2.1.288 (measured); Grok not measured yet;
  // Cursor / Gemini / Copilot have no native standing prompt.
  for (const Driver of [CodexDriver, ClaudeDriver, GrokDriver, CursorDriver, GeminiDriver, CopilotDriver]) assert.equal(refreshes(Driver), false, Driver.name);
});
