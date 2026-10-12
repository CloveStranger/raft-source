import { ChevronDown, ChevronRight, Info, Pencil, RefreshCw } from "lucide-react";
import type { ChangeEvent, RefObject, ReactNode } from "react";
import { useCallback, useId, useMemo, useState } from "react";
import {
  isRuntimeFormV2FieldVisible,
  runtimeFormV2ConnectionActive,
  runtimeFormV2SelectedConnection,
  validateRuntimeFormV2,
} from "@botiverse/raft-runtime-form";
import type {
  ParsedRuntimeFormV2,
  RuntimeFormV2Field,
  RuntimeFormV2Sources,
  RuntimeFormV2Value,
  RuntimeFormV2Values,
} from "@botiverse/raft-runtime-form";
import type { RuntimeFormV2State } from "../../hooks/useRuntimeFormV2";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { getRuntimeDisplayName, getRuntimeProviderDisplayName, REASONING_EFFORT_RUNTIMES } from "@botiverse/raft-shared";
import type { AgentCreateFormOptionSource, ProviderConnectionSummary, ResolvedAgentCreateFormDefinition, ReasoningEffort, RuntimeModelInfo, RuntimeReasoningEffort } from "@botiverse/raft-shared";
import {
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardLeading,
  CardTitle,
  Checkbox,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectGroupLabel,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "raft-ui";
import StableField from "./StableField";
import { KeyValueAddButton } from "../ui/KeyValueInput";
import Tooltip from "../ui/Tooltip";
import { reasoningEffortOptionsForModel } from "../../utils/reasoningEffortOptions";
import { RUNTIME_LOOKUP_DISPLAY_MESSAGE_ID, runtimeLookupDisplayForReason } from "../../utils/classifyRuntimeError";
import {
  builtInCatalogCapabilityIsLive,
  projectBuiltInPresetModelOptions,
} from "../../hooks/useRuntimeModels";
import type { RuntimeModelSourceState } from "../../hooks/useRuntimeModels";
import {
  BUILTIN_RUNTIME_ALL_PROVIDER_IDS,
  PI_BUILTIN_PROVIDER_IDS,
  PI_PROVIDER_CONFIGURED,
  builtInProviderModels,
  isBuiltInGatewayProviderMode,
  piBuiltinProviderModels,
  runtimeIgnoresModel,
  supportsRuntimeApiUrl,
  supportsRuntimeBuiltInProvider,
  supportsRuntimeCommand,
  supportsRuntimeCustomModelName,
  supportsRuntimeFastMode,
  supportsRuntimePiProvider,
} from "../../utils/runtimeConfigForm";
import type {
  BuiltInProviderMode,
  PiProviderMode,
  RuntimeProviderMode,
} from "../../utils/runtimeConfigForm";
import { SchemaKimiRuntimeFields } from "./SchemaKimiRuntimeFields";
import { SchemaBuiltInRuntimeFields } from "./SchemaBuiltInRuntimeFields";
import { RuntimeEnvVarRow } from "./RuntimeEnvVarRow";
import { RuntimeFormV2FieldControl } from "./RuntimeFormV2FieldControl";
import { RuntimeChoiceCombobox } from "./RuntimeChoiceCombobox";

export const DEFAULT_REASONING_EFFORT_SELECT_VALUE = "__default_reasoning_effort__";

/** Stable fallbacks for optional props, so a defaulted prop keeps one identity
 *  across renders instead of a fresh `[]` / `() => undefined` each time. */
export const NO_PROVIDER_CONNECTIONS: readonly ProviderConnectionSummary[] = [];
const NO_SOURCE_IDS: readonly string[] = [];
export function ignoreChange(): void {}

/**
 * Field-level action (rescan / retry).
 *
 * Both callsites now render the same chrome. This used to branch on whether the
 * page had opted in, so that Agent Details kept raw buttons while Create Agent
 * got tokenised ones; with Agent Details migrated there is nothing left to
 * branch on, and the `className` a caller passes is styling that survives on top
 * of the variant rather than instead of it.
 */
export function FieldAction({ tone, className: _legacyClassName, children, ...props }: {
  tone: "icon" | "link";
  /** Accepted and DISCARDED. These are the pre-migration hand-rolled styles
   *  (`font-bold underline`, `ml-auto text-black/40`, …); the tokenised variants
   *  below own the appearance now. The prop stays on the signature because eight
   *  callsites still pass it, and deleting it there is churn that would bury this
   *  change — but it must not reach the Button, or the old look would be layered
   *  back on top of the new one. Discarding it is what the opted-in path already
   *  did before Agent Details joined it. */
  className: string;
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  void _legacyClassName;
  return tone === "icon"
    ? <Button variant="ghost" size="icon-xs" className="ml-auto" {...props}>{children}</Button>
    // `inline`, not `sm`. `sm` is a CONTROL size — h-7 plus px-2.5 — so the
    // retry rendered as a 28px-tall box with side padding parked under the
    // sentence, which is what read as "not inline, lots of padding" in
    // acceptance. raft-ui 0.5.3 ships `inline` for exactly this case:
    // `h-auto p-0 align-baseline leading-[inherit]`, i.e. a word in a line of
    // text that happens to be clickable. No `mt-1` either — a top margin on an
    // inline action is what forced it onto its own row.
    : <Button variant="link" size="inline" {...props}>{children}</Button>;
}

/**
 * Every field in this form is a reserved-row field.
 *
 * This was a switch between StableField and the older FormField so that Agent
 * Details kept its existing rhythm while Create Agent moved. Both pages are on
 * StableField now, so the indirection is just a name — kept because eight
 * callsites read it, and renaming them would bury the actual change in noise.
 */
export const Field = StableField;

/**
 * raft-ui builds SelectTrigger on `Button`, so out of the box a select inherits
 * BUTTON metrics (h-8 = 32px, text-sm, font-bold) while `Input` — which has no
 * height, font-size or font-weight token of its own — renders at 44px / 16px /
 * 400. Three axes diverge, and the two controls sit in the same form.
 *
 * `field` re-states the select trigger in INPUT metrics so the two match:
 * content height from `py-2` (as Input does), normal weight, same font size.
 * Height is deliberately not a fixed token — it is derived the same way Input
 * derives it, so the two cannot drift apart if the type scale changes.
 *
 * This belongs in raft-ui, not here: a select trigger is semantically a field,
 * not a button. Reported upstream; until it lands, the app states it explicitly
 * rather than leaving the mismatch visible.
 */
/* Removed: the field arm now opts in via `chrome="field"` on the Select root.
 * What this constant used to say — "h-auto py-2 text-base font-normal" — is why
 * it had to go: `text-base` is a LITERAL 16px, i.e. brutal's token. Under elegant
 * (14px) it was simply wrong, and because it wasn't `font-field` the option text
 * still lost to the theme's own weight rule. A restated metric cannot follow a
 * token; only the real axis can. Kept out of the `legacy` arm, which is untouched. */

/**
 * Scoped popup metrics for the opt-in pages.
 *
 * The trigger was aligned to input metrics, but the panel it opens was not —
 * the same option read 16px/400 in the trigger and 12px/700 in the list. The
 * popup renders in a portal, outside the field subtree, which is why the field
 * geometry assertions could not see it and did not object.
 *
 * `SelectContent` forwards `className` onto the portal popup, so the options can
 * be brought onto the field contract from the callsite, scoped to this page —
 * no global CSS, no `!important`, and every other raft-ui Select untouched.
 * Written as descendant variants rather than a stylesheet rule so the scope is
 * visible at the callsite instead of hidden in index.css.
 *
 * The real fix belongs in raft-ui: a select is a field, so its trigger and its
 * options should share one type contract instead of each callsite restating it.
 */
/* Removed for the same reason as FIELD_METRIC_TRIGGER: `chrome="field"` reaches
 * the portal popup through React context, so the options inherit the field
 * contract without the callsite restating 16px/400 at them. */



export interface RuntimeOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Optional visible group label. Contiguous groups preserve caller order. */
  group?: string;
  /** Optional secondary line (e.g. per-effort reasoning-level description). */
  description?: string;
}

function commitRuntimeSelectValue(
  options: readonly RuntimeOption[],
  nextValue: string | null,
  onValueChange: (value: string) => void,
) {
  if (nextValue == null) return;
  const nextOption = options.find((option) => option.value === nextValue);
  if (!nextOption || nextOption.disabled) return;
  onValueChange(nextValue);
}

/** Test-only alias for the guard used by the real Select callback. A disabled
 *  item is normally unreachable through pointer/keyboard input, but the write
 *  boundary must also reject a value injected below that visual layer. */
export { commitRuntimeSelectValue as commitRuntimeSelectValueForTest };

function renderSelectOption(option: RuntimeOption) {
  return (
    <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
      <SelectItemText>
        {option.description ? (
          <span className="flex flex-col">
            <span>{option.label}</span>
            <span className="text-xs font-normal text-foreground-muted">{option.description}</span>
          </span>
        ) : (
          option.label
        )}
      </SelectItemText>
      <SelectItemIndicator />
    </SelectItem>
  );
}

function renderSelectItems(options: readonly RuntimeOption[]) {
  if (!options.some((option) => option.group)) {
    return options.map(renderSelectOption);
  }
  const groups: Array<{ label: string; options: RuntimeOption[] }> = [];
  for (const option of options) {
    const label = option.group ?? "";
    const tail = groups.at(-1);
    if (!tail || tail.label !== label) groups.push({ label, options: [option] });
    else tail.options.push(option);
  }
  return groups.map((group) => group.label ? (
    <SelectGroup key={group.label}>
      <SelectGroupLabel>{group.label}</SelectGroupLabel>
      <SelectSeparator />
      {group.options.map(renderSelectOption)}
    </SelectGroup>
  ) : group.options.map(renderSelectOption));
}

const PROVIDER_CONNECTION_SELECT_PREFIX = "provider-connection:";

export function providerConnectionSelectValue(connectionId: string): string {
  return `${PROVIDER_CONNECTION_SELECT_PREFIX}${connectionId}`;
}

export function providerConnectionIdFromSelectValue(value: string): string | null {
  return value.startsWith(PROVIDER_CONNECTION_SELECT_PREFIX)
    ? value.slice(PROVIDER_CONNECTION_SELECT_PREFIX.length)
    : null;
}

export function unifiedBuiltInProviderOptions(input: {
  directOptions: readonly RuntimeOption[];
  connections: readonly ProviderConnectionSummary[];
  selectedConnectionId: string;
  connectionLabel: (providerId: string, connectionName: string) => string;
  savedGroupLabel: string;
  directGroupLabel: string;
  unavailableLabel: string;
}): RuntimeOption[] {
  const usableOrSelected = input.connections.filter((connection) =>
    (connection.enabled && connection.hasCredential) || connection.id === input.selectedConnectionId);
  const saved: RuntimeOption[] = usableOrSelected.map((connection) => ({
    value: providerConnectionSelectValue(connection.id),
    label: input.connectionLabel(connection.providerId, connection.name),
    disabled: !connection.enabled || !connection.hasCredential,
    group: input.savedGroupLabel,
  }));
  if (input.selectedConnectionId && !usableOrSelected.some((connection) => connection.id === input.selectedConnectionId)) {
    saved.push({
      value: providerConnectionSelectValue(input.selectedConnectionId),
      label: input.unavailableLabel,
      disabled: true,
      group: input.savedGroupLabel,
    });
  }
  return [
    ...saved,
    ...input.directOptions.map((option) => ({ ...option, group: input.directGroupLabel })),
  ];
}

/** Test-only alias. Exported so a tooth can drive the select-only field shape
 *  directly: the invalid mark crosses StableField → this component →
 *  SelectTrigger, and a component silently swallows props it does not declare,
 *  so the end of that chain needs asserting somewhere. */
export { RuntimeSelectControl as RuntimeSelectControlForTest };

export function RuntimeSelectControl({
  value,
  onValueChange,
  options,
  placeholder,
  portalContainer,
  testId,
  "data-invalid": dataInvalid,
  "aria-describedby": ariaDescribedBy,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly RuntimeOption[];
  placeholder: string;
  portalContainer?: RefObject<HTMLElement | null>;
  testId?: string;
  /** Set by StableField when this select is the field's adopted control and the
   *  field is in error. Accepted EXPLICITLY and forwarded to the trigger: a
   *  component silently swallows unknown props, so without this the mark reached
   *  `RuntimeSelectControl` and stopped there — a select-only field would show
   *  its error while announcing itself perfectly valid. The trigger is the
   *  focusable element, carries the `data-invalid:` styling variants, and derives
   *  `aria-invalid` from this same prop. */
  "data-invalid"?: string;
  /** Likewise, and for the same swallowing reason. Now that the message row is
   *  associated with the ADOPTED control by hand rather than broadcast through
   *  Field context, a select that is its field's control gets its description
   *  only if this component passes it along. Caught by the visual suite's
   *  "every field's control is wired" check, not by the unit teeth. */
  "aria-describedby"?: string;
}) {
  const handleValueChange = useCallback(
    (nextValue: string | null) => commitRuntimeSelectValue(options, nextValue, onValueChange),
    [options, onValueChange],
  );
  const contentPortalProps = useMemo(
    () => (portalContainer ? { container: portalContainer } : undefined),
    [portalContainer],
  );
  return (
    <Select
      // `chrome` lives on the Select ROOT and reaches the popup through context,
      // so the trigger and its options share one contract. Restating metrics as
      // classes on the trigger (the old FIELD_METRIC_* constants) could not do
      // that — it hardcoded 16px, which is brutal's token, so elegant silently
      // rendered at the wrong size.
      chrome="field"
      value={value}
      onValueChange={handleValueChange}
      items={options}
    >
      <SelectTrigger className="w-full" data-testid={testId} data-invalid={dataInvalid} aria-describedby={ariaDescribedBy}>
        <SelectValue placeholder={placeholder} />
        <SelectIcon />
      </SelectTrigger>
      <SelectContent portalProps={contentPortalProps}>
        <SelectList>{renderSelectItems(options)}</SelectList>
      </SelectContent>
    </Select>
  );
}

export interface EnvVarEntry {
  key: string;
  value: string;
}

function runtimeModelSourceStatus(
  intl: IntlShape,
  runtime: string,
  source: RuntimeModelSourceState,
): ReactNode {
  const runtimeName = getRuntimeDisplayName(runtime);
  switch (source.kind) {
    case "live":
      return null;
    case "loading":
      return intl.formatMessage({ id: "agent.runtimeModels.loading" });
    case "missing_config":
      return source.recovery === "kimi_login"
        ? intl.formatMessage(
          { id: "agent.runtimeModels.kimiLoginRequired" },
          {
            command: (chunks) => (
              <code key="command" className="font-mono font-bold">{chunks}</code>
            ),
          },
        )
        : intl.formatMessage(
          { id: "agent.runtimeModels.missingConfig" },
          { runtimeName },
        );
    case "no_models":
      return intl.formatMessage(
        { id: "agent.runtimeModels.noModels" },
        { runtimeName },
      );
    case "unsupported":
      return runtimeIgnoresModel(runtime)
        ? intl.formatMessage(
          { id: "agent.runtimeModels.defaultModel" },
          { runtimeName },
        )
        : intl.formatMessage(
          { id: "agent.runtimeModels.unsupported" },
          { runtimeName },
        );
    case "error":
      switch (source.code) {
        case "runtime_not_authenticated":
          return runtime === "grok"
            ? intl.formatMessage({ id: "agent.runtimeModels.grokLoginRequired" })
            : intl.formatMessage({ id: "agent.runtimeModels.loginRequired" }, { runtimeName });
        case "runtime_not_found": {
          // task #735: the lookup's reason decides the copy. Only a confirmed
          // miss keeps the install guidance; a timeout, a permission denial,
          // an unresolved failure, and an old daemon (no reason) each get the
          // neutral/own arm — uncertainty never reads as "install it".
          const lookupDisplay = runtimeLookupDisplayForReason(source.reason);
          return lookupDisplay === "confirmed_missing"
            ? intl.formatMessage({ id: "agent.runtimeModels.runtimeNotFound" }, { runtimeName })
            : intl.formatMessage({ id: RUNTIME_LOOKUP_DISPLAY_MESSAGE_ID[lookupDisplay] }, { runtimeName });
        }
        case "detect_timeout":
          return intl.formatMessage({ id: "agent.runtimeModels.detectTimeout" }, { runtimeName });
        case "protocol_unsupported":
          return intl.formatMessage({ id: "agent.runtimeModels.protocolUnsupported" }, { runtimeName });
        case "computer_offline":
          return intl.formatMessage({ id: "agent.runtimeModels.computerOffline" });
        default:
          return intl.formatMessage({ id: "agent.runtimeModels.error" });
      }
    case "idle":
      return intl.formatMessage({ id: "agent.runtimeModels.idle" });
  }
}

/** Test-only alias for the source-status mapper: the runtime_not_found arm
 *  splits on the lookup reason (task #735), and that mapping is asserted
 *  against the real catalogs without mounting the whole form. */
export { runtimeModelSourceStatus as runtimeModelSourceStatusForTest };

function builtInCatalogStatus(
  intl: IntlShape,
  source: RuntimeModelSourceState,
  model: string,
): ReactNode {
  if (source.kind === "live") {
    if (!builtInCatalogCapabilityIsLive(source)) {
      return intl.formatMessage({
        id: "agent.runtimeModels.builtInCatalogFallback",
      });
    }
    return source.value.models.some((candidate) => candidate.id === model)
      ? null
      : intl.formatMessage({
          id: "agent.runtimeModels.builtInSelectionUnavailable",
        });
  }
  if (source.kind === "loading") {
    return intl.formatMessage({ id: "agent.runtimeModels.loading" });
  }
  return intl.formatMessage({
    id: "agent.runtimeModels.builtInCatalogFallback",
  });
}

function runtimeFormUnavailableMessageId(
  loading: boolean,
  error: boolean,
  errorCode?: string,
) {
  if (loading) return "agent.runtimeConfig.schemaLoading";
  if (errorCode === "builtin_catalog_capability_required") {
    return "agent.runtimeModels.builtInUpgradeRequired";
  }
  if (
    errorCode === "builtin_catalog_unavailable" ||
    errorCode === "builtin_catalog_stale"
  ) {
    return "agent.runtimeModels.builtInCatalogUnavailable";
  }
  return error
    ? "agent.runtimeConfig.schemaErrorRefresh"
    : "agent.runtimeConfig.schemaUnavailable";
}

interface RuntimeConfigFieldsProps {
  runtime: string;
  onRuntimeChange: (runtime: string) => void;
  runtimeOptions: RuntimeOption[];
  model: string;
  /** The stored value is display-only when this Computer cannot prove it. */
  persistedModel?: string;
  onModelChange: (model: string) => void;
  customModelMode: boolean;
  onCustomModelModeChange: (enabled: boolean) => void;
  modelOptions: RuntimeOption[];
  runtimeModels: {
    source: RuntimeModelSourceState;
    models: RuntimeModelInfo[];
    loading: boolean;
    rescan: () => void;
  };
  rescanDisabled?: boolean;
  providerMode: RuntimeProviderMode;
  onProviderModeChange: (mode: RuntimeProviderMode) => void;
  providerApiUrl: string;
  onProviderApiUrlChange: (value: string) => void;
  providerApiKey: string;
  onProviderApiKeyChange: (value: string) => void;
  builtInProviderMode: BuiltInProviderMode;
  onBuiltInProviderModeChange: (mode: BuiltInProviderMode) => void;
  builtInProviderApiKey?: string;
  onBuiltInProviderApiKeyChange?: (value: string) => void;
  builtInProviderBaseUrl?: string;
  onBuiltInProviderBaseUrlChange?: (value: string) => void;
  loadLocalPlugins?: boolean;
  onLoadLocalPluginsChange?: (enabled: boolean) => void;
  builtInProviderSupportsImageInput?: boolean;
  onBuiltInProviderSupportsImageInputChange?: (enabled: boolean) => void;
  piProviderMode: PiProviderMode;
  onPiProviderModeChange: (mode: PiProviderMode) => void;
  piProviderApiKey: string;
  onPiProviderApiKeyChange: (value: string) => void;
  fastMode: boolean;
  onFastModeChange: (enabled: boolean) => void;
  command: string;
  onCommandChange: (command: string) => void;
  reasoningEffort: RuntimeReasoningEffort | null;
  onReasoningEffortChange: (effort: RuntimeReasoningEffort | null) => void;
  envVarEntries: EnvVarEntry[];
  onEnvVarEntriesChange: (entries: EnvVarEntry[]) => void;
  showRuntimeField?: boolean;
  runtimeLabel?: string;
  /** Optional explainer under the runtime select — onboarding users have no idea what a "runtime" is. */
  runtimeHint?: string;
  /** Re-ask the computer which runtimes are installed. Omit to hide the control. */
  onRescanRuntimes?: () => void;
  runtimesRescanning?: boolean;
  envVarsMode?: "inline" | "advanced" | "hidden";
  technicalFieldsMode?: "inline" | "advanced" | "hidden";
  advancedOpen?: boolean;
  onAdvancedOpenChange?: (open: boolean) => void;
  envVarsHint?: string;
  selectedModelSuggestionOnly?: boolean;
  showBuiltInRequiredHint?: boolean;
  selectPortalContainer?: RefObject<HTMLElement | null>;
  schemaBacked?: boolean;
  /** When set, the runtime renders the protocol v2 form instead of its v1 or legacy fields. */
  runtimeFormV2?: {
    state: RuntimeFormV2State;
    values: RuntimeFormV2Values | null;
    onChange: (key: string, value: RuntimeFormV2Value) => void;
    serverErrors?: Record<string, string>;
    /** Edit: blank writeOnly fields keep the stored value. */
    editing?: boolean;
  };
  formDefinition?: ResolvedAgentCreateFormDefinition | null;
  formDefinitionLoading?: boolean;
  formDefinitionError?: boolean;
  formDefinitionErrorCode?: string;
  managedConnectionActive?: boolean;
  providerConnections?: readonly ProviderConnectionSummary[];
  providerConnectionId?: string;
  onProviderConnectionChange?: (connection: ProviderConnectionSummary | null) => void;
  onEditProviderConnection?: (connection: ProviderConnectionSummary) => void;
  /**
   * Whether field-level validation errors are allowed to be VISIBLE yet.
   *
   * The errors themselves are always computed — submit still depends on them, so
   * gating this does not let an invalid form through. It only controls whether the
   * field has anything to say out loud, because a form that greets you in red
   * before you have typed a character is reporting your inaction as a mistake
   * (Cindy, acceptance on the onboarding Create Agent).
   *
   * Defaults to `true`: Agent Details and every other existing caller keeps the
   * behaviour it has today, and only a caller that owns a submit moment opts into
   * deferring. A default of `false` would silently hide errors on surfaces that
   * have no way to turn them back on.
   */
  showValidationErrors?: boolean;
}

export type SchemaSelectSource = Extract<AgentCreateFormOptionSource, { kind: "select" }>;

/** `onChange` for an input whose owner only wants the typed value. */
export function useInputValueChange(onValueChange: (value: string) => void) {
  return useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onValueChange(event.target.value),
    [onValueChange],
  );
}

