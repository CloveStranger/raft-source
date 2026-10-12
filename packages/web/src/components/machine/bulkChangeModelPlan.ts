import { getModelLabel, getRuntimeDisplayName } from "@botiverse/raft-shared";
import type { ReasoningEffort, RuntimeAccountUsageSnapshot, RuntimeConfig } from "@botiverse/raft-shared";
import {
  buildRuntimeConfig,
  runtimeConfigFastMode,
  runtimeIgnoresModel,
  supportsRuntimeFastMode,
} from "../../utils/runtimeConfigForm";

/**
 * Bulk "Change model" planner (task #1287, designs from task #1285).
 *
 * Pure: given the selected agents and one target, it decides per agent what
 * the apply step will do. The component only renders these rows and sends the
 * requests they describe, so every product rule lives here and is unit-tested.
 *
 * Contract (kept identical to the single-agent editor):
 * - Each agent is saved through the same `PATCH /agents/:id`; the server saves
 *   first and then restarts a running agent (forcing a session reset when the
 *   runtime or a Codex model changes). Stopped agents are only saved.
 * - Only settings this flow can rebuild safely are changed. Agents whose
 *   runtime config carries anything we would otherwise drop (custom provider,
 *   custom command, custom model name, schema-backed or provider-catalog
 *   runtimes) are excluded with a reason instead of being silently rewritten.
 * - A retry carries each unfinished agent's phase. `restart_pending` means the
 *   config already matches the target and only the restart is owed; it must
 *   NOT be treated as "no change".
 */

export interface BulkModelTarget {
  runtime: string;
  model: string;
  reasoningEffort: ReasoningEffort | null;
}

export type BulkUnfinishedPhase = "save_failed" | "restart_pending";

export interface BulkPlanAgentInput {
  id: string;
  runtime: string;
  model: string;
  reasoningEffort: ReasoningEffort | null;
  runtimeConfig?: RuntimeConfig | null;
  envVars?: Record<string, string> | null;
  external?: boolean;
  /** Agent is running now, so applying will restart it. */
  running: boolean;
  /** From the agent's runtime-options read; `false` = this agent may not select
   *  the target runtime. `undefined` = not known yet / not needed. */
  targetRuntimeAllowed?: boolean;
  /** Set only when re-opened from a partial-failure receipt. */
  phase?: BulkUnfinishedPhase;
}

export type BulkSkipReason = "customSettings" | "runtimeUnavailable" | "noChange";

export type BulkPlanRow =
  | {
      agentId: string;
      kind: "change";
      runtimeChanges: boolean;
      /** Whether the PATCH carries a restart (the agent is running). */
      restarts: boolean;
    }
  | {
      agentId: string;
      kind: "restartOnly";
      restarts: true;
    }
  | {
      agentId: string;
      kind: "skip";
      reason: BulkSkipReason;
    };

export interface BulkPlan {
  rows: BulkPlanRow[];
  /** Agents that will receive a request. */
  applyCount: number;
  /** Running agents among them (drives the single "N running agents will restart." line). */
  restartCount: number;
}

/** Runtimes whose model list does not depend on per-agent provider state. */
const BULK_UNSUPPORTED_RUNTIMES = new Set(["builtin", "pi", "kimi-sdk"]);

export function isBulkSelectableRuntime(runtime: string): boolean {
  return !BULK_UNSUPPORTED_RUNTIMES.has(runtime) && !runtimeIgnoresModel(runtime);
}

/**
 * True when this flow can rebuild the agent's config without dropping anything
 * the user set. Conservative on purpose: anything it does not understand is
 * left to the single-agent editor.
 */
export function agentHasOnlyRebuildableSettings(agent: BulkPlanAgentInput): boolean {
  if (agent.external) return false;
  if (!isBulkSelectableRuntime(agent.runtime)) return false;
  const config = agent.runtimeConfig;
  if (!config) return true;
  if (config.runtime !== agent.runtime) return false;
  if (config.model.kind !== "preset") return false;
  const provider = (config as { provider?: { kind?: string } }).provider;
  if (provider && provider.kind !== "default") return false;
  const command = (config as { command?: string | null }).command;
  if (typeof command === "string" && command.trim()) return false;
  return true;
}

function sameTarget(agent: BulkPlanAgentInput, target: BulkModelTarget): boolean {
  return agent.runtime === target.runtime
    && agent.model === target.model
    && (agent.reasoningEffort ?? null) === (target.reasoningEffort ?? null);
}

