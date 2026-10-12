import { UserPlus } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import type { PendingMentionAction } from "../../store/messageStore";
import { Button } from "raft-ui";
import { PendingMentionActionStripRow, pendingMentionCanAdd } from "./PendingMentionActionStripRow";

export type PendingMentionActionLocalState = "notified" | "added";

interface PendingMentionActionStripProps {
  actions: PendingMentionAction[];
  actionState: Record<string, PendingMentionActionLocalState>;
  actionRemoving: Record<string, boolean>;
  actionExecuting: Record<string, PendingMentionActionLocalState>;
  channelName: string;
  onMarkAction: (resolutionId: string, state: PendingMentionActionLocalState) => void;
  onAddAllActions: (resolutionIds: string[]) => void;
  onDismissAction: (resolutionId: string) => void;
}

function channelMentionLabel(channelName: string): string {
  return channelName.startsWith("#") ? channelName : `#${channelName}`;
}

export function PendingMentionActionStrip({
  actions,
  actionState,
  actionRemoving,
  actionExecuting,
  channelName,
  onMarkAction,
  onAddAllActions,
  onDismissAction,
}: PendingMentionActionStripProps) {
  const { formatMessage } = useIntl();
  const addableResolutionIds = useMemo(() => actions
    .filter((action) => (
      pendingMentionCanAdd(action)
      && !actionState[action.resolutionId]
      && !actionRemoving[action.resolutionId]
    ))
    .map((action) => action.resolutionId), [actions, actionState, actionRemoving]);
  const showAddAll = addableResolutionIds.length > 1;
  const isAddingAll = addableResolutionIds.some((resolutionId) => Boolean(actionExecuting[resolutionId]));
  const channelLabel = channelMentionLabel(channelName);
  const handleAddAllActions = useCallback(() => {
    onAddAllActions(addableResolutionIds);
  }, [onAddAllActions, addableResolutionIds]);

  return (
    <div
      className="mb-2 w-full rounded-lg border border-line-muted bg-layer-panel px-3 py-2 shadow-raft-xs theme-brutal:rounded-none theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-brutal-cream theme-brutal:shadow-brutal-sm"
      data-testid="pending-mention-action-strip"
    >
      <div className="flex flex-col gap-2" data-testid="pending-mention-action-rows">
        {actions.map((action) => (
          <PendingMentionActionStripRow
            key={action.resolutionId}
            action={action}
            localState={actionState[action.resolutionId]}
            isRemoving={Boolean(actionRemoving[action.resolutionId])}
            executingState={actionExecuting[action.resolutionId]}
            channelLabel={channelLabel}
            onMarkAction={onMarkAction}
            onDismissAction={onDismissAction}
          />
        ))}
      </div>
      {showAddAll && (
        <div
          className="mt-2 flex justify-end border-t border-line-hairline pt-2"
          data-testid="pending-mention-action-footer"
        >
          <Button
            type="button"
            variant="accent"
            size="sm"
            disabled={isAddingAll}
            onClick={handleAddAllActions}
          >
            <UserPlus size={12} />
            {formatMessage({ id: "message.pendingMention.addAll" })}
          </Button>
        </div>
      )}
    </div>
  );
}