/** `onCheckedChange` for a checkbox whose owner wants a plain boolean. */
export function useCheckedChange(onCheckedChange: (checked: boolean) => void) {
  return useCallback(
    (checked: boolean) => onCheckedChange(checked === true),
    [onCheckedChange],
  );
}

export interface SchemaDrivenRuntimeFieldsProps {
  definition: ResolvedAgentCreateFormDefinition;
  providerId: string;
  onProviderChange: (value: string) => void;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  baseUrl: string;
  onBaseUrlChange: (value: string) => void;
  loadLocalPlugins: boolean;
  onLoadLocalPluginsChange?: (enabled: boolean) => void;
  supportsImageInput: boolean;
  onSupportsImageInputChange: (enabled: boolean) => void;
  model: string;
  persistedModel?: string;
  onModelChange: (value: string) => void;
  reasoningEffort: RuntimeReasoningEffort | null;
  onReasoningEffortChange: (value: RuntimeReasoningEffort | null) => void;
  onCustomModelModeChange: (enabled: boolean) => void;
  envVarEntries: EnvVarEntry[];
  onEnvVarEntriesChange: (entries: EnvVarEntry[]) => void;
  advancedOpen: boolean;
  onAdvancedOpenChange?: (open: boolean) => void;
  portalContainer?: RefObject<HTMLElement | null>;
  managedConnectionActive?: boolean;
  providerConnections?: readonly ProviderConnectionSummary[];
  providerConnectionId?: string;
  onProviderConnectionChange?: (connection: ProviderConnectionSummary | null) => void;
  onEditProviderConnection?: (connection: ProviderConnectionSummary) => void;
  showValidationErrors?: boolean;
}

