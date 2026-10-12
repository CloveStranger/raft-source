import { ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import { DEFAULT_REASONING_EFFORT_SELECT_VALUE, Field, RuntimeEnvVarsField, RuntimeSelectControl } from "./RuntimeConfigFields";
import type { RuntimeOption, SchemaDrivenRuntimeFieldsProps, SchemaSelectSource } from "./RuntimeConfigFields";

const NO_REASONING_EFFORTS: readonly string[] = [];

export function SchemaKimiRuntimeFields({
  definition,
  modelSource,
  model,
  onModelChange,
  reasoningEffort,
  onReasoningEffortChange,
  envVarEntries,
  onEnvVarEntriesChange,
  advancedOpen,
  onAdvancedOpenChange,
  portalContainer,
  showValidationErrors = true,
}: SchemaDrivenRuntimeFieldsProps & { modelSource: SchemaSelectSource }) {
  const { formatMessage } = useIntl();
  const selectedModel = modelSource.options.find((option) => option.value === model);
  const modelOptions = useMemo(() => (selectedModel || !model
    ? modelSource.options
    : [
        ...modelSource.options,
        {
          value: model,
          label: formatMessage(
            { id: "agent.detail.modelNotInComputerConfig" },
            { model },
          ),
          disabled: true,
        },
      ]), [selectedModel, model, modelSource.options, formatMessage]);
  const supportedEfforts = selectedModel?.supportedReasoningEfforts ?? NO_REASONING_EFFORTS;
  const incompatibleEffort = reasoningEffort !== null && !supportedEfforts.includes(reasoningEffort);
  const effortOptions = useMemo((): RuntimeOption[] => [
    {
      value: DEFAULT_REASONING_EFFORT_SELECT_VALUE,
      label: formatMessage({ id: "agent.runtimeConfig.default" }),
    },
    ...supportedEfforts.map((effort) => ({ value: effort, label: effort })),
    ...(incompatibleEffort
      ? [{ value: reasoningEffort, label: reasoningEffort, disabled: true }]
      : []),
  ], [supportedEfforts, incompatibleEffort, reasoningEffort, formatMessage]);
  const handleModelChange = useCallback((next: string) => {
    const nextModel = modelSource.options.find((option) => option.value === next);
    onModelChange(next);
    onReasoningEffortChange(nextModel?.defaultReasoningEffort ?? null);
  }, [modelSource.options, onModelChange, onReasoningEffortChange]);
  const handleReasoningEffortChange = useCallback((next: string) => onReasoningEffortChange(
    next === DEFAULT_REASONING_EFFORT_SELECT_VALUE ? null : next,
  ), [onReasoningEffortChange]);
  const labels = definition.uiSchema.localization;
  return (
    <>
      <Field
        label={labels.model?.label ?? formatMessage({ id: "agent.runtimeConfig.model" })}
        hint={labels.model?.hint}
        required
        error={showValidationErrors && !selectedModel
          ? formatMessage({ id: "agent.runtimeConfig.modelRequired" })
          : undefined}
      >
        <RuntimeSelectControl
          value={model}
          onValueChange={handleModelChange}
          options={modelOptions}
          placeholder={labels.model?.placeholder ?? formatMessage({ id: "agent.runtimeConfig.model" })}
          portalContainer={portalContainer}
          testId="schema-runtime-model-select"
        />
      </Field>
      {supportedEfforts.length > 0 && (
        <Field
          label={labels.reasoningEffort?.label ?? formatMessage({ id: "agent.runtimeConfig.reasoning" })}
          hint={labels.reasoningEffort?.hint}
          error={showValidationErrors && incompatibleEffort
            ? formatMessage({ id: "agent.runtimeConfig.reasoningEffortInvalid" })
            : undefined}
        >
          <RuntimeSelectControl
            value={reasoningEffort ?? DEFAULT_REASONING_EFFORT_SELECT_VALUE}
            onValueChange={handleReasoningEffortChange}
            options={effortOptions}
            placeholder={formatMessage({ id: "agent.runtimeConfig.default" })}
            portalContainer={portalContainer}
            testId="schema-runtime-reasoning-select"
          />
        </Field>
      )}
      {definition.uiSchema.layout.advanced.includes("/envVars") && (
        <div>
          <button
            type="button"
            onClick={() => onAdvancedOpenChange?.(!advancedOpen)}
            aria-expanded={advancedOpen}
            className="flex items-center gap-1 text-sm font-bold uppercase tracking-wide text-foreground-muted hover:text-foreground-strong"
          >
            {advancedOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            {formatMessage({ id: "agent.runtimeConfig.advanced" })}
          </button>
          {advancedOpen && (
            <div className="mt-3 border-l border-line-muted theme-brutal:border-l-2 theme-brutal:border-black/10 pl-3">
              <RuntimeEnvVarsField
                entries={envVarEntries}
                onChange={onEnvVarEntriesChange}
                hint={labels.envVars?.hint}
              />
            </div>
          )}
        </div>
      )}
    </>
  );
}
