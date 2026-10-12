import { useCallback } from "react";
import type { ReactNode } from "react";
import { Button } from "raft-ui";

export function AppEventFilterButton({
  clientId,
  active,
  onSelect,
  children,
}: {
  clientId: string | null;
  active: boolean;
  onSelect: (clientId: string | null) => void;
  children: ReactNode;
}) {
  const handleClick = useCallback(() => onSelect(clientId), [onSelect, clientId]);
  return (
    <Button size="sm" variant={active ? "default" : "outline"} onClick={handleClick} className="text-[11px]">
      {children}
    </Button>
  );
}
