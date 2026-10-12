import { useCallback } from "react";
import type { KeyboardEvent } from "react";
import { SegmentedControlCount, SegmentedControlItem, SegmentedControlLabel } from "raft-ui";

import { TOOL_LABEL } from "./handoffSessions";
import type { LocalSession } from "./handoffSessions";

export function HandoffToolTab({ tool, count, onChoose }: {
  tool: LocalSession["tool"];
  count: number;
  onChoose: (tool: LocalSession["tool"]) => void;
}) {
  const choose = useCallback(() => onChoose(tool), [onChoose, tool]);
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") onChoose(tool);
  }, [onChoose, tool]);

  return (
    <SegmentedControlItem
      value={tool}
      data-testid={`handoff-tool-tab-${tool}`}
      // Explicit activation must stick even when the item is ALREADY the
      // value (RadioGroup fires no onValueChange then): record mouse and
      // keyboard activation of the current item too (review of #8205).
      onClick={choose}
      onKeyDown={handleKeyDown}
    >
      <SegmentedControlLabel>{TOOL_LABEL[tool]}</SegmentedControlLabel>
      <SegmentedControlCount>{count}</SegmentedControlCount>
    </SegmentedControlItem>
  );
}
