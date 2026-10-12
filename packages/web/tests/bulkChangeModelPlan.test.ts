import assert from "node:assert/strict";
import type { RuntimeAccountUsageSnapshot, RuntimeConfig } from "@botiverse/raft-shared";
import {
  agentHasOnlyRebuildableSettings,
  buildBulkAgentUpdate,
  classifyUnfinished,
  planBulkModelChange,
  summarizeRuntimeUsage,
} from "../src/components/machine/bulkChangeModelPlan";
import type { BulkModelTarget, BulkPlanAgentInput } from "../src/components/machine/bulkChangeModelPlan";

function agent(overrides: Partial<BulkPlanAgentInput> = {}): BulkPlanAgentInput {
  return {
    id: "a1",
    runtime: "codex",
    model: "gpt-5-codex",
    reasoningEffort: null,
    runtimeConfig: null,
    envVars: null,
    running: false,
    ...overrides,
  };
}

function config(overrides: Record<string, unknown> = {}): RuntimeConfig {
  return {
    version: 1,
    runtime: "claude",
    model: { kind: "preset", id: "opus" },
    mode: { kind: "default" },
    reasoningEffort: null,
    envVars: null,
    ...overrides,
  } as unknown as RuntimeConfig;
}

const toClaudeSonnet: BulkModelTarget = { runtime: "claude", model: "sonnet", reasoningEffort: null };

test("a runtime switch is a change; only running agents restart", () => {
  const plan = planBulkModelChange([
    agent({ id: "stopped" }),
    agent({ id: "running", running: true }),
  ], toClaudeSonnet);
  assert.deepEqual(plan.rows, [
    { agentId: "stopped", kind: "change", runtimeChanges: true, restarts: false },
    { agentId: "running", kind: "change", runtimeChanges: true, restarts: true },
  ]);
  assert.equal(plan.applyCount, 2);
  assert.equal(plan.restartCount, 1);
});

test("an agent already on the target is skipped as no change", () => {
  const plan = planBulkModelChange([
    agent({ runtime: "claude", model: "sonnet", running: true }),
  ], toClaudeSonnet);
  assert.deepEqual(plan.rows, [{ agentId: "a1", kind: "skip", reason: "noChange" }]);
  assert.equal(plan.applyCount, 0);
  assert.equal(plan.restartCount, 0);
});

test("restart_pending at the target restarts instead of being swallowed as no change", () => {
  const pending = agent({ runtime: "claude", model: "sonnet", phase: "restart_pending", running: false });
  const plan = planBulkModelChange([pending], toClaudeSonnet);
  assert.deepEqual(plan.rows, [{ agentId: "a1", kind: "restartOnly", restarts: true }]);
  assert.equal(plan.applyCount, 1);
  assert.equal(plan.restartCount, 1);
  // Same agent without the phase really is a no-op: the phase is what carries the debt.
  const plain = planBulkModelChange([{ ...pending, phase: undefined }], toClaudeSonnet);
  assert.equal(plain.rows[0].kind, "skip");
});

test("restart_pending against a different target is a normal change", () => {
  const plan = planBulkModelChange([
    agent({ runtime: "claude", model: "sonnet", phase: "restart_pending" }),
  ], { runtime: "claude", model: "opus", reasoningEffort: null });
  assert.equal(plan.rows[0].kind, "change");
});

test("agents with settings this flow cannot rebuild are skipped as custom settings", () => {
  const cases: Array<[string, Partial<BulkPlanAgentInput>]> = [
    ["custom provider", { runtime: "claude", runtimeConfig: config({ provider: { kind: "custom", apiUrl: "https://x", apiKey: "k" } }) }],
    ["custom command", { runtime: "claude", runtimeConfig: config({ command: "my-claude --flag" }) }],
    ["custom model name", { runtime: "claude", runtimeConfig: config({ model: { kind: "custom", name: "my-model" } }) }],
    ["builtin runtime", { runtime: "builtin" }],
    ["pi runtime", { runtime: "pi" }],
    ["schema-backed kimi", { runtime: "kimi-sdk" }],
    ["external agent", { external: true }],
  ];
  for (const [label, overrides] of cases) {
    const plan = planBulkModelChange([agent(overrides)], toClaudeSonnet);
    assert.deepEqual(plan.rows[0], { agentId: "a1", kind: "skip", reason: "customSettings" }, label);
  }
});

test("a default provider and env vars do not block the change", () => {
  const input = agent({ runtime: "claude", model: "opus", runtimeConfig: config({ provider: { kind: "default" }, envVars: { FOO: "1" } }) });
  assert.equal(agentHasOnlyRebuildableSettings(input), true);
  assert.equal(planBulkModelChange([input], toClaudeSonnet).rows[0].kind, "change");
});

