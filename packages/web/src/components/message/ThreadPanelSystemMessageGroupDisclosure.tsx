import { useCallback } from "react";
import type { ReactNode } from "react";
import SystemMessageGroupDisclosure from "./SystemMessageGroupDisclosure";

type ThreadPanelSystemMessageGroupDisclosureProps = {
  groupId: string;
  summary: string;
  expanded: boolean;
  onToggleGroup: (groupId: string) => void;
  children: ReactNode;
};

/**
 * Per-group wrapper so the toggle closure is memoized per group id — the
 * parent renders groups inside a renderItem callback and cannot hold hooks.
 */
export default function ThreadPanelSystemMessageGroupDisclosure({
  groupId,
  summary,
  expanded,
  onToggleGroup,
  children,
}: ThreadPanelSystemMessageGroupDisclosureProps) {
  const handleToggle = useCallback(() => onToggleGroup(groupId), [groupId, onToggleGroup]);
  return (
    <SystemMessageGroupDisclosure
      summary={summary}
      expanded={expanded}
      onToggle={handleToggle}
    >
      {children}
    </SystemMessageGroupDisclosure>
  );
}
