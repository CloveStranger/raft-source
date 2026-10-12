import { Button, Spinner } from "raft-ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { ArrowRight, Check, X } from "lucide-react";
import {
  REASONING_EFFORT_RUNTIMES,
  currentTimeMs,
  getDefaultModel,
  getRuntimeDisplayName,
} from "@botiverse/raft-shared";
import type { ReasoningEffort } from "@botiverse/raft-shared";
import api from "../../api/client";
import DialogCard from "../ui/DialogCard";
import AvatarSlot from "../ui/AvatarSlot";
import { RuntimeSelectControl } from "../agent/RuntimeConfigFields";
import { useRuntimeModels } from "../../hooks/useRuntimeModels";
import { fetchExistingAgentRuntimeOptions } from "../../hooks/useRuntimeSelectionCatalog";
import { reasoningEffortOptionsForModel, reconcileReasoningEffort } from "../../utils/reasoningEffortOptions";
import { useAgentStore } from "../../store/agentStore";
import { useServerStore } from "../../store/serverStore";
import { runtimeAccountUsageClient } from "../../utils/runtimeAccountUsageClient";
import { formatRelativeTime } from "../../utils/relativeTime";
import { usageProviderForRuntime } from "./RuntimeAccountUsageChip";
import type { Agent } from "../../store/agentStore";
import type { Machine } from "../../store/machineStore";
import type { BulkChangeReceipt, BulkUnfinishedAgent } from "../../store/bulkChangeModelReceiptStore";
import { BULK_SUCCESS_BANNER_MS } from "../../store/bulkChangeModelReceiptStore";
import {
  buildBulkAgentUpdate,
  classifyUnfinished,
  formatBulkModelLabel,
  isBulkSelectableRuntime,
  planBulkModelChange,
  summarizeRuntimeUsage,
} from "./bulkChangeModelPlan";
import type { BulkModelTarget, BulkPlanAgentInput, BulkPlanRow, BulkRuntimeUsageSummary, BulkUnfinishedPhase } from "./bulkChangeModelPlan";

type Step = "choose" | "review" | "applying";
type ApplyState = "saving" | "saved" | "failed";

const REASONING_DEFAULT_VALUE = "__default__";


const SKIP_REASON_MESSAGE = {
  customSettings: "machine.detail.bulkModel.skip.customSettings",
  runtimeUnavailable: "machine.detail.bulkModel.skip.runtimeUnavailable",
  noChange: "machine.detail.bulkModel.skip.noChange",
} as const;

const APPLY_STATE_MESSAGE = {
  saving: "machine.detail.bulkModel.applyState.saving",
  saved: "machine.detail.bulkModel.applyState.saved",
  failed: "machine.detail.bulkModel.applyState.failed",
} as const;

export interface BulkChangeModelDialogProps {
  machine: Machine;
  agents: Agent[];
  isRunning: (agent: Agent) => boolean;
  /** Same visibility rule as the runtime usage badge on this page. When false,
   *  no usage is read or shown. */
  canViewUsage?: boolean;
  /** Re-opened from a partial-failure receipt: last target + per-agent phase. */
  retry?: { target: BulkModelTarget; unfinished: BulkUnfinishedAgent[] };
  onClose: () => void;
  onOpenAgent: (agentId: string) => void;
  onFinished: (receipt: BulkChangeReceipt, highlightedAgentIds: string[]) => void;
  now?: () => number;
}

function mostCommon(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: string | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Fixed-width shell whose body slides/fades between steps and whose height
 * follows its content smoothly. `motion-reduce` switches instantly.
 */
function StepBody({ stepKey, children }: { stepKey: string; children: ReactNode }) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const node = innerRef.current;
    if (!node) return;
    const measure = () => setHeight(node.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [stepKey]);
  return (
    <div
      // Negative margin + matching padding: the clip box is 4px larger than the
      // content, so brutal's 2px offset shadows and focus rings are not cut.
      className="-m-1 overflow-hidden transition-[height] duration-200 ease-out motion-reduce:transition-none"
      style={height === undefined ? undefined : { height }}
    >
      <div ref={innerRef} key={stepKey} className="bulk-model-step p-1" data-testid={`bulk-model-step-${stepKey}`}>
        {children}
      </div>
    </div>
  );
}

