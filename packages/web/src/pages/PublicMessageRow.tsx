import type { Channel } from "../store/channelStore";
import MessageItem from "../components/message/MessageItem";
import type { MentionEntry, ReadOnlySenderProjection } from "../components/message/MessageItem";
import type { Message } from "../store/messageStore";
import type { OpenThreadRequest } from "../store/threadStore";
import { useMemo } from "react";
import type { PublicMessage } from "./PublicServerPage";

const EMPTY_PUBLIC_MENTION_MAP = new Map<string, MentionEntry>();

export function PublicMessageRow({
  message,
  adaptedMessage,
  channels,
  parentChannelId,
  sender,
  onNavigateChannel,
  onOpenThread,
}: {
  message: PublicMessage;
  adaptedMessage: Message;
  channels: Channel[];
  parentChannelId: string;
  sender: ReadOnlySenderProjection | undefined;
  onNavigateChannel: (channel: Channel) => void;
  onOpenThread: (request: OpenThreadRequest) => void;
}) {
  const { threadId, replyCount } = message;
  const threadSummary = useMemo(() => (threadId && replyCount > 0 ? {
    threadChannelId: threadId,
    replyCount,
    lastReplyAt: null,
    participantIds: [],
    unreadCount: 0,
    firstUnreadMessageId: null,
  } : undefined), [replyCount, threadId]);
  return (
    <div className="px-3" data-testid="public-server-message-row">
      <MessageItem
        message={adaptedMessage}
        mentionMap={EMPTY_PUBLIC_MENTION_MAP}
        channels={channels}
        parentChannelId={parentChannelId}
        threadSummary={threadSummary}
        canReact={false}
        readOnlyProjection
        readOnlySender={sender}
        onReadOnlyNavigateChannel={onNavigateChannel}
        onOpenThread={onOpenThread}
      />
    </div>
  );
}