/** Picks the schema form shape for the definition, or nothing when its option
 *  sources are not the shape that form needs. */
function SchemaDrivenRuntimeFields(props: SchemaDrivenRuntimeFieldsProps) {
  const { definition } = props;
  const modelSource = definition.optionSources.model;
  if (definition.runtimeId === "kimi-sdk") {
    return modelSource?.kind === "select"
      ? <SchemaKimiRuntimeFields {...props} modelSource={modelSource} />
      : null;
  }
  const providerSource = definition.optionSources.provider;
  if (providerSource?.kind !== "select" || modelSource?.kind !== "dependent_select") return null;
  return <SchemaBuiltInRuntimeFields {...props} providerSource={providerSource} modelSource={modelSource} />;
}

export function LocalPiPluginsField({ checked, onChange }: { checked: boolean; onChange?: (enabled: boolean) => void }) {
  const { formatMessage } = useIntl();
  const titleId = useId();
  const descriptionId = useId();
  const handleCheckedChange = useCallback((enabled: boolean) => onChange?.(enabled), [onChange]);
  return (
    <Card variant="option" render={<label />} className="mb-3">
      <CardHeader>
        <CardLeading>
          <Checkbox checked={checked} onCheckedChange={handleCheckedChange}
            aria-labelledby={titleId}
            aria-describedby={descriptionId} />
        </CardLeading>
        <CardTitle id={titleId}>{formatMessage({ id: "agent.runtimeConfig.loadLocalPlugins" })}</CardTitle>
        <CardDescription id={descriptionId}>{formatMessage({ id: "agent.runtimeConfig.loadLocalPluginsHint" })}</CardDescription>
      </CardHeader>
    </Card>
  );
}

