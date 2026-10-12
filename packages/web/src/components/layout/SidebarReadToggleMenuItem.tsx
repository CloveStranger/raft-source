import { useCallback } from "react";
import { useIntl } from "react-intl";
import { MessageSquareCheck, MessageSquareDot } from "lucide-react";
import { useMessageStore } from "../../store/messageStore";
import MenuItem from "../ui/MenuItem";

export function SidebarReadToggleMenuItem({
  channelId,
  hasUnread,
  onDone,
}: {
  channelId: string;
  hasUnread: boolean;
  onDone: () => void;
}) {
  const { formatMessage } = useIntl();
  const markRead = useMessageStore((s) => s.markRead);
  const markUnread = useMessageStore((s) => s.markUnread);
  const toggleRead = useCallback(() => {
    onDone();
    const action = hasUnread ? markRead(channelId) : markUnread(channelId);
    void action.catch(() => {
      void useMessageStore.getState().loadUnreadCounts();
    });
  }, [channelId, hasUnread, markRead, markUnread, onDone]);
  return (
    <MenuItem
      icon={hasUnread ? <MessageSquareCheck size={14} /> : <MessageSquareDot size={14} />}
      onClick={toggleRead}
    >
      {hasUnread
        ? formatMessage({ id: "layout.sidebar.markAsRead" })
        : formatMessage({ id: "layout.sidebar.markAsUnread" })}
    </MenuItem>
  );
}
