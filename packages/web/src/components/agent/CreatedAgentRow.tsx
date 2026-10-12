import { useCallback } from "react";
import { useIntl } from "react-intl";
import type { Agent } from "../../store/agentStore";
import { formatRuntimeLabelWithStatus } from "../../utils/runtimeAvailabilityLabel";
import AvatarListRow from "../ui/AvatarListRow";
import AvatarSlot from "../ui/AvatarSlot";
import { CreatedAgentStatusDot } from "./CreatedAgentStatusDot";

export function CreatedAgentRow({
  createdAgent,
  onOpenProfile,
}: {
  createdAgent: NonNullable<Agent["createdAgents"]>[number];
  onOpenProfile: (type: "agent" | "human", id: string) => void;
}) {
  const { formatMessage } = useIntl();
  const createdAgentId = createdAgent.id;
  const handleClick = useCallback(() => onOpenProfile("agent", createdAgentId), [onOpenProfile, createdAgentId]);
  return (
    <AvatarListRow
      avatar={<AvatarSlot context="surface-list" type="agent" agentAvatarUrl={createdAgent.avatarUrl} />}
      name={createdAgent.displayName || createdAgent.name}
      subtitle={formatRuntimeLabelWithStatus(createdAgent.runtime, formatMessage)}
      rightContent={<CreatedAgentStatusDot agentId={createdAgent.id} />}
      onClick={handleClick}
    />
  );
}
