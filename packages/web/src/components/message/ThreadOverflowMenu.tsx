import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import {
  EllipsisVertical,
  Maximize2,
  Minimize2,
  MapPin,
  MessageCircleOff,
  MessageCirclePlus,
  Search,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger, Button
} from "raft-ui";
import { useThreadStore } from "../../store/threadStore";
import Tooltip from "../ui/Tooltip";

/**
 * Thread topbar vertical-ellipsis action menu.
 *
 * A Thread only has a few immediate commands, so a full settings drawer is
 * too heavy. Raft UI's DropdownMenu supplies the correct command-menu
 * semantics (focus management, arrow-key navigation, Escape and outside
 * dismissal); PopSelect would incorrectly imply a selected value. Structural
 * Back / Close stay in the header. The baseline ThreadPanel had no unread
 * action, so this menu must not invent one. Rows whose identity anchor is
 * missing are omitted.
 */
export interface ThreadOverflowMenuProps {
  /** The thread's own channel id — anchors unfollow. */
  threadChannelId: string | null;
  /** Parent message id — anchors follow/unfollow. */
  parentMessageId: string | null;
  viewInChannelLabel: string;
  onViewInChannel: () => void;
  onSearch: () => void;
  restoreChannelLabel?: string;
  hideChannelLabel?: string;
  canToggleChannel?: () => boolean;
  channelCollapsed?: boolean;
  onToggleChannel?: () => void;
}

export default function ThreadOverflowMenu({
  threadChannelId,
  parentMessageId,
  viewInChannelLabel,
  onViewInChannel,
  onSearch,
  restoreChannelLabel,
  hideChannelLabel,
  canToggleChannel,
  channelCollapsed = false,
  onToggleChannel,
}: ThreadOverflowMenuProps) {
  const { formatMessage } = useIntl();
  const [splitAvailable, setSplitAvailable] = useState(true);
  const [followBusy, setFollowBusy] = useState(false);
  const followed = useThreadStore((state) =>
    parentMessageId
      ? state.followedThreads.some((thread) => thread.parentMessageId === parentMessageId)
      : false);
  const followThread = useThreadStore((state) => state.followThread);
  const unfollowThread = useThreadStore((state) => state.unfollowThread);

  const handleFollowAction = useCallback(() => {
    if (followBusy) return;
    const action = followed
      ? threadChannelId ? unfollowThread(threadChannelId) : null
      : parentMessageId ? followThread(parentMessageId) : null;
    if (!action) return;

    // Follow/Unfollow are one-shot commands, matching the message context
    // menu. They are intentionally not modelled as a preference Switch.
    setFollowBusy(true);
    void action.catch(() => {}).finally(() => setFollowBusy(false));
  }, [followBusy, followed, threadChannelId, parentMessageId, unfollowThread, followThread]);
  const handleOpenChange = useCallback((open: boolean) => {
    if (open) setSplitAvailable(canToggleChannel?.() ?? true);
  }, [canToggleChannel]);
  return (
    <DropdownMenu onOpenChange={handleOpenChange}>
      <Tooltip content={formatMessage({ id: "message.threadPanel.overflow.open" })}>
        <DropdownMenuTrigger
          render={(
            <Button
              size="icon-sm"
              variant="outline"
              aria-label={formatMessage({ id: "message.threadPanel.overflow.open" })}
              data-testid="thread-overflow-trigger"
            >
              <EllipsisVertical size={14} />
            </Button>
          )}
        />
      </Tooltip>
      <DropdownMenuContent
        side="bottom"
        align="end"
        sideOffset={4}
        aria-label={formatMessage({ id: "message.threadPanel.overflow.open" })}
        data-testid="thread-overflow-menu"
      >
        {onToggleChannel && splitAvailable && (
          <DropdownMenuItem onClick={onToggleChannel} data-testid="thread-overflow-maximize">
            {channelCollapsed ? <Minimize2 /> : <Maximize2 />}
            {channelCollapsed ? restoreChannelLabel ?? formatMessage({ id: "message.threadPanel.overflow.showChannel" }) : hideChannelLabel ?? formatMessage({ id: "message.threadPanel.overflow.hideChannel" })}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={onSearch} data-testid="thread-overflow-search">
          <Search />
          {formatMessage({ id: "message.threadPanel.searchInThread" })}
        </DropdownMenuItem>
        {parentMessageId && (
          <DropdownMenuItem
            onClick={onViewInChannel}
            data-testid="thread-overflow-view-in-channel"
          >
            <MapPin />
            {viewInChannelLabel}
          </DropdownMenuItem>
        )}
        {parentMessageId && (
          <DropdownMenuItem
            onClick={handleFollowAction}
            disabled={followBusy || (followed && !threadChannelId)}
            data-testid="thread-overflow-follow-action"
          >
            {followed ? <MessageCircleOff /> : <MessageCirclePlus />}
            {formatMessage({
              id: followed
                ? "message.messageItem.unfollowThread"
                : "message.messageItem.followThread",
            })}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
