import { useCallback } from "react";
import type { ChangeEvent } from "react";
import { useIntl } from "react-intl";
import { Button, Input } from "raft-ui";
import { Trash2 } from "lucide-react";

export type EnvVarEntry = { key: string; value: string };

export function EnvVarEntryRow({
  index,
  entry,
  onChange,
  onRemove,
}: {
  index: number;
  entry: EnvVarEntry;
  onChange: (index: number, patch: Partial<EnvVarEntry>) => void;
  onRemove: (index: number) => void;
}) {
  const { formatMessage } = useIntl();
  const handleKeyChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => onChange(index, { key: e.target.value }),
    [onChange, index],
  );
  const handleValueChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => onChange(index, { value: e.target.value }),
    [onChange, index],
  );
  const handleRemove = useCallback(() => onRemove(index), [onRemove, index]);
  return (
    <div className="flex items-center gap-2">
      <Input
        type="text"
        value={entry.key}
        onChange={handleKeyChange}
        className="border border-line-muted bg-layer-card px-2 py-1 text-xs font-mono shadow-raft-sm focus:outline-none w-1/3 theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white theme-brutal:shadow-brutal-sm"
        placeholder={formatMessage({ id: "agent.runtimeConfig.envVarName" })}
      />
      <span className="text-foreground-muted">=</span>
      <Input
        type="text"
        value={entry.value}
        onChange={handleValueChange}
        className="border border-line-muted bg-layer-card px-2 py-1 text-xs font-mono shadow-raft-sm focus:outline-none flex-1 theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white theme-brutal:shadow-brutal-sm"
        placeholder={formatMessage({ id: "agent.runtimeConfig.envVarFallback" })}
      />
      <Button variant="danger" size="icon-sm"
        type="button"
        onClick={handleRemove}
        className=""
      >
        <Trash2 size={12} />
      </Button>
    </div>
  );
}
