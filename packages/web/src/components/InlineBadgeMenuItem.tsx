import { useCallback } from "react";
import { Check } from "lucide-react";

import MenuItem from "./ui/MenuItem";
import type { InlineBadgeOption } from "./InlineBadgeEditor";

export function InlineBadgeMenuItem({
  option,
  selected,
  onSelect,
  testId,
}: {
  option: InlineBadgeOption;
  selected: boolean;
  onSelect: (id: string) => Promise<void> | void;
  testId?: string;
}) {
  const handleClick = useCallback(async () => {
    await onSelect(option.id);
  }, [onSelect, option.id]);

  return (
    <MenuItem
      role="button"
      onClick={handleClick}
      data-testid={testId}
      icon={option.avatar}
      trailing={<Check size={14} className={`shrink-0 ${selected ? "opacity-100" : "opacity-0"}`} />}
    >
      {option.label}
    </MenuItem>
  );
}
