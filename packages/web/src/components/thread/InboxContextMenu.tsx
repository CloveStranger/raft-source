import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import { Bell, BellOff, Check, MessageSquareCheck, MessageSquareDot } from "lucide-react";
import { ContextMenuPopup } from "raft-ui";
import { useInboxStore } from "../../store/inboxStore";
import type { InboxItem } from "../../store/inboxStore";
import { useThreadStore } from "../../store/threadStore";
import api from "../../api/client";
import MenuItem from "../ui/MenuItem";
import type { InboxContextMenuPosition } from "./inboxContextMenuPosition";

function itemChannelId(item: InboxItem): string {
  if (item.kind === "mention_action") return item.channelId;
  return item.kind === "thread" ? item.threadChannelId : item.channelId;
}

export function InboxContextMenu({ ctxMenu, onClose }: { ctxMenu: InboxContextMenuPosition; onClose: () => void }) {
  const { formatMessage } = useIntl();
  const markRead = useInboxStore((s) => s.markRead);
  const markDone = useInboxStore((s) => s.markDone);
  const refreshInbox = useInboxStore((s) => s.refreshInbox);
  const markThreadUnfollowed = useInboxStore((s) => s.markThreadUnfollowed);
  const markThreadRefollowed = useInboxStore((s) => s.markThreadRefollowed);
  const followThread = useThreadStore((s) => s.followThread);
  const unfollowThread = useThreadStore((s) => s.unfollowThread);
  const item = ctxMenu.item;

  const style = useMemo(() => ({
    left: ctxMenu.x,
    top: ctxMenu.y,
    width: 184,
    maxWidth: ctxMenu.maxWidth,
    maxHeight: ctxMenu.maxHeight,
  }), [ctxMenu.x, ctxMenu.y, ctxMenu.maxWidth, ctxMenu.maxHeight]);

  const handleToggleRead = useCallback(async () => {
    const channelId = itemChannelId(item);
    if (item.unreadCount > 0) {
      await markRead(item);
    } else {
      await api.post(`/channels/${channelId}/unread`).catch(() => {});
    }
    await refreshInbox();
    onClose();
  }, [item, markRead, onClose, refreshInbox]);

  const handleDone = useCallback(() => {
    void markDone(item);
    onClose();
  }, [item, markDone, onClose]);

  const handleUnfollow = useCallback(async () => {
    onClose();
    if (item.kind === "thread") {
      try {
        await unfollowThread(item.threadChannelId);
        // Unfollow changes future delivery, not Activity history. Keep
        // this exact row and expose its new follow state.
        markThreadUnfollowed(item);
      } catch {
        // Persistence failed; preserve the canonical followed row and
        // reconcile any unrelated concurrent Activity changes.
        await refreshInbox();
      }
    }
  }, [item, markThreadUnfollowed, onClose, refreshInbox, unfollowThread]);

  const handleFollow = useCallback(async () => {
    onClose();
    if (item.kind === "thread") {
      try {
        await followThread(item.parentMessageId);
        // Refollow preserves this exact row as an active followed
        // thread.
        markThreadRefollowed(item.threadChannelId);
      } catch {
        // Persistence failed; keep the unfollowed row and reconcile the
        // rest of Activity without fabricating a successful refollow.
        await refreshInbox();
      }
    }
  }, [followThread, item, markThreadRefollowed, onClose, refreshInbox]);

  return (
    <ContextMenuPopup
      className="fixed z-[60] overflow-y-auto overflow-x-hidden select-none"
      style={style}
      data-testid="activity-context-menu"
    >
      {(ctxMenu.item.kind !== "thread" || ctxMenu.item.isFollowing !== false) && (
        <MenuItem
          icon={ctxMenu.item.unreadCount > 0 ? <MessageSquareCheck size={14} /> : <MessageSquareDot size={14} />}
          onClick={handleToggleRead}
        >
          {ctxMenu.item.unreadCount > 0 ? formatMessage({ id: "thread.contextMenu.markAsRead" }) : formatMessage({ id: "thread.contextMenu.markAsUnread" })}
        </MenuItem>
      )}
      <MenuItem
        icon={<Check size={14} />}
        onClick={handleDone}
      >
        {formatMessage({ id: "thread.contextMenu.done" })}
      </MenuItem>
      {ctxMenu.item.kind === "thread" && ctxMenu.item.isFollowing !== false && (
        <MenuItem
          icon={<BellOff size={14} />}
          onClick={handleUnfollow}
        >
          {formatMessage({ id: "thread.contextMenu.unfollow" })}
        </MenuItem>
      )}
      {ctxMenu.item.kind === "thread" && ctxMenu.item.isFollowing === false && (
        <MenuItem
          icon={<Bell size={14} />}
          onClick={handleFollow}
        >
          {formatMessage({ id: "thread.contextMenu.follow" })}
        </MenuItem>
      )}
    </ContextMenuPopup>
  );
}
