import type { PendingMentionAction } from "../../store/messageStore";
import AvatarSlot from "../ui/AvatarSlot";
import { AgentAvatar } from "../agent/PixelAvatar";
import { pendingMentionTargetLabel } from "./PendingMentionActionStripRow";

function pendingMentionTargetInitial(action: PendingMentionAction): string {
  const label = pendingMentionTargetLabel(action).replace(/^@/, "").trim();
  return (label[0] || "?").toUpperCase();
}

export function PendingMentionTargetAvatar({ action }: { action: PendingMentionAction }) {
  if ((action.targetType === "agent" || action.targetType === "user") && action.targetAvatarUrl) {
    return (
      <span data-testid="pending-mention-target-avatar">
        <AvatarSlot
          context="compact-list"
          type={action.targetType === "agent" ? "agent" : "human"}
          agentAvatarUrl={action.targetAvatarUrl}
          humanAvatarUrl={action.targetAvatarUrl}
        >
          <AgentAvatar avatarUrl={action.targetAvatarUrl} size={18} className="!h-full !w-full" />
        </AvatarSlot>
      </span>
    );
  }

  return (
    <span
      className="absolute left-0 top-0"
      data-testid="pending-mention-target-initial"
    >
      <AvatarSlot context="compact-list" type="app" appInitials={pendingMentionTargetInitial(action)} />
    </span>
  );
}
