import {
  getCreatableRuntimeOptions,
  getExistingAgentRuntimeOptions,
  getSetupRuntimeOptions,
  type RuntimeAdmissionReason,
  type RuntimeInfo,
  type RuntimeSelectionOption,
} from "@botiverse/raft-shared";
import { evaluateFeatureFlag, GROK_RUNTIME_FEATURE_FLAG_KEY } from "./featureFlagService";
import { runtimeFormV1Entry } from "./runtimeFormDefinitionService";
import { RUNTIME_FORM_V2_MARKER, runtimeFormV2Entry } from "./runtimeFormV2Registry";

export interface RuntimeAdmissionPolicy {
  grokRuntimeEnabled: boolean;
}

/**
 * Released mobile apps (1.12, 1.13) decode runtime options STRICTLY: any key
 * they do not know fails the whole catalog (`computer_runtime_options_contract_mismatch`),
 * so the create-agent runtime list never opens. The `runtimeFormV2` marker is
 * therefore opt-in: only a client that asks for it (web, header
 * `X-Raft-Runtime-Form-V2: 1`) receives it; everyone else gets the pre-v2 key set unchanged.
 */
export interface RuntimeOptionProjection {
  includeRuntimeFormV2Marker: boolean;
}

const NO_RUNTIME_FORM_V2_MARKER: RuntimeOptionProjection = { includeRuntimeFormV2Marker: false };

/** Request header a client sends to declare that it understands the `runtimeFormV2` marker. */
export const RUNTIME_FORM_V2_MARKER_HEADER = "x-raft-runtime-form-v2";

export function runtimeOptionProjectionFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): RuntimeOptionProjection {
  return { includeRuntimeFormV2Marker: headers[RUNTIME_FORM_V2_MARKER_HEADER] === "1" };
}

function capabilityStatus(
  runtime: RuntimeInfo,
  installedRuntimeIds: ReadonlySet<string>,
): RuntimeSelectionOption["capabilityStatus"] {
  if (installedRuntimeIds.has(runtime.id)) return "available";
  return runtime.binary === "" ? "update_required" : "not_installed";
}

function projectRuntimeOption(input: {
  runtime: RuntimeInfo;
  installedRuntimeIds: ReadonlySet<string>;
  currentRuntime: string | null;
  admissionReason: RuntimeAdmissionReason;
  projection: RuntimeOptionProjection;
}): RuntimeSelectionOption {
  const current = input.runtime.id === input.currentRuntime;
  const capability = capabilityStatus(input.runtime, input.installedRuntimeIds);
  const admissionStatus = input.admissionReason === null
    ? "available_for_new" as const
    : "grandfathered_current" as const;
  const availableForNew = admissionStatus === "available_for_new";
  const capabilityAvailable = capability === "available";
  const manageableForCurrentAgent = current && capabilityAvailable;
  const canSelectInThisContext = capabilityAvailable
    && (availableForNew || (current && admissionStatus === "grandfathered_current"));
  const v1Form = runtimeFormV1Entry(input.runtime.id);

  return {
    runtimeId: input.runtime.id,
    capabilityStatus: capability,
    admissionStatus,
    admissionReason: input.admissionReason,
    current,
    availableForNew,
    manageableForCurrentAgent,
    canSelectInThisContext,
    // Two independent opt-ins: `formDefinitionRef` for the frozen v1 form (web
    // schema path, installed v1 apps), `runtimeFormV2` for the v2 form. A
    // runtime that only has a v2 form carries no v1 ref.
    ...(v1Form && (availableForNew || current) ? { formDefinitionRef: v1Form.ref } : {}),
    ...(input.projection.includeRuntimeFormV2Marker && runtimeFormV2Entry(input.runtime.id) && (availableForNew || current)
      ? { runtimeFormV2: RUNTIME_FORM_V2_MARKER }
      : {}),
  };
}

function isRuntimeAdmittedForNewUse(runtime: RuntimeInfo, policy: RuntimeAdmissionPolicy): boolean {
  return runtime.id !== "grok" || policy.grokRuntimeEnabled;
}

function projectNewUseOptions(
  candidates: RuntimeInfo[],
  installedRuntimeIds: readonly string[],
  policy: RuntimeAdmissionPolicy,
  projection: RuntimeOptionProjection,
): RuntimeSelectionOption[] {
  const installed = new Set(installedRuntimeIds);
  return candidates
    .filter((runtime) => isRuntimeAdmittedForNewUse(runtime, policy))
    .map((runtime) => projectRuntimeOption({
      runtime,
      installedRuntimeIds: installed,
      currentRuntime: null,
      admissionReason: null,
      projection,
    }));
}

export function projectNewAgentRuntimeOptions(
  installedRuntimeIds: readonly string[],
  policy: RuntimeAdmissionPolicy,
  projection: RuntimeOptionProjection = NO_RUNTIME_FORM_V2_MARKER,
): RuntimeSelectionOption[] {
  return projectNewUseOptions(getCreatableRuntimeOptions(), installedRuntimeIds, policy, projection);
}

/** Server setup state never carries the marker: no client opens a v2 form from it. */
export function projectSetupRuntimeOptions(
  installedRuntimeIds: readonly string[],
  policy: RuntimeAdmissionPolicy,
): RuntimeSelectionOption[] {
  return projectNewUseOptions(getSetupRuntimeOptions(), installedRuntimeIds, policy, NO_RUNTIME_FORM_V2_MARKER);
}

export function projectExistingAgentRuntimeOptions(
  installedRuntimeIds: readonly string[],
  currentRuntime: string,
  policy: RuntimeAdmissionPolicy,
  projection: RuntimeOptionProjection = NO_RUNTIME_FORM_V2_MARKER,
): RuntimeSelectionOption[] {
  const installed = new Set(installedRuntimeIds);
  return getExistingAgentRuntimeOptions(currentRuntime)
    .filter((runtime) => runtime.id === currentRuntime || isRuntimeAdmittedForNewUse(runtime, policy))
    .map((runtime) => {
      const admissionReason: RuntimeAdmissionReason = runtime.id === currentRuntime
        ? runtime.deprecated
          ? "deprecated"
          : runtime.id === "grok" && !policy.grokRuntimeEnabled
            ? "feature_flag_off"
            : null
        : null;
      return projectRuntimeOption({
        runtime,
        installedRuntimeIds: installed,
        currentRuntime,
        admissionReason,
        projection,
      });
    });
}

export async function resolveRuntimeAdmissionPolicy(input: {
  serverId: string;
  userId: string;
}): Promise<RuntimeAdmissionPolicy> {
  const evaluation = await evaluateFeatureFlag({
    key: GROK_RUNTIME_FEATURE_FLAG_KEY,
    serverId: input.serverId,
    userId: input.userId,
  });
  return { grokRuntimeEnabled: evaluation.enabled };
}
