import { Card } from "raft-ui";
import { useCallback } from "react";
import type { BulkResetMode, BulkResetOption } from "./MachineDetailPanel";

export function BulkResetOptionCard({
  option,
  selected,
  disabled,
  onSelect,
}: {
  option: BulkResetOption;
  selected: boolean;
  disabled: boolean;
  onSelect: (mode: BulkResetMode) => void;
}) {
  const { mode } = option;
  const handleClick = useCallback(() => onSelect(mode), [mode, onSelect]);
  return (
    <Card
      render={<button type="button" aria-pressed={selected} disabled={disabled} />}
      onClick={handleClick}
      className={`w-full theme-brutal:border-2 p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
 selected
 ? option.selectedClass
 : "border-line-muted theme-brutal:border-black/30 bg-layer-panel theme-brutal:bg-white hover:border-line-strong theme-brutal:hover:border-black"
 }`}
    >
      <div className="text-sm font-bold uppercase">{option.label}</div>
      <p className="mt-1 text-xs text-foreground-muted theme-brutal:text-black/60">{option.desc}</p>
    </Card>
  );
}
