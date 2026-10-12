import { BellRing, Check, UserPlus, UserX } from "lucide-react";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import type { PendingMentionAction } from "../../store/messageStore";
import { Button } from "raft-ui";
import type { PendingMentionActionLocalState } from "./PendingMentionActionStrip";
import { PendingMentionTargetAvatar } from "./PendingMentionTargetAvatar";

function pendingMentionCanNotify(action: PendingMentionAction): boolean {
  return action.availableActions.some((available) => available === "notify" || available === "notify_only");
}

export function pendingMentionCanAdd(action: PendingMentionAction): boolean {
  return action.availableActions.some((available) => available === "add" || available === "invite");
}

export function pendingMentionTargetLabel(action: PendingMentionAction): string {
  const handle = action.targetHandle || action.targetType;
  if ((action.targetType === "user" || action.targetType === "agent") && handle && !handle.startsWith("@")) {
    return `@${handle}`;
  }
  return handle;
}

interface PendingMentionActionStripRowProps {
  action: PendingMentionAction;
  localState: PendingMentionActionLocalState | undefined;
  isRemoving: boolean;
  executingState: PendingMentionActionLocalState | undefined;
  channelLabel: string;
  onMarkAction: (resolutionId: string, state: PendingMentionActionLocalState) => void;
  onDismissAction: (resolutionId: string) => void;
}

export function PendingMentionActionStripRow({
  action,
  localState,
  isRemoving,
  executingState,
  channelLabel,
  onMarkAction,
  onDismissAction,
}: PendingMentionActionStripRowProps) {
  const { formatMessage } = useIntl();
  const targetLabel = pendingMentionTargetLabel(action);
  const canNotify = pendingMentionCanNotify(action) && !localState;
  const canAdd = pendingMentionCanAdd(action) && !localState;
  const statusCopy = localState === "added"
    ? formatMessage(
      { id: "message.pendingMention.addedStatus" },
      { target: targetLabel, channel: channelLabel },
    )
    : localState === "notified"
      ? formatMessage(
        { id: "message.pendingMention.queuedStatus" },
        { target: targetLabel, channel: channelLabel },
      )
      : formatMessage(
        { id: "message.pendingMention.notNotified" },
        { target: targetLabel, channel: channelLabel },
      );

  const handleMarkAdded = useCallback(() => {
    onMarkAction(action.resolutionId, "added");
  }, [onMarkAction, action.resolutionId]);
  const handleMarkNotified = useCallback(() => {
    onMarkAction(action.resolutionId, "notified");
  }, [onMarkAction, action.resolutionId]);
  const handleDismiss = useCallback(() => {
    onDismissAction(action.resolutionId);
  }, [onDismissAction, action.resolutionId]);

  return (
    <div
      className={`flex min-w-0 flex-col items-stretch gap-2 transition-opacity duration-300 sm:flex-row sm:flex-wrap sm:items-center ${isRemoving ? "opacity-0" : "opacity-100"}`}
    >
      <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:flex-1">
        <UserX size={14} className="shrink-0 text-foreground-hint" />
        <div className="relative h-5 w-5 shrink-0" aria-hidden="true">
          <PendingMentionTargetAvatar action={action} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-bold text-foreground-strong">{targetLabel}</div>
          <div
            className="line-clamp-2 text-[11px] leading-4 text-foreground-muted sm:line-clamp-none sm:truncate"
            data-testid="pending-mention-action-status"
          >
            {statusCopy}
          </div>
        </div>
      </div>
      <div
        className="flex w-full shrink-0 items-center justify-end gap-1.5 sm:ml-auto sm:w-auto"
        data-testid="pending-mention-action-buttons"
      >
        {localState === "added" ? (
          <span className="inline-flex items-center gap-1 rounded-md border border-line-hairline bg-fill-muted px-2 py-0.5 text-[12px] font-bold text-foreground-hint cursor-default theme-brutal:rounded-none theme-brutal:border-2 theme-brutal:border-black/20 theme-brutal:bg-black/[0.04] theme-brutal:text-black/40">
            <Check size={12} strokeWidth={3} />
            {formatMessage({ id: "message.pendingMention.added" })}
          </span>
        ) : canAdd ? (
          <Button
            type="button"
            variant="accent"
            size="sm"
            disabled={Boolean(executingState)}
            onClick={handleMarkAdded}
          >
            <UserPlus size={12} />
            {formatMessage({ id: "message.pendingMention.add" })}
          </Button>
        ) : null}
        {localState === "notified" ? (
          <span className="inline-flex items-center gap-1 rounded-md border border-line-hairline bg-fill-muted px-2 py-0.5 text-[12px] font-bold text-foreground-hint cursor-default theme-brutal:rounded-none theme-brutal:border-2 theme-brutal:border-black/20 theme-brutal:bg-black/[0.04] theme-brutal:text-black/40">
            <Check size={12} strokeWidth={3} />
            {formatMessage({ id: "message.pendingMention.queued" })}
          </span>
        ) : canNotify ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={Boolean(executingState)}
            onClick={handleMarkNotified}
          >
            <BellRing size={12} />
            {formatMessage({ id: "message.pendingMention.notify" })}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="muted"
          size="sm"
          onClick={handleDismiss}
        >
          {formatMessage({ id: "message.pendingMention.dismiss" })}
        </Button>
      </div>
    </div>
  );
}