function EditAgentLink({ agentId, onOpenAgent }: { agentId: string; onOpenAgent: (agentId: string) => void }) {
  const { formatMessage } = useIntl();
  const open = useCallback(() => onOpenAgent(agentId), [agentId, onOpenAgent]);
  return (
    // The "·" separator is drawn by CSS so it is not a JSX literal.
    <button type="button" className="underline before:mr-1 before:inline-block before:no-underline before:content-['·']" onClick={open}>
      {formatMessage({ id: "machine.detail.bulkModel.edit" })}
    </button>
  );
}

function Stepper({ step }: { step: Step }) {
  const { formatMessage } = useIntl();
  const reviewing = step !== "choose";
  return (
    <div className="mb-4 flex items-center gap-2 text-xs font-medium text-foreground-placeholder theme-brutal:font-bold theme-brutal:uppercase theme-brutal:tracking-wide">
      <span className={`flex items-center gap-1 ${reviewing ? "text-success-strong theme-brutal:text-black" : "text-foreground-strong"}`}>
        {reviewing ? <Check size={12} aria-hidden /> : <span aria-hidden>{1}</span>}
        {formatMessage({ id: "machine.detail.bulkModel.stepChoose" })}
      </span>
      <span className="h-px flex-1 bg-line-muted theme-brutal:h-0.5 theme-brutal:bg-black" aria-hidden />
      <span className={`flex items-center gap-1 ${reviewing ? "text-foreground-strong" : ""}`}>
        <span aria-hidden>{2}</span>
        {formatMessage({ id: "machine.detail.bulkModel.stepReview" })}
      </span>
    </div>
  );
}

