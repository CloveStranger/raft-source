import type { ReactNode } from "react";
import {
  SystemMessageGroup,
  SystemMessageGroupChevron,
  SystemMessageGroupDisclosure,
  SystemMessageGroupHeader,
  SystemMessageGroupPanel,
  SystemMessageGroupSummary,
} from "raft-ui";
import Tooltip from "../ui/Tooltip";

type SystemMessageGroupDisclosureWrapperProps = {
  summary: string;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
};

export default function ConnectedSystemMessageGroupDisclosure({
  summary,
  expanded,
  onToggle,
  children,
}: SystemMessageGroupDisclosureWrapperProps) {
  return (
    <SystemMessageGroup
      open={expanded}
      onOpenChange={onToggle}
      // The group layer carries no margins of its own (Josh's table): the
      // note rhythm owns both seams, and the inner rows re-assert their own
      // leads (elegant 4, brutal 6) against the per-theme single-note values.
      className="[&_[data-slot=system-message-item]]:pt-1 theme-brutal:[&_[data-slot=system-message-item]]:pt-1.5"
    >
      <SystemMessageGroupHeader>
        <Tooltip content={summary}>
          <SystemMessageGroupDisclosure
            data-testid="system-message-group-toggle"
            aria-expanded={expanded}
          >
            <SystemMessageGroupSummary>{summary}</SystemMessageGroupSummary>
            <SystemMessageGroupChevron />
          </SystemMessageGroupDisclosure>
        </Tooltip>
      </SystemMessageGroupHeader>
      <SystemMessageGroupPanel data-testid="system-message-group-details">
        {children}
      </SystemMessageGroupPanel>
    </SystemMessageGroup>
  );
}
