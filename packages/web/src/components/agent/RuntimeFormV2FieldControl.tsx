import { Button, Card, CardDescription, CardHeader, CardLeading, CardTitle, Checkbox, Input } from "raft-ui";
import { Pencil } from "lucide-react";
import { useCallback, useMemo } from "react";
import type { ChangeEvent, RefObject } from "react";
import { runtimeFormV2Choices, runtimeFormV2SelectedConnection, runtimeFormV2SourceStatus } from "@botiverse/raft-runtime-form";
import type { RuntimeFormV2ChoiceOption, RuntimeFormV2Field, RuntimeFormV2Sources, RuntimeFormV2Value, RuntimeFormV2Values } from "@botiverse/raft-runtime-form";
import { useIntl } from "react-intl";
import { Field, RuntimeFormV2StringMapField, RuntimeSelectControl } from "./RuntimeConfigFields";
import { RuntimeFormV2ChoiceCombobox } from "./RuntimeChoiceCombobox";
import type { RuntimeOption } from "./RuntimeConfigFields";
import { RuntimeFormV2SourceStatusLine } from "./RuntimeFormV2SourceStatusLine";

const RUNTIME_FORM_V2_EMPTY_CHOICE = "__runtime_form_v2_default__";

const NO_RUNTIME_OPTIONS: RuntimeOption[] = [];

const EMPTY_STRING_MAP: Record<string, string> = {};