const CLAUDE_COMMAND_INFO_CONTENT_PROPS = {
  side: "bottom",
  className: "w-72 max-w-[calc(100vw-3rem)] text-left font-normal",
} as const;

function ClaudeCommandInfo() {
  const { formatMessage } = useIntl();
  return (
    <Tooltip
      content={
        formatMessage(
          { id: "agent.runtimeConfig.claudeCommandInfo" },
          {
            code: (chunks) => <span key="code" className="font-mono">{chunks}</span>,
          },
        )
      }
      contentProps={CLAUDE_COMMAND_INFO_CONTENT_PROPS}
    >
      <button
        type="button"
        aria-label={formatMessage({ id: "agent.runtimeConfig.claudeCommandRequirements" })}
        className="inline-flex size-4 items-center justify-center text-foreground-muted transition-colors hover:text-foreground-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-line-strong"
      >
        <Info size={14} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

export function RuntimeEnvVarsField({
  entries,
  onChange,
  optional,
  hint,
}: {
  entries: EnvVarEntry[];
  onChange: (entries: EnvVarEntry[]) => void;
  optional?: boolean;
  hint?: string;
}) {
  const { formatMessage } = useIntl();
  const handleKeyChange = useCallback((index: number, key: string) => {
    const updated = [...entries];
    updated[index] = { ...updated[index], key };
    onChange(updated);
  }, [entries, onChange]);
  const handleValueChange = useCallback((index: number, value: string) => {
    const updated = [...entries];
    updated[index] = { ...updated[index], value };
    onChange(updated);
  }, [entries, onChange]);
  const handleRemove = useCallback((index: number) => {
    onChange(entries.filter((_, i) => i !== index));
  }, [entries, onChange]);
  const handleAdd = useCallback(() => {
    onChange([...entries, { key: "", value: "" }]);
  }, [entries, onChange]);
  return (
    <Field label={formatMessage({ id: "agent.runtimeConfig.envVars" })} optional={optional} adopt={false}>
      {hint && <p className="mb-2 -mt-1 text-xs text-foreground-muted">{hint}</p>}
      <div className="space-y-2">
        {entries.map((entry, index) => (
          <RuntimeEnvVarRow
            key={index}
            index={index}
            entry={entry}
            onKeyChange={handleKeyChange}
            onValueChange={handleValueChange}
            onRemove={handleRemove}
          />
        ))}
        <KeyValueAddButton
          label={formatMessage({ id: "agent.runtimeConfig.addVariable" })}
          onClick={handleAdd}
        />
      </div>
    </Field>
  );
}

export default function RuntimeConfigFields({
  runtime,
  onRuntimeChange,
  runtimeOptions,
  model,
  persistedModel,
  onModelChange,
  customModelMode,
  onCustomModelModeChange,
  modelOptions,
  runtimeModels,
  rescanDisabled,
  providerMode,
  onProviderModeChange,
  providerApiUrl,
  onProviderApiUrlChange,
  providerApiKey,
  onProviderApiKeyChange,
  builtInProviderMode,
  onBuiltInProviderModeChange,
  builtInProviderApiKey = "",
  onBuiltInProviderApiKeyChange = ignoreChange,
  builtInProviderBaseUrl = "",
  onBuiltInProviderBaseUrlChange = ignoreChange,
  loadLocalPlugins = false,
  onLoadLocalPluginsChange,
  builtInProviderSupportsImageInput = false,
  onBuiltInProviderSupportsImageInputChange = ignoreChange,
  piProviderMode,
  onPiProviderModeChange,
  piProviderApiKey,
  onPiProviderApiKeyChange,
  fastMode,
  onFastModeChange,
  command,
  onCommandChange,
  reasoningEffort,
  onReasoningEffortChange,
  envVarEntries,
  onEnvVarEntriesChange,
  showRuntimeField = true,
  runtimeLabel,
  runtimeHint,
  onRescanRuntimes,
  runtimesRescanning = false,
  envVarsMode = "inline",
  technicalFieldsMode = "inline",
  advancedOpen = false,
  onAdvancedOpenChange,
  envVarsHint,
  selectedModelSuggestionOnly,
  showBuiltInRequiredHint = false,
  selectPortalContainer,
  runtimeFormV2,
  schemaBacked = false,
  formDefinition = null,
  formDefinitionLoading = false,
  formDefinitionError = false,
  formDefinitionErrorCode,
  managedConnectionActive = false,
  providerConnections = NO_PROVIDER_CONNECTIONS,
  providerConnectionId = "",
  onProviderConnectionChange = ignoreChange,
  onEditProviderConnection,
  showValidationErrors = true,
}: RuntimeConfigFieldsProps) {
  // `provider.saved_connection` (v2 forms): the pencil action bridge, memoized
  // so the object identity is stable across renders (react-doctor).
  const savedConnectionsForV2 = useMemo(() => (onEditProviderConnection
    ? {
        onEdit: (connectionId: string) => {
          const connection = providerConnections.find((candidate) => candidate.id === connectionId);
          if (connection) onEditProviderConnection(connection);
        },
      }
    : undefined), [onEditProviderConnection, providerConnections]);
  const intl = useIntl();
  const { formatMessage } = intl;
  const effectiveRuntimeLabel = runtimeLabel ?? formatMessage({ id: "agent.runtimeConfig.runtime" });
  const effectiveEnvVarsHint = envVarsHint ?? formatMessage({ id: "agent.runtimeConfig.envVarsHint" });
  const apiUrlSupported = supportsRuntimeApiUrl(runtime);
  const commandSupported = supportsRuntimeCommand(runtime);
  const customModelSupported = supportsRuntimeCustomModelName(runtime);
  const fastModeSupported = supportsRuntimeFastMode(runtime);
  const reasoningSupported = REASONING_EFFORT_RUNTIMES.has(runtime)
    && (runtime !== "kimi-sdk" || schemaBacked);
  const providerApiUrlRequired = apiUrlSupported && providerMode === "custom";
  const builtInProviderSupported = supportsRuntimeBuiltInProvider(runtime);
  const piProviderSupported = supportsRuntimePiProvider(runtime);
  const selectedProviderConnection = providerConnections.find(
    (connection) => connection.id === providerConnectionId,
  ) ?? null;
  const effectiveBuiltInProviderMode = selectedProviderConnection?.providerId ?? builtInProviderMode;
  const builtInGatewayProvider = builtInProviderSupported && isBuiltInGatewayProviderMode(effectiveBuiltInProviderMode);
  const customModelInputMode = customModelMode || builtInGatewayProvider;
  const builtInCatalogApplies = builtInProviderSupported && !builtInGatewayProvider;
  const builtInModelList = useMemo(() => (builtInCatalogApplies
    ? projectBuiltInPresetModelOptions({
        providerModels: builtInProviderModels(effectiveBuiltInProviderMode) ?? [],
        ...(model ? { persistedModel: model } : {}),
      })
    : null), [builtInCatalogApplies, effectiveBuiltInProviderMode, model]);
  const builtInBaseUrlInvalid = builtInGatewayProvider && !managedConnectionActive && !/^https?:\/\//i.test(builtInProviderBaseUrl.trim());
  const piApiKeyRequired = piProviderSupported && piProviderMode !== PI_PROVIDER_CONFIGURED;
  // Gateway providers are custom-model-only: Slock cannot know what models a
  // user-controlled gateway exposes, so host-discovered modelOptions must not
  // leak into this mode.
  const piBuiltinModelList = piApiKeyRequired ? piBuiltinProviderModels(piProviderMode) : null;
  const providerModelList = builtInModelList ?? piBuiltinModelList;
  const machineSourceApplies = (!providerModelList && !builtInGatewayProvider) || builtInCatalogApplies;
  const providerModeOptions = useMemo((): RuntimeOption[] => [
    { value: "default", label: formatMessage({ id: "agent.runtimeConfig.default" }) },
    { value: "custom", label: formatMessage({ id: "agent.runtimeConfig.custom" }) },
  ], [formatMessage]);
  const builtInProviderOptions: RuntimeOption[] = BUILTIN_RUNTIME_ALL_PROVIDER_IDS.map((id) => ({
    value: id,
    label: getRuntimeProviderDisplayName(id),
  }));
  const unifiedBuiltInProviderSelectOptions = unifiedBuiltInProviderOptions({
    directOptions: builtInProviderOptions,
    connections: providerConnections,
    selectedConnectionId: providerConnectionId,
    connectionLabel: (providerId, connectionName) => formatMessage(
      { id: "agent.runtimeConfig.savedProviderLabel" },
      { provider: getRuntimeProviderDisplayName(providerId), connection: connectionName },
    ),
    savedGroupLabel: formatMessage({ id: "agent.runtimeConfig.savedProviders" }),
    directGroupLabel: formatMessage({ id: "agent.runtimeConfig.directProviders" }),
    unavailableLabel: formatMessage({ id: "agent.runtimeConfig.savedProviderUnavailable" }),
  });
  const piProviderOptions = useMemo((): RuntimeOption[] => [
    { value: PI_PROVIDER_CONFIGURED, label: formatMessage({ id: "agent.runtimeConfig.configured" }) },
    ...PI_BUILTIN_PROVIDER_IDS.map((id) => ({
      value: id,
      label: getRuntimeProviderDisplayName(id),
    })),
  ], [formatMessage]);
  const modelChoiceOptions = useMemo((): RuntimeOption[] => (providerModelList
    ? providerModelList.map((m) => {
        const disabled = "disabled" in m && m.disabled === true;
        return {
          value: m.id,
          label: m.label,
          ...(disabled ? { disabled } : {}),
        };
      })
    : builtInGatewayProvider ? [] : modelOptions), [providerModelList, builtInGatewayProvider, modelOptions]);
  // A Built-in/Pi provider locks the model picker to its SDK first-class set;
  // a typed model doesn't apply because the provider namespace owns the list.
  const modelAllowsCustom = customModelSupported && !providerModelList;
  // Reasoning options are gated by the selected model's declared
  // supportedReasoningEfforts (data-driven — e.g. GPT-5.6 luna omits Ultra);
  // models that don't declare a set fall back to the full catalog.
  const reasoningOptions = useMemo((): RuntimeOption[] => [
    { value: DEFAULT_REASONING_EFFORT_SELECT_VALUE, label: formatMessage({ id: "agent.runtimeConfig.default" }) },
    ...reasoningEffortOptionsForModel(runtime, model, runtimeModels.models).map((option) => ({
      value: option.value,
      label: formatMessage({ id: option.labelId }),
      description: option.descriptionId ? formatMessage({ id: option.descriptionId }) : undefined,
    })),
  ], [runtime, model, runtimeModels.models, formatMessage]);
  const providerApiUrlInvalid = providerApiUrlRequired
    ? !/^https?:\/\//i.test(providerApiUrl.trim())
    : providerApiUrl.trim().length > 0 && !/^https?:\/\//i.test(providerApiUrl.trim());
  const customModelInvalid = customModelInputMode && !model.trim();
  const modelSource = runtimeModels.source;
  const modelSourceCanRetry = machineSourceApplies && (
    modelSource.kind === "missing_config"
    || modelSource.kind === "no_models"
    || (modelSource.kind === "error" && modelSource.retryable)
  );
  const showHeaderRescan = machineSourceApplies && (
    modelSource.kind === "live" || modelSource.kind === "loading"
  );
  const modelSourceStatusContent = machineSourceApplies
    ? builtInCatalogApplies
      ? builtInCatalogStatus(intl, modelSource, model)
      : runtimeModelSourceStatus(intl, runtime, modelSource)
    : null;
  const handleCommandChange = useInputValueChange(onCommandChange);
  const handleProviderModeChange = useCallback((next: string) => {
    const nextMode = next as RuntimeProviderMode;
    onProviderModeChange(nextMode);
    if (nextMode !== "custom") {
      onProviderApiUrlChange("");
      onProviderApiKeyChange("");
    }
  }, [onProviderModeChange, onProviderApiUrlChange, onProviderApiKeyChange]);
  const handleProviderApiUrlChange = useInputValueChange(onProviderApiUrlChange);
  const handleProviderApiKeyChange = useInputValueChange(onProviderApiKeyChange);
  const handleReasoningEffortChange = useCallback((value: string) => {
    onReasoningEffortChange(
      value === DEFAULT_REASONING_EFFORT_SELECT_VALUE
        ? null
        : value as ReasoningEffort,
    );
  }, [onReasoningEffortChange]);
  const handleFastModeChange = useCheckedChange(onFastModeChange);
  const handleSchemaProviderChange = useCallback(
    (value: string) => onBuiltInProviderModeChange(value as BuiltInProviderMode),
    [onBuiltInProviderModeChange],
  );
  const handleEditProviderConnection = useCallback(() => {
    if (selectedProviderConnection) onEditProviderConnection?.(selectedProviderConnection);
  }, [selectedProviderConnection, onEditProviderConnection]);
  const handleBuiltInProviderChange = useCallback((next: string) => {
    const connectionId = providerConnectionIdFromSelectValue(next);
    if (connectionId) {
      const connection = providerConnections.find((candidate) => candidate.id === connectionId);
      if (!connection || !connection.enabled || !connection.hasCredential) return;
      onProviderConnectionChange(connection);
      return;
    }
    onProviderConnectionChange(null);
    onBuiltInProviderModeChange(next as BuiltInProviderMode);
    onBuiltInProviderSupportsImageInputChange(false);
  }, [
    providerConnections,
    onProviderConnectionChange,
    onBuiltInProviderModeChange,
    onBuiltInProviderSupportsImageInputChange,
  ]);
  const handleBuiltInProviderApiKeyChange = useInputValueChange(onBuiltInProviderApiKeyChange);
  const handleBuiltInProviderBaseUrlChange = useInputValueChange(onBuiltInProviderBaseUrlChange);
  const handleBuiltInProviderSupportsImageInputChange = useCheckedChange(onBuiltInProviderSupportsImageInputChange);
  const handlePiProviderModeChange = useCallback((nextValue: string) => {
    const next = nextValue as PiProviderMode;
    onPiProviderModeChange(next);
    if (next === PI_PROVIDER_CONFIGURED) {
      onPiProviderApiKeyChange("");
    }
  }, [onPiProviderModeChange, onPiProviderApiKeyChange]);
  const handlePiProviderApiKeyChange = useInputValueChange(onPiProviderApiKeyChange);
  const handleModelChoiceChange = useCallback((next: string, custom: boolean) => {
    onCustomModelModeChange(custom);
    onModelChange(next);
  }, [onCustomModelModeChange, onModelChange]);
  const handleCustomModelChange = useInputValueChange(onModelChange);
  /** The retry action. No `mt-1`: it renders inside the status sentence, and a
   *  top margin on an inline action is what used to force it onto its own row. */
  const retryAction = modelSourceCanRetry ? (
    <FieldAction
      tone="link"
      type="button"
      onClick={runtimeModels.rescan}
      disabled={rescanDisabled || runtimeModels.loading}
      className="font-bold text-foreground-strong underline underline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {intl.formatMessage({ id: "agent.runtimeModels.retry" })}
    </FieldAction>
  ) : null;
  const envVarsField = envVarsMode === "hidden" ? null : (
    <RuntimeEnvVarsField
      entries={envVarEntries}
      onChange={onEnvVarEntriesChange}
      optional={envVarsMode === "inline"}
      hint={effectiveEnvVarsHint}
    />
  );
  const commandField = envVarsMode !== "hidden" && commandSupported ? (
    <Field
      label={formatMessage({ id: "agent.runtimeConfig.claudeCommand" })}
      optional
      hint={formatMessage({ id: "agent.runtimeConfig.claudeCommandHint" })}
      labelAccessory={<ClaudeCommandInfo />}
    >
      <Input
        type="text"
        value={command}
        onChange={handleCommandChange}
        placeholder="claude"
      />
    </Field>
  ) : null;
  const apiProviderFields = apiUrlSupported ? (
    <Field
      label={formatMessage({ id: "agent.runtimeConfig.provider" })}
      hint={formatMessage({ id: "agent.runtimeConfig.providerHint" })}
    >
      <RuntimeSelectControl
        value={providerMode}
        onValueChange={handleProviderModeChange}
        options={providerModeOptions}
        placeholder={formatMessage({ id: "agent.runtimeConfig.provider" })}
        portalContainer={selectPortalContainer}
        testId="runtime-provider-mode-select"
      />
    </Field>
  ) : null;
  const apiProviderRequiredFields = providerApiUrlRequired ? (
    <>
      {/* The error goes through the field's `error` SLOT, not a `<p>` dropped in
          beside the control.

          Same words, same colour — but a conditionally-rendered sibling has no
          height when there is nothing to say, so every field below it moved the
          moment the message appeared or cleared. That is the jump Cindy recorded:
          typing a first character into API KEY cleared its error and pulled MODEL
          up by a line. The slot is reserved whether or not it is occupied, so the
          form's height stops depending on its validity.

          It also stops us drawing our own error: `error` is what FormField and
          StableField already render, so this callsite no longer decides what an
          error looks like. */}
      <Field
        label={formatMessage({ id: "agent.runtimeConfig.apiUrl" })}
        required
        error={showValidationErrors && providerApiUrlInvalid
          ? formatMessage({ id: "agent.runtimeConfig.apiUrlInvalid" })
          : undefined}
      >
        <Input
          type="url"
          value={providerApiUrl}
          onChange={handleProviderApiUrlChange}
          placeholder="https://gateway.example.com"
        />
      </Field>
      <Field
        label={formatMessage({ id: "agent.runtimeConfig.apiKey" })}
        required
        error={showValidationErrors && !providerApiKey.trim()
          ? formatMessage({ id: "agent.runtimeConfig.apiKeyRequiredForCustomProvider" })
          : undefined}
      >
        <Input
          type="password"
          value={providerApiKey}
          onChange={handleProviderApiKeyChange}
          placeholder="sk-ant-..."
          autoComplete="off"
        />
      </Field>
    </>
  ) : null;
  const reasoningField = reasoningSupported ? (
    <Field label={formatMessage({ id: "agent.runtimeConfig.reasoning" })}>
      <RuntimeSelectControl
        value={reasoningEffort || DEFAULT_REASONING_EFFORT_SELECT_VALUE}
        onValueChange={handleReasoningEffortChange}
        options={reasoningOptions}
        placeholder={formatMessage({ id: "agent.runtimeConfig.reasoning" })}
        portalContainer={selectPortalContainer}
        testId="runtime-reasoning-select"
      />
    </Field>
  ) : null;
  const fastModeField = fastModeSupported ? (
    // MODE stays the field (group) label and the option name stays on the card.
    // The structure was never the problem — the appearance was: the plain Card
    // used panel elevation (4px) and an 18px/700 title against a 14px/700
    // uppercase field label, so the nested item outranked its own section
    // heading. `variant="option"` fixes exactly that (2px shadow, matching the
    // Input beside it, and a 14px title) without collapsing the two levels.
    //
    // Do not "simplify" this by moving the option name up into the field label:
    // that was tried (29acf6fa) while the Card was gone, and when the cards came
    // back (1926886) the label was left behind, so the schema-driven sibling
    // rendered "SUPPORTS IMAGE INPUT" above a card titled "Supports image
    // input" — the same words twice.
    //
    // `adopt={false}` + the explicit `aria-labelledby` are load-bearing here.
    // StableField adopts the single interactive child and a Card counts as one,
    // so the field's id and aria would land on the Card's `<label>` and collide
    // with the id Base UI gives the checkbox's hidden input; separately the
    // checkbox would inherit the FIELD's name and be announced as "Mode" rather
    // than "Fast mode" (@Dozy, and every test stayed green through it).
    <Field
      label={formatMessage({ id: "agent.runtimeConfig.mode" })}
      adopt={false}
    >
      <Card variant="option" render={<label />}>
        <CardHeader>
          <CardLeading>
            <Checkbox
              size="md"
              checked={fastMode}
              onCheckedChange={handleFastModeChange}
              aria-labelledby="runtime-fast-mode-title"
            />
          </CardLeading>
          <CardTitle id="runtime-fast-mode-title">{formatMessage({ id: "agent.runtimeConfig.fastMode" })}</CardTitle>
            <CardDescription>{formatMessage({ id: "agent.runtimeConfig.fastModeDescription" })}</CardDescription>
        </CardHeader>
      </Card>
    </Field>
  ) : null;
  // Provider belongs with Runtime and Model as basic configuration — burying it
  // with the technical knobs is why Create Cindy showed only Runtime + Model.
  // Nested disclosure state is local: no caller needs to drive it.

  const providerFields = (
    <>
      {apiProviderFields}
      {apiProviderRequiredFields}
    </>
  );
  // The genuinely technical knobs. These are what "Advanced" is for.
  const technicalFields = (
    <>
      {reasoningField}
      {fastModeField}
    </>
  );
  const showAdvancedSection = technicalFieldsMode === "advanced" || envVarsMode === "advanced";

  return (
    <>
      {showRuntimeField && (
        <Field
          label={effectiveRuntimeLabel}
          required
          hint={runtimeHint}
          labelAccessory={onRescanRuntimes ? (
            <Tooltip content={formatMessage({ id: "agent.runtimeConfig.rescanRuntimesTitle" })}>
              <FieldAction
                tone="icon"
                type="button"
                onClick={onRescanRuntimes}
                disabled={runtimesRescanning}
                className="ml-auto text-foreground-muted transition-colors hover:text-foreground-strong disabled:cursor-not-allowed disabled:opacity-50"
                aria-label={formatMessage({ id: "agent.runtimeConfig.rescanRuntimesAria" })}
              >
                <RefreshCw size={12} className={runtimesRescanning ? "animate-spin" : ""} />
              </FieldAction>
            </Tooltip>
          ) : undefined}
        >
          <RuntimeSelectControl
            value={runtime}
            onValueChange={onRuntimeChange}
            options={runtimeOptions}
            placeholder={formatMessage({ id: "common.select.placeholder" })}
            portalContainer={selectPortalContainer}
          />
        </Field>
      )}

      {runtimeFormV2 ? (
        runtimeFormV2.state.status === "ready" && runtimeFormV2.values ? (
          <RuntimeFormV2Fields
            form={runtimeFormV2.state.form}
            sources={runtimeFormV2.state.sources}
            values={runtimeFormV2.values}
            onChange={runtimeFormV2.onChange}
            showValidationErrors={showValidationErrors}
            serverErrors={runtimeFormV2.serverErrors}
            editing={runtimeFormV2.editing}
            portalContainer={selectPortalContainer}
            onRetrySource={runtimeFormV2.state.retrySource}
            retryingSourceIds={runtimeFormV2.state.retryingSourceIds}
            savedConnections={savedConnectionsForV2}
          />
        ) : (
          <p className="border border-line-muted bg-warning-soft p-3 text-sm font-bold text-warning-strong theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-soft-signal theme-brutal:text-black" data-testid="schema-runtime-unavailable">
            {formatMessage({
              id: runtimeFormUnavailableMessageId(
                runtimeFormV2.state.status === "loading" || runtimeFormV2.state.status === "idle",
                runtimeFormV2.state.status === "error",
                runtimeFormV2.state.status === "error" ? runtimeFormV2.state.errorCode : undefined,
              ),
            })}
          </p>
        )
      ) : schemaBacked ? (
        formDefinition ? (
          <SchemaDrivenRuntimeFields
            definition={formDefinition}
            providerId={builtInProviderMode}
            onProviderChange={handleSchemaProviderChange}
            apiKey={builtInProviderApiKey}
            onApiKeyChange={onBuiltInProviderApiKeyChange}
            baseUrl={builtInProviderBaseUrl}
            onBaseUrlChange={onBuiltInProviderBaseUrlChange}
            loadLocalPlugins={loadLocalPlugins}
            onLoadLocalPluginsChange={onLoadLocalPluginsChange}
            supportsImageInput={builtInProviderSupportsImageInput}
            onSupportsImageInputChange={onBuiltInProviderSupportsImageInputChange}
            model={model}
            persistedModel={persistedModel}
            onModelChange={onModelChange}
            reasoningEffort={reasoningEffort}
            onReasoningEffortChange={onReasoningEffortChange}
            onCustomModelModeChange={onCustomModelModeChange}
            envVarEntries={envVarEntries}
            onEnvVarEntriesChange={onEnvVarEntriesChange}
            advancedOpen={advancedOpen}
            onAdvancedOpenChange={onAdvancedOpenChange}
            portalContainer={selectPortalContainer}
            managedConnectionActive={managedConnectionActive}
            providerConnections={providerConnections}
            providerConnectionId={providerConnectionId}
            onProviderConnectionChange={onProviderConnectionChange}
            onEditProviderConnection={onEditProviderConnection}
            showValidationErrors={showValidationErrors}
          />
        ) : (
          <p className="border border-line-muted bg-warning-soft p-3 text-sm font-bold text-warning-strong theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-soft-signal theme-brutal:text-black" data-testid="schema-runtime-unavailable">
            {formatMessage({
              id: runtimeFormUnavailableMessageId(
                formDefinitionLoading,
                formDefinitionError,
                formDefinitionErrorCode,
              ),
            })}
          </p>
        )
      ) : (
        <>

      {/* Runtime → Provider → Model are the basic three, always visible. */}
      {providerFields}

      {builtInProviderSupported && (
        <>
          <Field
            label={formatMessage({ id: "agent.runtimeConfig.provider" })}
            hint={formatMessage({ id: "agent.runtimeConfig.builtInProviderHint" })}
            labelAccessory={selectedProviderConnection && onEditProviderConnection ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={handleEditProviderConnection}
                aria-label={formatMessage({ id: "agent.runtimeConfig.editSavedProvider" })}
                title={formatMessage({ id: "agent.runtimeConfig.editSavedProvider" })}
                data-testid="runtime-edit-provider-connection"
              >
                <Pencil size={14} aria-hidden="true" />
              </Button>
            ) : undefined}
            error={providerConnectionId && (!selectedProviderConnection || !selectedProviderConnection.enabled || !selectedProviderConnection.hasCredential)
              ? formatMessage({ id: "agent.runtimeConfig.savedProviderUnavailable" })
              : undefined}
          >
            <RuntimeSelectControl
              value={providerConnectionId
                ? providerConnectionSelectValue(providerConnectionId)
                : effectiveBuiltInProviderMode}
              onValueChange={handleBuiltInProviderChange}
              options={unifiedBuiltInProviderSelectOptions}
              placeholder={formatMessage({ id: "agent.runtimeConfig.provider" })}
              portalContainer={selectPortalContainer}
              testId="runtime-built-in-provider-select"
            />
            {showBuiltInRequiredHint && (
              <p className="mt-1 text-xs font-bold text-brutal-orange">
                {formatMessage(
                  { id: "agent.runtimeConfig.builtInRequiredHint" },
                  { runtimeName: getRuntimeDisplayName(runtime) },
                )}
              </p>
            )}
          </Field>
          <Field
            label={formatMessage(
              { id: "agent.runtimeConfig.apiKeyForProvider" },
              { provider: getRuntimeProviderDisplayName(effectiveBuiltInProviderMode) },
            )}
            required={!managedConnectionActive}
            error={showValidationErrors && !managedConnectionActive && !builtInProviderApiKey.trim()
              ? formatMessage(
                { id: "agent.runtimeConfig.apiKeyRequiredForProvider" },
                { provider: getRuntimeProviderDisplayName(effectiveBuiltInProviderMode) },
              )
              : undefined}
          >
            <Input
              type="password"
              value={managedConnectionActive ? "" : builtInProviderApiKey}
              onChange={handleBuiltInProviderApiKeyChange}
              placeholder={managedConnectionActive
                ? formatMessage(
                    { id: "agent.runtimeConfig.credentialFromSavedProvider" },
                    { connection: selectedProviderConnection?.name ?? formatMessage({ id: "agent.runtimeConfig.savedProviderUnavailable" }) },
                  )
                : "sk-..."}
              autoComplete="off"
              disabled={managedConnectionActive}
              data-testid="runtime-built-in-api-key"
            />
          </Field>
          {builtInGatewayProvider && (
            <>
              <Field
                label={formatMessage({ id: "agent.runtimeConfig.baseUrl" })}
                required
                error={showValidationErrors && builtInBaseUrlInvalid
                  ? formatMessage({ id: "agent.runtimeConfig.baseUrlInvalid" })
                  : undefined}
              >
                <Input
                  type="url"
                  value={managedConnectionActive
                    ? selectedProviderConnection?.endpointUrl ?? ""
                    : builtInProviderBaseUrl}
                  onChange={handleBuiltInProviderBaseUrlChange}
                  placeholder={effectiveBuiltInProviderMode === "anthropic-compatible" ? "https://gateway.example.com/anthropic" : "https://gateway.example.com/v1"}
                  disabled={managedConnectionActive}
                />
              </Field>
              <Field
                label={formatMessage({ id: "agent.runtimeConfig.imageInput" })}
                hint={formatMessage({ id: "agent.runtimeConfig.imageInputHint" })}
                adopt={false}
              >
                <Card variant="option" render={<label />}>
                  <CardHeader>
                    <CardLeading>
                      <Checkbox
                        size="md"
                        checked={managedConnectionActive
                          ? selectedProviderConnection?.supportsImageInput === true
                          : builtInProviderSupportsImageInput}
                        onCheckedChange={handleBuiltInProviderSupportsImageInputChange}
                        disabled={managedConnectionActive}
                        aria-labelledby="gateway-image-input-title"
                    data-testid="runtime-supports-image-input"
                      />
                    </CardLeading>
                    <CardTitle id="gateway-image-input-title">{formatMessage({ id: "agent.runtimeConfig.supportsImageInput" })}</CardTitle>
                  </CardHeader>
                </Card>
              </Field>
            </>
          )}
        </>
      )}

      {piProviderSupported && (
        <Field
          label={formatMessage({ id: "agent.runtimeConfig.provider" })}
          hint={formatMessage({ id: "agent.runtimeConfig.piProviderHint" })}
        >
          <RuntimeSelectControl
            value={piProviderMode}
            onValueChange={handlePiProviderModeChange}
            options={piProviderOptions}
            placeholder={formatMessage({ id: "agent.runtimeConfig.provider" })}
            portalContainer={selectPortalContainer}
          />
        </Field>
      )}

      {piApiKeyRequired && (
        <Field
          label={formatMessage(
            { id: "agent.runtimeConfig.apiKeyForProvider" },
            { provider: getRuntimeProviderDisplayName(piProviderMode) },
          )}
          required
          error={showValidationErrors && !piProviderApiKey.trim()
            ? formatMessage({ id: "agent.runtimeConfig.apiKeyRequiredForBuiltInProvider" })
            : undefined}
        >
          <Input
            type="password"
            value={piProviderApiKey}
            onChange={handlePiProviderApiKeyChange}
            placeholder="sk-..."
            autoComplete="off"
          />
        </Field>
      )}

      {/* Dynamic required per cindyz: only the modes that actually enforce a model
          value carry the marker. A static asterisk would claim the select can be
          left empty, which it cannot. */}
      <Field
        label={formatMessage({ id: "agent.runtimeConfig.model" })}
        required={customModelInputMode}
        // Was a conditional `<p>` in `belowControl`; moved to the slot for the
        // same reason as API URL/KEY above — it shifted everything under it.
        error={showValidationErrors && customModelInvalid
          ? formatMessage({ id: "agent.runtimeConfig.customModelRequired" })
          : undefined}
        labelAccessory={showHeaderRescan ? (
          <Tooltip content={intl.formatMessage({ id: "agent.runtimeModels.rescan" })}>
            <FieldAction
              tone="icon"
              type="button"
              onClick={runtimeModels.rescan}
              disabled={rescanDisabled || runtimeModels.loading}
              className="ml-auto text-foreground-muted hover:text-foreground-strong transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label={intl.formatMessage({ id: "agent.runtimeModels.rescan" })}
            >
              <RefreshCw size={12} className={runtimeModels.loading ? "animate-spin" : ""} />
            </FieldAction>
          </Tooltip>
        ) : undefined}
        belowControl={<>
          {modelSourceStatusContent && (
            <div
              className="mt-2 border-l-2 border-line-muted pl-2 text-xs text-foreground-muted"
              data-testid="runtime-model-source-status"
            >
              {/* The retry belongs INSIDE the sentence it acts on: "Models could
                  not be loaded from this Computer. Retry" reads as one
                  status line with a clickable tail, which is what "inline" means.
                  Previously it was a sibling of a block `<p>`, so no button size
                  could have saved it — a block element before it already forced
                  the line break. Size and position both had to change.

                  Agent Details used to render this stacked instead; both pages
                  now share the inline form. */}
              <p>
                {modelSourceStatusContent}
                {retryAction ? <>{" "}{retryAction}</> : null}
              </p>
            </div>
          )}
          {(selectedModelSuggestionOnly || (machineSourceApplies && runtimeModels.source.kind !== "live"
            && !runtimeModels.loading && runtimeModels.models.some((m) => m.verified === "suggestion_only"))) && (
            <p className="mt-1.5 text-xs text-foreground-muted">
              {formatMessage({ id: "agent.runtimeConfig.modelSuggestionOnly" })}
            </p>
          )}
        </>}
      >
        {/* One searchable box: pick a listed model, or (where the runtime takes
            any model id) type one and use it as typed. The stored value is the
            model id; the list shows names. */}
        {builtInGatewayProvider ? null : (
          <RuntimeChoiceCombobox
            options={modelChoiceOptions}
            value={model}
            onValueChange={handleModelChoiceChange}
            allowCustom={modelAllowsCustom}
            customValue={customModelMode}
            placeholder={formatMessage({
              id: customModelMode
                ? runtime === "claude" ? "agent.runtimeConfig.customModelName" : "agent.runtimeConfig.customModelId"
                : "agent.runtimeConfig.model",
            })}
            portalContainer={selectPortalContainer}
            testId="runtime-model-combobox"
          />
        )}
        {customModelSupported && builtInGatewayProvider && (
          /* `data-field-adopt` and no wrapping <div>: a gateway provider has no
             model list, so this Input is the field's only control. Wrapped in a
             div it was not even an adoption candidate and the field failed
             closed as misconfigured (@Dozy, review of H=b396d486). */
          <Input
            data-field-adopt
            type="text"
            value={model}
            onChange={handleCustomModelChange}
            placeholder={formatMessage({ id: "agent.runtimeConfig.gatewayModelId" })}
          />
        )}
      </Field>

      {technicalFieldsMode === "inline" && technicalFields}

      {/* Two levels of disclosure, not one. "More" is the ordinary escape hatch —
          tuning you might reasonably want. "Advanced" sits one level deeper inside
          it and holds what can break the agent if you get it wrong (a custom launch
          command, raw env vars). Calling the outer one "Advanced", as it used to be,
          warned people off options that are not actually dangerous. */}
      {showAdvancedSection ? (
        <div>
          <button
            type="button"
            onClick={() => onAdvancedOpenChange?.(!advancedOpen)}
            aria-expanded={advancedOpen}
            className="flex items-center gap-1 text-sm font-bold uppercase tracking-wide text-foreground-muted hover:text-foreground-strong"
          >
            {advancedOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            {formatMessage({ id: "agent.runtimeConfig.more" })}
          </button>
          {/* One level, not two (@cindyz, 2026-09-03). The inner "Advanced" existed
              to separate what can break the agent from ordinary tuning, but both
              words only mean "more stuff" — so the nesting cost a click and did
              not carry the risk message it was there for. The risk belongs in the
              copy of the fields that carry it, not in how deeply they are
              buried. */}
          {advancedOpen && (
            <div className="mt-3 space-y-3">
              {runtime === "builtin" && <LocalPiPluginsField checked={loadLocalPlugins} onChange={onLoadLocalPluginsChange} />}
              {technicalFieldsMode === "advanced" && technicalFields}
              {commandField}
              {envVarsField}
            </div>
          )}
        </div>
      ) : (
        <>
          {commandField}
          {envVarsField}
        </>
      )}
        </>
      )}
    </>
  );
}

/**
 * Protocol v2 form: rendered by field kind from the server's description, with
 * no field or runtime names in this component. State rules (defaults, cascade,
 * visibility, validation) live in @botiverse/raft-runtime-form so mobile follows
 * the same ones.
 */
export function RuntimeFormV2Fields({
  form,
  sources,
  values,
  onChange,
  showValidationErrors,
  serverErrors,
  editing = false,
  portalContainer,
  onRetrySource,
  retryingSourceIds = NO_SOURCE_IDS,
  savedConnections,
}: {
  form: ParsedRuntimeFormV2;
  sources: RuntimeFormV2Sources;
  values: RuntimeFormV2Values;
  onChange: (key: string, value: RuntimeFormV2Value) => void;
  showValidationErrors: boolean;
  /** Field key → message returned by the server for this submission. */
  serverErrors?: Record<string, string>;
  /** Edit: blank writeOnly (secret) fields keep the stored value. */
  editing?: boolean;
  portalContainer?: RefObject<HTMLElement | null>;
  /** `option_source.status`: re-request a source (`?refresh=1`). */
  onRetrySource?: (sourceId: string) => void;
  retryingSourceIds?: readonly string[];
  /**
   * `provider.saved_connection`: pencil action for the selected saved
   * connection. Present only for callers whose operator may edit provider
   * connections (the same authority gate as the v1 picker).
   */
  savedConnections?: { onEdit: (connectionId: string) => void };
}) {
  const { formatMessage } = useIntl();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const errors = validateRuntimeFormV2(form, sources, values, { editing });
  const errorText = (key: string): string | undefined => {
    if (serverErrors?.[key]) return serverErrors[key];
    // Save is disabled while this holds, so it shows without a submit attempt.
    if (errors[key] === "secret_reentry_required") return formatMessage({ id: "agent.runtimeFormV2.secretReentryRequired" });
    if (!showValidationErrors || !errors[key]) return undefined;
    switch (errors[key]) {
      case "invalid_url": return formatMessage({ id: "agent.runtimeConfig.baseUrlInvalid" });
      case "not_a_choice": return formatMessage({ id: "agent.runtimeFormV2.notAChoice" });
      case "unsupported_required": return formatMessage({ id: "agent.runtimeFormV2.updateToEdit" });
      // The field's source status line already says why, with its retry.
      case "source_unavailable": return undefined;
      // A bound-but-unavailable saved connection: visible, never silently rewritten.
      case "connection_unavailable": return formatMessage({ id: "agent.runtimeConfig.savedProviderUnavailable" });
      default: return formatMessage({ id: "agent.runtimeFormV2.required" });
    }
  };

  // Saved provider connections (`provider.saved_connection`): while any field
  // holds a connection selection, the fields it owns are the connection's, not
  // the user's — disabled, placeholder, never submitted (the shared
  // runtimeFormV2Submission rules). Per-field rendering lives in
  // RuntimeFormV2FieldControl; the parent computes the form-wide state once.
  const connectionActive = runtimeFormV2ConnectionActive(form, sources, values);
  const selectedConnectionOption = connectionActive
    ? form.fields
        .map((candidate) => runtimeFormV2SelectedConnection(candidate, sources, values))
        .find((option): option is NonNullable<typeof option> => option !== undefined)
    : undefined;
  const managedPlaceholder = formatMessage(
    { id: "agent.runtimeConfig.credentialFromSavedProvider" },
    { connection: selectedConnectionOption?.label ?? formatMessage({ id: "agent.runtimeConfig.savedProviderUnavailable" }) },
  );

  const renderField = (field: RuntimeFormV2Field) => (
    // An optional field whose source is unavailable is hidden (option_source.status).
    isRuntimeFormV2FieldVisible(field, values, sources) ? (
      <RuntimeFormV2FieldControl
        key={field.key}
        field={field}
        sources={sources}
        values={values}
        onChange={onChange}
        error={errorText(field.key)}
        // A secret that cannot keep the stored value is edited like on create:
        // required, without the "leave blank to keep" hint.
        editing={editing && errors[field.key] !== "secret_reentry_required"}
        portalContainer={portalContainer}
        onRetrySource={onRetrySource}
        retryingSourceIds={retryingSourceIds}
        connectionActive={connectionActive}
        managedPlaceholder={connectionActive ? managedPlaceholder : undefined}
        savedConnections={savedConnections}
      />
    ) : null
  );

  const main = form.fields.filter((field) => !field.advanced);
  const advanced = form.fields.filter((field) => field.advanced);
  return (
    <>
      {main.map(renderField)}
      {advanced.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setAdvancedOpen(!advancedOpen)}
            aria-expanded={advancedOpen}
            className="flex items-center gap-1 text-sm font-bold uppercase tracking-wide text-foreground-muted hover:text-foreground-strong"
          >
            {advancedOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            {formatMessage({ id: "agent.runtimeConfig.advanced" })}
          </button>
          {advancedOpen && (
            <div className="mt-3 border-l border-line-muted theme-brutal:border-l-2 theme-brutal:border-black/10 pl-3">
              {advanced.map(renderField)}
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** Key/value editor over a string map; keeps half-typed rows locally until they have a key. */
export function RuntimeFormV2StringMapField({
  value,
  hint,
  onChange,
}: {
  value: Record<string, string>;
  hint?: string;
  onChange: (next: Record<string, string>) => void;
}) {
  const [entries, setEntries] = useState<EnvVarEntry[]>(() => Object.entries(value).map(([key, item]) => ({ key, value: item })));
  const handleChange = useCallback((next: EnvVarEntry[]) => {
    setEntries(next);
    const map: Record<string, string> = {};
    for (const entry of next) if (entry.key.trim()) map[entry.key.trim()] = entry.value;
    onChange(map);
  }, [onChange]);
  return (
    <RuntimeEnvVarsField
      entries={entries}
      hint={hint}
      onChange={handleChange}
    />
  );
}
