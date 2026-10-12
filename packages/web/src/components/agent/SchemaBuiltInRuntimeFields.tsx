import { getModelLabel, getRuntimeProviderDisplayName } from "@botiverse/raft-shared";
import type { AgentCreateFormOptionSource } from "@botiverse/raft-shared";
import { Button, Card, CardHeader, CardLeading, CardTitle, Checkbox, Input } from "raft-ui";
import { ChevronDown, ChevronRight, Pencil } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import { Field, LocalPiPluginsField, NO_PROVIDER_CONNECTIONS, RuntimeEnvVarsField, RuntimeSelectControl, ignoreChange, providerConnectionIdFromSelectValue, providerConnectionSelectValue, unifiedBuiltInProviderOptions, useCheckedChange, useInputValueChange } from "./RuntimeConfigFields";
import type { SchemaDrivenRuntimeFieldsProps, SchemaSelectSource } from "./RuntimeConfigFields";

type SchemaDependentSelectSource = Extract<AgentCreateFormOptionSource, { kind: "dependent_select" }>;

const NO_SCHEMA_OPTIONS: SchemaSelectSource["options"] = [];

export function SchemaBuiltInRuntimeFields({
  definition,
  providerSource,
  modelSource,
  providerId,
  onProviderChange,
  apiKey,
  onApiKeyChange,
  baseUrl,
  onBaseUrlChange,
  supportsImageInput,
  onSupportsImageInputChange,
  loadLocalPlugins,
  onLoadLocalPluginsChange,
  model,
  persistedModel,
  onModelChange,
  onCustomModelModeChange,
  envVarEntries,
  onEnvVarEntriesChange,
  advancedOpen,
  onAdvancedOpenChange,
  portalContainer,
  managedConnectionActive = false,
  providerConnections = NO_PROVIDER_CONNECTIONS,
  providerConnectionId = "",
  onProviderConnectionChange = ignoreChange,
  onEditProviderConnection,
  showValidationErrors = true,
}: SchemaDrivenRuntimeFieldsProps & {
  providerSource: SchemaSelectSource;
  modelSource: SchemaDependentSelectSource;
}) {
  const { formatMessage } = useIntl();
  const selectedProviderConnection = providerConnections.find((connection) => connection.id === providerConnectionId) ?? null;
  const effectiveProviderId = selectedProviderConnection?.providerId ?? providerId;
  const providerOption = providerSource.options.find((option) => option.value === effectiveProviderId);
  const providerOptions = providerOption || !persistedModel
    ? providerSource.options
    : [
        ...providerSource.options,
        {
          value: effectiveProviderId,
          label: effectiveProviderId,
          providerKind: "preset" as const,
          disabled: true,
        },
      ];
  const providerSelectOptions = unifiedBuiltInProviderOptions({
    directOptions: providerOptions,
    connections: providerConnections.map((connection) => providerSource.options.some(
      (option) => option.value === connection.providerId,
    ) ? connection : { ...connection, enabled: false }),
    selectedConnectionId: providerConnectionId,
    connectionLabel: (candidateProviderId, connectionName) => formatMessage(
      { id: "agent.runtimeConfig.savedProviderLabel" },
      {
        provider: providerSource.options.find(
          (option) => option.value === candidateProviderId,
        )?.label ?? getRuntimeProviderDisplayName(candidateProviderId),
        connection: connectionName,
      },
    ),
    savedGroupLabel: formatMessage({ id: "agent.runtimeConfig.savedProviders" }),
    directGroupLabel: formatMessage({ id: "agent.runtimeConfig.directProviders" }),
    unavailableLabel: formatMessage({ id: "agent.runtimeConfig.savedProviderUnavailable" }),
  });
  const providerConnectionInvalid = Boolean(providerConnectionId)
    && (!selectedProviderConnection || !selectedProviderConnection.enabled || !selectedProviderConnection.hasCredential);
  const gateway = providerOption?.providerKind === "gateway";
  const modelOptions = useMemo(() => {
    const liveModelOptions = modelSource.optionsByValue[effectiveProviderId] ?? NO_SCHEMA_OPTIONS;
    return persistedModel && !liveModelOptions.some((option) => option.value === persistedModel)
      ? [
          ...liveModelOptions,
          {
            value: persistedModel,
            label: getModelLabel("builtin", persistedModel),
            disabled: true,
          },
        ]
      : liveModelOptions;
  }, [modelSource.optionsByValue, effectiveProviderId, persistedModel]);
  const labels = definition.uiSchema.localization;
  const baseUrlVisible = definition.uiSchema.visibility.some((rule) =>
    rule.pointer === "/baseUrl" && rule.when.pointer === "/providerId" && rule.when.in.includes(effectiveProviderId));
  const supportsImageInputVisible = definition.uiSchema.visibility.some((rule) =>
    rule.pointer === "/supportsImageInput" && rule.when.pointer === "/providerId" && rule.when.in.includes(effectiveProviderId));
  const baseUrlInvalid = baseUrlVisible && !/^https?:\/\//i.test(baseUrl.trim());

  const handleEditProviderConnection = useCallback(() => {
    if (selectedProviderConnection) onEditProviderConnection?.(selectedProviderConnection);
  }, [selectedProviderConnection, onEditProviderConnection]);
  const handleProviderChange = useCallback((next: string) => {
    const connectionId = providerConnectionIdFromSelectValue(next);
    if (connectionId) {
      const connection = providerConnections.find((candidate) => candidate.id === connectionId);
      if (!connection || !connection.enabled || !connection.hasCredential) return;
      onProviderConnectionChange(connection);
      onAdvancedOpenChange?.(false);
      return;
    }
    const nextOption = providerSource.options.find((option) => option.value === next);
    const nextCustom = nextOption?.providerKind === "gateway";
    onProviderConnectionChange(null);
    onProviderChange(next);
    onCustomModelModeChange(nextCustom);
    onBaseUrlChange("");
    onSupportsImageInputChange(false);
    onAdvancedOpenChange?.(false);
    onModelChange(nextCustom ? "" : (modelSource.defaultValueByValue[next] ?? ""));
  }, [
    providerConnections,
    providerSource.options,
    modelSource.defaultValueByValue,
    onProviderConnectionChange,
    onAdvancedOpenChange,
    onProviderChange,
    onCustomModelModeChange,
    onBaseUrlChange,
    onSupportsImageInputChange,
    onModelChange,
  ]);
  const handleApiKeyChange = useInputValueChange(onApiKeyChange);
  const handleBaseUrlChange = useInputValueChange(onBaseUrlChange);
  const handleSupportsImageInputChange = useCheckedChange(onSupportsImageInputChange);
  const handleModelInputChange = useInputValueChange(onModelChange);

  return (
    <>
      <Field
        label={labels.providerId?.label ?? formatMessage({ id: "agent.runtimeConfig.provider" })}
        hint={labels.providerId?.hint}
        labelAccessory={selectedProviderConnection && onEditProviderConnection ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={handleEditProviderConnection}
            aria-label={formatMessage({ id: "agent.runtimeConfig.editSavedProvider" })}
            title={formatMessage({ id: "agent.runtimeConfig.editSavedProvider" })}
            data-testid="schema-runtime-edit-provider-connection"
          >
            <Pencil size={14} aria-hidden="true" />
          </Button>
        ) : undefined}
        error={providerConnectionInvalid
          ? formatMessage({ id: "agent.runtimeConfig.savedProviderUnavailable" })
          : undefined}
      >
        <RuntimeSelectControl
          value={providerConnectionId
            ? providerConnectionSelectValue(providerConnectionId)
            : effectiveProviderId}
          onValueChange={handleProviderChange}
          options={providerSelectOptions}
          placeholder={labels.providerId?.placeholder ?? formatMessage({ id: "agent.runtimeConfig.provider" })}
          portalContainer={portalContainer}
          testId="schema-runtime-provider-select"
        />
      </Field>
      <Field
        label={formatMessage(
          { id: "agent.runtimeConfig.apiKeyForProvider" },
          { provider: providerOption?.label ?? labels.apiKey?.label ?? formatMessage({ id: "agent.runtimeConfig.provider" }) },
        )}
        required={!managedConnectionActive}
        error={showValidationErrors && !managedConnectionActive && !apiKey.trim()
          ? formatMessage({ id: "agent.runtimeConfig.apiKeyRequired" })
          : undefined}
      >
        <Input
          type="password"
          value={managedConnectionActive ? "" : apiKey}
          onChange={handleApiKeyChange}
          placeholder={managedConnectionActive
            ? formatMessage(
                { id: "agent.runtimeConfig.credentialFromSavedProvider" },
                { connection: selectedProviderConnection?.name ?? formatMessage({ id: "agent.runtimeConfig.savedProviderUnavailable" }) },
              )
            : labels.apiKey?.placeholder ?? "sk-..."}
          autoComplete="off"
          disabled={managedConnectionActive}
          data-testid="schema-runtime-api-key"
        />
      </Field>
      {baseUrlVisible && (
        <Field
          label={labels.baseUrl?.label ?? formatMessage({ id: "agent.runtimeConfig.baseUrl" })}
          required={!managedConnectionActive}
          error={showValidationErrors && !managedConnectionActive && baseUrlInvalid
            ? formatMessage({ id: "agent.runtimeConfig.baseUrlInvalid" })
            : undefined}
        >
          <Input
            type="url"
            value={managedConnectionActive ? selectedProviderConnection?.endpointUrl ?? "" : baseUrl}
            onChange={handleBaseUrlChange}
            placeholder={labels.baseUrl?.placeholder ?? "https://gateway.example.com/v1"}
            disabled={managedConnectionActive}
            data-testid="schema-runtime-base-url"
          />
        </Field>
      )}
      {supportsImageInputVisible && (
        <Field
          label={formatMessage({ id: "agent.runtimeConfig.imageInput" })}
          hint={labels.supportsImageInput?.hint}
          adopt={false}
        >
          <Card variant="option" render={<label />}>
            <CardHeader>
              <CardLeading>
                <Checkbox
                  size="md"
                  checked={managedConnectionActive
                    ? selectedProviderConnection?.supportsImageInput === true
                    : supportsImageInput}
                  onCheckedChange={handleSupportsImageInputChange}
                  disabled={managedConnectionActive}
                  aria-labelledby="schema-image-input-title"
            data-testid="schema-runtime-supports-image-input"
                />
              </CardLeading>
              <CardTitle id="schema-image-input-title">{labels.supportsImageInput?.label ?? formatMessage({ id: "agent.runtimeConfig.supportsImageInput" })}</CardTitle>
            </CardHeader>
          </Card>
        </Field>
      )}
      <Field
        label={labels.model?.label ?? formatMessage({ id: "agent.runtimeConfig.model" })}
        required
        error={showValidationErrors && !model.trim()
          ? formatMessage({ id: "agent.runtimeConfig.modelRequired" })
          : undefined}
      >
        {gateway ? (
          <Input
            type="text"
            value={model}
            onChange={handleModelInputChange}
            placeholder={labels.model?.placeholder ?? formatMessage({ id: "agent.runtimeConfig.gatewayModelId" })}
            data-testid="schema-runtime-custom-model"
          />
        ) : (
          <RuntimeSelectControl
            value={model}
            onValueChange={onModelChange}
            options={modelOptions}
            placeholder={labels.model?.placeholder ?? formatMessage({ id: "agent.runtimeConfig.model" })}
            portalContainer={portalContainer}
            testId="schema-runtime-model-select"
          />
        )}
      </Field>
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
              {"loadLocalPlugins" in definition.dataSchema.properties && (
                <LocalPiPluginsField checked={loadLocalPlugins} onChange={onLoadLocalPluginsChange} />
              )}
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
