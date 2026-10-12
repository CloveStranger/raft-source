import { KeyValueInputRow } from "../ui/KeyValueInput";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import type { EnvVarEntry } from "./RuntimeConfigFields";

export function RuntimeEnvVarRow({
  index,
  entry,
  onKeyChange,
  onValueChange,
  onRemove,
}: {
  index: number;
  entry: EnvVarEntry;
  onKeyChange: (index: number, key: string) => void;
  onValueChange: (index: number, value: string) => void;
  onRemove: (index: number) => void;
}) {
  const { formatMessage } = useIntl();
  const handleKeyChange = useCallback((key: string) => onKeyChange(index, key), [onKeyChange, index]);
  const handleValueChange = useCallback((value: string) => onValueChange(index, value), [onValueChange, index]);
  const handleRemove = useCallback(() => onRemove(index), [onRemove, index]);
  return (
    <KeyValueInputRow
      keyValue={entry.key}
      value={entry.value}
      onKeyChange={handleKeyChange}
      onValueChange={handleValueChange}
      onRemove={handleRemove}
      keyLabel={formatMessage({ id: "agent.runtimeConfig.envVarName" })}
      valueLabel={formatMessage(
        { id: "agent.runtimeConfig.envVarValueFor" },
        { name: entry.key || formatMessage({ id: "agent.runtimeConfig.envVarFallback" }) },
      )}
      removeLabel={formatMessage({ id: "agent.runtimeConfig.removeEnvVar" })}
    />
  );
}