export function planBulkModelChange(agents: readonly BulkPlanAgentInput[], target: BulkModelTarget): BulkPlan {
  const rows: BulkPlanRow[] = agents.map((agent) => {
    if (agent.phase === "restart_pending" && sameTarget(agent, target)) {
      return { agentId: agent.id, kind: "restartOnly", restarts: true };
    }
    if (!agentHasOnlyRebuildableSettings(agent)) {
      return { agentId: agent.id, kind: "skip", reason: "customSettings" };
    }
    const runtimeChanges = agent.runtime !== target.runtime;
    if (runtimeChanges && agent.targetRuntimeAllowed === false) {
      return { agentId: agent.id, kind: "skip", reason: "runtimeUnavailable" };
    }
    if (sameTarget(agent, target)) {
      return { agentId: agent.id, kind: "skip", reason: "noChange" };
    }
    return { agentId: agent.id, kind: "change", runtimeChanges, restarts: agent.running };
  });
  const applying = rows.filter((row) => row.kind !== "skip");
  return {
    rows,
    applyCount: applying.length,
    restartCount: applying.filter((row) => row.restarts).length,
  };
}

/**
 * The PATCH body for one agent. Keeps the agent's own env vars, and its fast
 * mode when it stays on a runtime that supports it. Provider/command are never
 * present here because such agents are excluded by the planner.
 */
export function buildBulkAgentUpdate(agent: BulkPlanAgentInput, target: BulkModelTarget): {
  runtime: string;
  model: string;
  reasoningEffort: ReasoningEffort | null;
  runtimeConfig: RuntimeConfig;
} {
  const keepFast = agent.runtime === target.runtime
    && supportsRuntimeFastMode(target.runtime)
    && !!agent.runtimeConfig
    && runtimeConfigFastMode(agent.runtimeConfig);
  const envVars = agent.runtimeConfig?.envVars ?? agent.envVars ?? null;
  const runtimeConfig = buildRuntimeConfig({
    runtime: target.runtime,
    model: target.model,
    customModelMode: false,
    fastMode: keepFast,
    reasoningEffort: target.reasoningEffort,
    envVars,
  });
  return {
    runtime: target.runtime,
    model: target.model,
    reasoningEffort: target.reasoningEffort,
    runtimeConfig,
  };
}

/**
 * After a failed request, decide from a FRESH read of the agent what is still
 * owed. The server saves before it restarts, so a request can fail after the
 * new config is already stored: then only the restart is owed.
 */
export function classifyUnfinished(
  fresh: { runtime: string; model: string; reasoningEffort: ReasoningEffort | null } | null,
  target: BulkModelTarget,
): BulkUnfinishedPhase {
  if (fresh && fresh.runtime === target.runtime && fresh.model === target.model
    && (fresh.reasoningEffort ?? null) === (target.reasoningEffort ?? null)) {
    return "restart_pending";
  }
  return "save_failed";
}

/** "Model" or "Runtime · Model" for the review rows and the success banner. */
export function formatBulkModelLabel(runtime: string, model: string, withRuntime: boolean): string {
  const modelLabel = getModelLabel(runtime, model) || model;
  return withRuntime ? [getRuntimeDisplayName(runtime), modelLabel].join(" · ") : modelLabel;
}

/**
 * One-line usage state for a runtime option in the bulk dialog (task #1292,
 * design #1285 step 3: "Max · 42% used" / "Plus · limit reached, resets …").
 * Read-only decision support: it never changes what the flow applies.
 * Returns null when there is nothing trustworthy to say.
 */
export type BulkRuntimeUsageSummary =
  | { kind: "limit"; plan: string | null; resetsAt: string | null }
  | { kind: "used"; plan: string | null; percent: number }
  | { kind: "attention"; plan: string | null };

export function summarizeRuntimeUsage(snapshot: RuntimeAccountUsageSnapshot | null): BulkRuntimeUsageSummary | null {
  const account = snapshot?.accounts[0];
  if (!account) return null;
  const plan = account.planLabel ?? null;
  const limited = account.windows.find((window) => window.status === "limit_reached");
  if (limited) return { kind: "limit", plan, resetsAt: limited.resetsAt ?? null };
  if (account.health !== "ok") return { kind: "attention", plan };
  const ratios = account.windows
    .filter((window) => window.status === "ok" && typeof window.usedRatio === "number")
    .map((window) => window.usedRatio as number);
  if (ratios.length === 0) return null;
  return { kind: "used", plan, percent: Math.round(Math.max(...ratios) * 100) };
}