/** One protocol v2 field, rendered by its kind. */
export function RuntimeFormV2FieldControl({
  field,
  sources,
  values,
  onChange,
  error,
  editing,
  portalContainer,
  onRetrySource,
  retryingSourceIds,
  connectionActive = false,
  managedPlaceholder,
  savedConnections,
}: {
  field: RuntimeFormV2Field;
  sources: RuntimeFormV2Sources;
  values: RuntimeFormV2Values;
  onChange: (key: string, value: RuntimeFormV2Value) => void;
  error: string | undefined;
  editing: boolean;
  portalContainer?: RefObject<HTMLElement | null>;
  onRetrySource?: (sourceId: string) => void;
  retryingSourceIds: readonly string[];
  /** `provider.saved_connection`: some field currently holds a saved-connection selection. */
  connectionActive?: boolean;
  /** Placeholder for connection-owned fields ("Provided by …"); parent-computed. */
  managedPlaceholder?: string;
  /** Pencil action for the selected saved connection; present only for authorized operators. */
  savedConnections?: { onEdit: (connectionId: string) => void };
}) {
  const { formatMessage } = useIntl();
  const fieldKey = field.key;
  const choices = useMemo(() => runtimeFormV2Choices(field, sources, values), [field, sources, values]);
  const value = values[fieldKey];
  const text = typeof value === "string" ? value : "";
  const secretKept = editing && field.kind === "secret";
  // Saved provider connections: a field the selected connection owns is the
  // connection's, not the user's — disabled, safe placeholder, never required
  // (and never submitted; the shared runtimeFormV2Submission rules drop it).
  const connectionOwnedNow = connectionActive && field.connectionOwned === true;
  const fieldConnection = runtimeFormV2SelectedConnection(field, sources, values);
  const connectionId = typeof fieldConnection?.connectionId === "string" && fieldConnection.connectionId
    ? fieldConnection.connectionId
    : undefined;
  const savedGroupLabel = formatMessage({ id: "agent.runtimeConfig.savedProviders" });
  const directGroupLabel = formatMessage({ id: "agent.runtimeConfig.directProviders" });
  const toRuntimeOptionV2 = useCallback((option: RuntimeFormV2ChoiceOption): RuntimeOption => ({
    value: option.value,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
    ...(option.unavailable === true ? { disabled: true } : {}),
    ...(option.group === "saved"
      ? { group: savedGroupLabel }
      : option.group === "direct"
        ? { group: directGroupLabel }
        : {}),
  }), [savedGroupLabel, directGroupLabel]);
  const handleEditConnection = useCallback(() => {
    if (connectionId && savedConnections) savedConnections.onEdit(connectionId);
  }, [connectionId, savedConnections]);
  const pencilLabel = formatMessage({ id: "agent.runtimeConfig.editSavedProvider" });
  const hint = connectionOwnedNow
    ? managedPlaceholder
    : secretKept ? formatMessage({ id: "agent.runtimeFormV2.secretKept" }) : field.hint;
  const required = field.required && !secretKept && !connectionOwnedNow;
  const common = useMemo(
    () => ({
      label: field.label,
      hint,
      required,
      error,
      ...(connectionId && savedConnections
        ? {
            // The pencil action for the selected saved connection (authorized
            // operators only); built inside the memo so its identity is stable.
            labelAccessory: (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={handleEditConnection}
                aria-label={pencilLabel}
                title={pencilLabel}
                data-testid={`runtime-form-v2-edit-provider-connection-${fieldKey}`}
              >
                <Pencil size={14} aria-hidden="true" />
              </Button>
            ),
          }
        : {}),
    }),
    [connectionId, savedConnections, handleEditConnection, pencilLabel, fieldKey, field.label, hint, required, error],
  );
  const listedOptions = useMemo(
    () => (choices?.kind === "select" ? choices.options.map(toRuntimeOptionV2) : NO_RUNTIME_OPTIONS),
    [choices, toRuntimeOptionV2],
  );
  const selectOptions = useMemo((): RuntimeOption[] => (choices?.kind === "select"
    ? [
        ...(choices.allowEmpty ? [{ value: RUNTIME_FORM_V2_EMPTY_CHOICE, label: formatMessage({ id: "agent.runtimeConfig.default" }) }] : []),
        ...listedOptions,
        ...(text && !choices.options.some((option) => option.value === text) ? [{ value: text, label: text, disabled: true }] : []),
      ]
    : NO_RUNTIME_OPTIONS), [choices, listedOptions, text, formatMessage]);
  const emptyOption = useMemo(
    (): RuntimeOption => ({ value: RUNTIME_FORM_V2_EMPTY_CHOICE, label: formatMessage({ id: "agent.runtimeConfig.default" }) }),
    [formatMessage],
  );
  const handleValueChange = useCallback(
    (next: RuntimeFormV2Value) => onChange(fieldKey, next),
    [onChange, fieldKey],
  );
  const handleCheckedChange = useCallback(
    (checked: boolean) => onChange(fieldKey, checked === true),
    [onChange, fieldKey],
  );
  const handleSelectChange = useCallback(
    (next: string) => onChange(fieldKey, next === RUNTIME_FORM_V2_EMPTY_CHOICE ? "" : next),
    [onChange, fieldKey],
  );
  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChange(fieldKey, event.target.value),
    [onChange, fieldKey],
  );
  const testId = `runtime-form-v2-${fieldKey}`;
  switch (field.kind) {
    case "unsupported":
      return field.required ? (
        <Field {...common} adopt={false}>
          <p className="text-sm text-foreground-muted" data-testid={testId}>
            {formatMessage({ id: "agent.runtimeFormV2.updateToEdit" })}
          </p>
        </Field>
      ) : null;
    case "boolean":
      return (
        <Field {...common} label={undefined} adopt={false}>
          <Card variant="option" render={<label />}>
            <CardHeader>
              <CardLeading>
                <Checkbox size="md" checked={value === true} disabled={connectionOwnedNow} onCheckedChange={handleCheckedChange} data-testid={testId} />
              </CardLeading>
              <CardTitle>{field.label}</CardTitle>
              {field.hint && <CardDescription>{field.hint}</CardDescription>}
            </CardHeader>
          </Card>
        </Field>
      );
    case "string_map":
      return (
        <RuntimeFormV2StringMapField
          value={value && typeof value === "object" ? value : EMPTY_STRING_MAP}
          hint={field.hint}
          onChange={handleValueChange}
        />
      );
    default: {
      const status = runtimeFormV2SourceStatus(field, sources);
      const statusLine = status && field.optionSourceId ? (
        <RuntimeFormV2SourceStatusLine
          status={status}
          sourceId={field.optionSourceId}
          testId={testId}
          onRetrySource={onRetrySource}
          retrying={retryingSourceIds.includes(field.optionSourceId)}
        />
      ) : null;
      if (choices?.kind === "select") {
        // A derived list with nothing to offer (e.g. a model without an effort menu) is not shown.
        if (field.kind === "derived_select" && choices.options.length === 0) return null;
        // A list the Computer reports (models) can be long: search it. A custom
        // value field types into the same box. Short fixed lists stay a select.
        if (choices.allowCustom || (field.optionSourceId && field.kind !== "derived_select")) {
          return (
            <RuntimeFormV2ChoiceCombobox
              common={common}
              options={listedOptions}
              value={text}
              onValueChange={handleValueChange}
              emptyOption={choices.allowEmpty ? emptyOption : undefined}
              allowCustom={choices.allowCustom}
              placeholder={field.placeholder ?? field.label}
              portalContainer={portalContainer}
              testId={testId}
              belowControl={statusLine}
            />
          );
        }
        return (
          <Field {...common} belowControl={statusLine}>
            <RuntimeSelectControl
              value={text || (choices.allowEmpty ? RUNTIME_FORM_V2_EMPTY_CHOICE : "")}
              onValueChange={handleSelectChange}
              options={selectOptions}
              placeholder={field.placeholder ?? field.label}
              portalContainer={portalContainer}
              testId={testId}
            />
          </Field>
        );
      }
      return (
        <Field {...common}>
          <Input
            type={field.kind === "secret" ? "password" : field.kind === "url" ? "url" : "text"}
            value={connectionOwnedNow ? "" : text}
            onChange={handleInputChange}
            placeholder={connectionOwnedNow ? managedPlaceholder : field.placeholder}
            autoComplete={field.kind === "secret" ? "off" : undefined}
            disabled={connectionOwnedNow}
            data-testid={testId}
          />
        </Field>
      );
    }
  }
}