test("a runtime the agent may not select is skipped; same-runtime changes ignore that read", () => {
  const blocked = planBulkModelChange([agent({ targetRuntimeAllowed: false })], toClaudeSonnet);
  assert.deepEqual(blocked.rows[0], { agentId: "a1", kind: "skip", reason: "runtimeUnavailable" });
  const sameRuntime = planBulkModelChange([
    agent({ runtime: "claude", model: "opus", targetRuntimeAllowed: false }),
  ], toClaudeSonnet);
  assert.equal(sameRuntime.rows[0].kind, "change");
});

test("the update keeps env vars and same-runtime fast mode, and drops fast mode across runtimes", () => {
  const fastClaude = agent({
    runtime: "claude",
    model: "opus",
    runtimeConfig: config({ mode: { kind: "fast" }, envVars: { KEEP: "yes" } }),
  });
  const same = buildBulkAgentUpdate(fastClaude, toClaudeSonnet);
  assert.equal(same.runtime, "claude");
  assert.equal(same.model, "sonnet");
  assert.deepEqual(same.runtimeConfig.model, { kind: "preset", id: "sonnet" });
  assert.deepEqual(same.runtimeConfig.envVars, { KEEP: "yes" });
  assert.equal(same.runtimeConfig.mode.kind, "fast");

  const cross = buildBulkAgentUpdate(fastClaude, { runtime: "codex", model: "gpt-5-codex", reasoningEffort: null });
  assert.equal(cross.runtimeConfig.runtime, "codex");
  assert.deepEqual(cross.runtimeConfig.envVars, { KEEP: "yes" });
  assert.equal(cross.runtimeConfig.mode.kind, "default");
});

test("failures are classified from the fresh read, not from the request result", () => {
  assert.equal(classifyUnfinished({ runtime: "claude", model: "sonnet", reasoningEffort: null }, toClaudeSonnet), "restart_pending");
  assert.equal(classifyUnfinished({ runtime: "codex", model: "gpt-5-codex", reasoningEffort: null }, toClaudeSonnet), "save_failed");
  assert.equal(classifyUnfinished({ runtime: "claude", model: "sonnet", reasoningEffort: "high" }, toClaudeSonnet), "save_failed");
  assert.equal(classifyUnfinished(null, toClaudeSonnet), "save_failed");
});

function usage(account: Record<string, unknown> | null): RuntimeAccountUsageSnapshot {
  return {
    protocolVersion: 2,
    provider: "claude",
    collectedAt: "2026-10-11T10:00:00.000Z",
    staleAfter: "2026-10-11T11:00:00.000Z",
    collectorVersion: "test",
    accounts: account ? [{ accountKey: "k", health: "ok", windows: [], ...account }] : [],
  } as unknown as RuntimeAccountUsageSnapshot;
}

test("runtime usage summary: limit wins, then attention, then the highest used window", () => {
  assert.deepEqual(summarizeRuntimeUsage(usage({
    planLabel: "Plus",
    health: "rate_limited",
    windows: [
      { id: "5h", label: "5-hour", status: "ok", usedRatio: 0.2 },
      { id: "week", label: "Weekly", status: "limit_reached", usedRatio: 1, resetsAt: "2026-10-11T14:30:00.000Z" },
    ],
  })), { kind: "limit", plan: "Plus", resetsAt: "2026-10-11T14:30:00.000Z" });
  assert.deepEqual(summarizeRuntimeUsage(usage({ planLabel: "Max", health: "reauth_required", windows: [] })), { kind: "attention", plan: "Max" });
  assert.deepEqual(summarizeRuntimeUsage(usage({
    planLabel: "Max",
    windows: [
      { id: "5h", label: "5-hour", status: "ok", usedRatio: 0.42 },
      { id: "week", label: "Weekly", status: "ok", usedRatio: 0.1 },
    ],
  })), { kind: "used", plan: "Max", percent: 42 });
});

test("runtime usage summary says nothing it cannot back up", () => {
  assert.equal(summarizeRuntimeUsage(null), null);
  assert.equal(summarizeRuntimeUsage(usage(null)), null);
  assert.equal(summarizeRuntimeUsage(usage({ windows: [{ id: "5h", label: "5-hour", status: "parse_unavailable" }] })), null);
  assert.deepEqual(summarizeRuntimeUsage(usage({ windows: [{ id: "5h", label: "5-hour", status: "limit_reached" }] })), { kind: "limit", plan: null, resetsAt: null });
});