export default function BulkChangeModelDialog({
  machine,
  agents,
  isRunning,
  retry,
  onClose,
  onOpenAgent,
  onFinished,
  canViewUsage = false,
  now = currentTimeMs,
}: BulkChangeModelDialogProps) {
  const { formatMessage, locale } = useIntl();
  const serverId = useServerStore((s) => s.current?.id);
  const updateAgent = useAgentStore((s) => s.updateAgent);
  const resetAgent = useAgentStore((s) => s.resetAgent);

  const runtimeIds = useMemo(
    () => machine.runtimes.filter((id) => isBulkSelectableRuntime(id)),
    [machine.runtimes],
  );
  // Read-only usage per runtime (task #1292). Cached client, same 60 s cache as
  // the badge; errors and missing snapshots simply show nothing.
  const [usageByRuntime, setUsageByRuntime] = useState<Record<string, BulkRuntimeUsageSummary | null>>({});
  useEffect(() => {
    if (!canViewUsage || !serverId) return;
    let cancelled = false;
    for (const runtimeId of runtimeIds) {
      const provider = usageProviderForRuntime(runtimeId);
      if (!provider) continue;
      void runtimeAccountUsageClient.read(serverId, machine.id, provider)
        .then((result) => {
          if (cancelled) return;
          setUsageByRuntime((current) => ({ ...current, [runtimeId]: summarizeRuntimeUsage(result.snapshot) }));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [canViewUsage, machine.id, runtimeIds, serverId]);

  const initialRuntime = useMemo(() => {
    if (retry && runtimeIds.includes(retry.target.runtime)) return retry.target.runtime;
    const common = mostCommon(agents.map((a) => a.runtime).filter((id) => runtimeIds.includes(id)));
    return common ?? runtimeIds[0] ?? "";
  }, [agents, retry, runtimeIds]);

  const [step, setStep] = useState<Step>("choose");
  const [runtime, setRuntime] = useState(initialRuntime);
  // User choices; the effective values are derived during render so they stay
  // valid for whatever the runtime's model list currently offers.
  const [modelChoice, setModelChoice] = useState(retry?.target.model ?? "");
  const [reasoningChoice, setReasoningChoice] = useState<ReasoningEffort | null>(retry?.target.reasoningEffort ?? null);
  const [runtimeAllowed, setRuntimeAllowed] = useState<Record<string, boolean> | null>(null);
  const [checkingRuntime, setCheckingRuntime] = useState(false);
  const [applyStates, setApplyStates] = useState<Record<string, ApplyState>>({});

  const runtimeModels = useRuntimeModels(machine.id, runtime, { reuseRecentMs: 60_000 });
  const models = runtimeModels.models;

  const model = useMemo(() => {
    if (models.some((m) => m.id === modelChoice)) return modelChoice;
    const preferred = runtimeModels.default ?? getDefaultModel(runtime);
    return models.find((m) => m.id === preferred)?.id ?? models[0]?.id ?? "";
  }, [modelChoice, models, runtime, runtimeModels.default]);

  const supportsReasoning = REASONING_EFFORT_RUNTIMES.has(runtime);
  const reasoning = useMemo(
    () => (supportsReasoning && model ? reconcileReasoningEffort(runtime, model, reasoningChoice, models) : null),
    [model, models, reasoningChoice, runtime, supportsReasoning],
  );

  const target: BulkModelTarget = useMemo(
    () => ({ runtime, model, reasoningEffort: supportsReasoning ? reasoning : null }),
    [model, reasoning, runtime, supportsReasoning],
  );

  const phaseById = useMemo(() => {
    const map = new Map<string, BulkUnfinishedPhase>();
    for (const item of retry?.unfinished ?? []) map.set(item.agentId, item.phase);
    return map;
  }, [retry]);

  const planInputs: BulkPlanAgentInput[] = useMemo(() => agents.map((agent) => ({
    id: agent.id,
    runtime: agent.runtime,
    model: agent.model,
    reasoningEffort: agent.reasoningEffort ?? null,
    runtimeConfig: agent.runtimeConfig ?? null,
    envVars: agent.envVars ?? null,
    external: agent.external,
    running: isRunning(agent),
    ...(runtimeAllowed && agent.id in runtimeAllowed ? { targetRuntimeAllowed: runtimeAllowed[agent.id] } : {}),
    ...(phaseById.has(agent.id) ? { phase: phaseById.get(agent.id) } : {}),
  })), [agents, isRunning, phaseById, runtimeAllowed]);

  const plan = useMemo(() => planBulkModelChange(planInputs, target), [planInputs, target]);
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  const usageText = useCallback((summary: BulkRuntimeUsageSummary | null | undefined): string | undefined => {
    if (!summary) return undefined;
    const plan = summary.plan ?? formatMessage({ id: "machine.runtimeUsage.accountFallback" });
    if (summary.kind === "used") return formatMessage({ id: "machine.detail.bulkModel.usageUsed" }, { plan, percent: summary.percent });
    if (summary.kind === "attention") return formatMessage({ id: "machine.detail.bulkModel.usageAttention" }, { plan });
    const reset = summary.resetsAt ? formatRelativeTime(summary.resetsAt, locale) : null;
    return reset
      ? formatMessage({ id: "machine.detail.bulkModel.usageLimit" }, { plan, reset })
      : formatMessage({ id: "machine.detail.bulkModel.usageLimitNoReset" }, { plan });
  }, [formatMessage, locale]);
  const runtimeOptions = useMemo(() => runtimeIds.map((id) => {
    const description = usageText(usageByRuntime[id]);
    return description
      ? { value: id, label: getRuntimeDisplayName(id), description }
      : { value: id, label: getRuntimeDisplayName(id) };
  }), [runtimeIds, usageByRuntime, usageText]);
  const modelOptions = useMemo(() => models.map((m) => ({ value: m.id, label: m.label || m.id })), [models]);
  const reasoningOptions = useMemo(() => {
    if (!supportsReasoning || !model) return [];
    return [
      { value: REASONING_DEFAULT_VALUE, label: formatMessage({ id: "machine.detail.bulkModel.reasoningDefault" }) },
      ...reasoningEffortOptionsForModel(runtime, model, models).map((option) => ({
        value: option.value,
        label: formatMessage({ id: option.labelId }),
      })),
    ];
  }, [formatMessage, model, models, runtime, supportsReasoning]);

  const handleRuntimeChange = useCallback((next: string) => {
    setRuntime(next);
    setModelChoice("");
    setRuntimeAllowed(null);
  }, []);
  const handleReasoningChange = useCallback((next: string) => {
    setReasoningChoice(next === REASONING_DEFAULT_VALUE ? null : next as ReasoningEffort);
  }, []);
  const ignoreClose = useCallback(() => {}, []);
  const backToChoose = useCallback(() => setStep("choose"), []);

  const goToReview = useCallback(async () => {
    const switching = agents.filter((agent) => agent.runtime !== runtime);
    if (switching.length === 0) {
      setRuntimeAllowed({});
      setStep("review");
      return;
    }
    setCheckingRuntime(true);
    try {
      const entries = await Promise.all(switching.map(async (agent) => {
        const options = await fetchExistingAgentRuntimeOptions(agent.id);
        const option = options.find((o) => o.runtimeId === runtime);
        // Fail closed: an unreadable catalog means we cannot prove it is allowed.
        return [agent.id, Boolean(option?.canSelectInThisContext)] as const;
      }));
      setRuntimeAllowed(Object.fromEntries(entries));
      setStep("review");
    } finally {
      setCheckingRuntime(false);
    }
  }, [agents, runtime]);

  const apply = useCallback(async () => {
    const applying = plan.rows.filter((row): row is Exclude<BulkPlanRow, { kind: "skip" }> => row.kind !== "skip");
    if (applying.length === 0) return;
    setStep("applying");
    setApplyStates(Object.fromEntries(applying.map((row) => [row.agentId, "saving" as ApplyState])));
    const inputById = new Map(planInputs.map((input) => [input.id, input]));
    const results = await Promise.all(applying.map(async (row) => {
      const input = inputById.get(row.agentId)!;
      try {
        if (row.kind === "restartOnly") {
          await resetAgent(row.agentId, "restart");
        } else {
          await updateAgent(
            row.agentId,
            buildBulkAgentUpdate(input, target),
            row.restarts ? { restartMode: "restart" } : undefined,
          );
        }
        setApplyStates((current) => ({ ...current, [row.agentId]: "saved" }));
        return { agentId: row.agentId, ok: true as const };
      } catch {
        let phase: BulkUnfinishedPhase = "save_failed";
        try {
          const { data } = await api.get<Agent>(`/agents/${row.agentId}`);
          useAgentStore.setState((state) => ({
            agents: state.agents.map((agent) => (agent.id === data.id ? { ...agent, ...data } : agent)),
          }));
          phase = classifyUnfinished(
            { runtime: data.runtime, model: data.model, reasoningEffort: data.reasoningEffort ?? null },
            target,
          );
        } catch {
          phase = row.kind === "restartOnly" ? "restart_pending" : "save_failed";
        }
        setApplyStates((current) => ({ ...current, [row.agentId]: "failed" }));
        return { agentId: row.agentId, ok: false as const, phase };
      }
    }));
    const failed = results.filter((r): r is { agentId: string; ok: false; phase: BulkUnfinishedPhase } => !r.ok);
    const changedAgentIds = results.filter((r) => r.ok).map((r) => r.agentId);
    const skippedAgentIds = plan.rows.filter((row) => row.kind === "skip").map((row) => row.agentId);
    const receipt: BulkChangeReceipt = failed.length === 0
      ? { kind: "success", target, changedAgentIds, skippedAgentIds, bannerUntil: now() + BULK_SUCCESS_BANNER_MS }
      : { kind: "partial", target, total: applying.length, unfinished: failed.map((r) => ({ agentId: r.agentId, phase: r.phase })) };
    onFinished(receipt, changedAgentIds);
  }, [now, onFinished, plan.rows, planInputs, resetAgent, target, updateAgent]);

  const handleNext = useCallback(() => { void goToReview(); }, [goToReview]);
  const handleApply = useCallback(() => { void apply(); }, [apply]);
  const title = formatMessage({ id: "machine.detail.bulkModel.title" }, { count: agents.length });
  const nextDisabled = !runtime || !model || checkingRuntime || (runtimeModels.loading && models.length === 0);

  return (
    <DialogCard
      title={step === "applying"
        ? formatMessage({ id: "machine.detail.bulkModel.applyingTitle" }, { count: plan.applyCount })
        : title}
      onClose={step === "applying" ? ignoreClose : onClose}
      maxWidthClass="max-w-2xl"
      testId="bulk-change-model-dialog"
    >
      {step !== "applying" && <Stepper step={step} />}
      <StepBody stepKey={step}>
        {step === "choose" && (
          <div className="space-y-4">
            {runtimeIds.length === 0 ? (
              <p className="text-sm text-foreground-muted">{formatMessage({ id: "machine.detail.bulkModel.noRuntimes" })}</p>
            ) : (
              <>
                <div className="space-y-1.5">
                  <div className="text-xs font-bold text-foreground-strong">{formatMessage({ id: "machine.detail.bulkModel.runtime" })}</div>
                  <RuntimeSelectControl
                    value={runtime}
                    onValueChange={handleRuntimeChange}
                    options={runtimeOptions}
                    placeholder={formatMessage({ id: "machine.detail.bulkModel.runtime" })}
                    testId="bulk-model-runtime"
                  />
                  <p className="text-xs text-foreground-muted">
                    {formatMessage({ id: "machine.detail.bulkModel.accountHint" }, { runtime: getRuntimeDisplayName(runtime) })}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <div className="text-xs font-bold text-foreground-strong">{formatMessage({ id: "machine.detail.bulkModel.model" })}</div>
                  <RuntimeSelectControl
                    value={model}
                    onValueChange={setModelChoice}
                    options={modelOptions}
                    placeholder={formatMessage({ id: "machine.detail.bulkModel.loadingModels" })}
                    testId="bulk-model-model"
                  />
                </div>
                {reasoningOptions.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-xs font-bold text-foreground-strong">{formatMessage({ id: "machine.detail.bulkModel.reasoning" })}</div>
                    <RuntimeSelectControl
                      value={reasoning ?? REASONING_DEFAULT_VALUE}
                      onValueChange={handleReasoningChange}
                      options={reasoningOptions}
                      placeholder={formatMessage({ id: "machine.detail.bulkModel.reasoningDefault" })}
                      testId="bulk-model-reasoning"
                    />
                  </div>
                )}
              </>
            )}
            <div className="flex justify-end gap-3 pt-1">
              <Button size="sm" variant="outline" type="button" onClick={onClose} className="px-4 py-2 text-sm">
                {formatMessage({ id: "common.confirm.cancel" })}
              </Button>
              <Button
                size="sm"
                variant="accent"
                type="button"
                onClick={handleNext}
                disabled={nextDisabled}
                className="flex items-center gap-1.5 px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                data-testid="bulk-model-next"
              >
                {checkingRuntime && <Spinner size="xs" aria-label={formatMessage({ id: "common.loadingLabel" })} />}
                {formatMessage({ id: "machine.detail.bulkModel.next" })}
              </Button>
            </div>
          </div>
        )}

        {step === "review" && (
          <div>
            <ul className="divide-y divide-line-muted border-y border-line-muted theme-brutal:divide-black/15 theme-brutal:border-black/15" data-testid="bulk-model-review-list">
              {plan.rows.map((row) => {
                const agent = agentById.get(row.agentId)!;
                const sameRuntime = agent.runtime === runtime;
                const from = formatBulkModelLabel(agent.runtime, agent.model, !sameRuntime);
                const to = formatBulkModelLabel(runtime, model, !sameRuntime);
                const skipped = row.kind === "skip";
                return (
                  <li
                    key={row.agentId}
                    className={`flex min-w-0 items-center gap-2 py-2 text-sm ${skipped ? "text-foreground-placeholder" : ""}`}
                    data-testid={`bulk-model-row-${row.agentId}`}
                    data-row-kind={row.kind}
                  >
                    <AvatarSlot context="compact-list" type="agent" agentAvatarUrl={agent.avatarUrl} />
                    <span className="w-24 shrink-0 truncate font-bold text-foreground-strong" title={agent.displayName ?? agent.name}>
                      {agent.displayName ?? agent.name}
                    </span>
                    <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-xs">
                      {row.kind === "restartOnly" ? (
                        <span className="truncate text-foreground-strong">{to}</span>
                      ) : (
                        <>
                          <span className="truncate text-foreground-muted">{from}</span>
                          <ArrowRight size={12} className="shrink-0" aria-hidden />
                          {skipped
                            ? <s className="truncate">{to}</s>
                            : <span className="truncate text-foreground-strong">{to}</span>}
                        </>
                      )}
                    </span>
                    {skipped && (
                      <span className="flex shrink-0 items-center gap-1 text-xs text-warning-strong theme-brutal:text-black">
                        {formatMessage({ id: SKIP_REASON_MESSAGE[row.reason] })}
                        {row.reason !== "noChange" && (
                          <EditAgentLink agentId={row.agentId} onOpenAgent={onOpenAgent} />
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {plan.restartCount > 0 && (
              <p className="mt-3 text-xs text-foreground-muted" data-testid="bulk-model-restart-line">
                {formatMessage({ id: "machine.detail.bulkModel.restartLine" }, { count: plan.restartCount })}
              </p>
            )}
            <div className="mt-4 flex items-center gap-3">
              <Button size="sm" variant="outline" type="button" onClick={backToChoose} className="px-4 py-2 text-sm">
                {formatMessage({ id: "machine.detail.bulkModel.back" })}
              </Button>
              <span className="flex-1" />
              <Button size="sm" variant="outline" type="button" onClick={onClose} className="px-4 py-2 text-sm">
                {formatMessage({ id: "common.confirm.cancel" })}
              </Button>
              <Button
                size="sm"
                variant="accent"
                type="button"
                onClick={handleApply}
                disabled={plan.applyCount === 0}
                className="px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                data-testid="bulk-model-apply"
              >
                {formatMessage({ id: "machine.detail.bulkModel.apply" }, { count: plan.applyCount })}
              </Button>
            </div>
          </div>
        )}

        {step === "applying" && (
          <ul className="divide-y divide-line-muted theme-brutal:divide-black/15" data-testid="bulk-model-applying-list">
            {plan.rows.filter((row) => row.kind !== "skip").map((row) => {
              const agent = agentById.get(row.agentId)!;
              const state = applyStates[row.agentId] ?? "saving";
              return (
                <li key={row.agentId} className="flex items-center gap-2 py-2 text-sm">
                  <AvatarSlot context="compact-list" type="agent" agentAvatarUrl={agent.avatarUrl} />
                  <span className="flex-1 truncate font-bold text-foreground-strong">{agent.displayName ?? agent.name}</span>
                  <span className="flex items-center gap-1 text-xs text-foreground-muted" data-testid={`bulk-model-apply-${row.agentId}`} data-apply-state={state}>
                    {state === "saving" && <Spinner size="xs" aria-label={formatMessage({ id: "common.loadingLabel" })} />}
                    {state === "saved" && <Check size={14} className="text-success-strong theme-brutal:text-black" aria-hidden />}
                    {state === "failed" && <X size={14} className="text-warning-strong theme-brutal:text-black" aria-hidden />}
                    {formatMessage({ id: APPLY_STATE_MESSAGE[state] })}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </StepBody>
    </DialogCard>
  );
}
