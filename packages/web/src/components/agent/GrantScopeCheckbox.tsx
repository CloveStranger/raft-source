import { useCallback } from "react";
import { Checkbox } from "raft-ui";

export function GrantScopeCheckbox({
  scope,
  checked,
  onToggle,
}: {
  scope: string;
  checked: boolean;
  onToggle: (scope: string, checked: boolean) => void;
}) {
  const handleCheckedChange = useCallback((next: boolean) => onToggle(scope, next), [onToggle, scope]);
  return (
    <label className="flex items-center gap-2 font-mono text-xs text-foreground-strong">
      <Checkbox size="sm" checked={checked} onCheckedChange={handleCheckedChange} />
      {scope}
    </label>
  );
}
