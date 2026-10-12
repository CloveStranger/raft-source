import ConversationPreviewCard from "../ui/cards/ConversationPreviewCard";
import { formatRelativeTimeParts } from "../../utils/relativeTime";
import { getSearchRelativeTimeParts } from "../search/searchGrouping";
import { useIntl } from "react-intl";
import { useMemo } from "react";
import type { AgentDMConversation } from "./AgentDMConversationList";

export function AgentDMConversationCard({ item }: { item: AgentDMConversation }) {
  const { formatMessage, locale } = useIntl();
  const formatRelative = (value: string) => {
    // Relative time follows the app display language, not the browser system
    // locale (shared searchGrouping helper now returns a locale-agnostic
    // descriptor). Other copy in this component is migrated separately.
    const parts = getSearchRelativeTimeParts(value);
    return parts ? formatRelativeTimeParts(parts.value, parts.unit, locale) : "";
  };
  const author = useMemo(
    () => ({
      name: item.peerDisplayName || item.peerName,
      kind: "agent" as const,
      avatarUrl: item.peerAvatarUrl || null,
      subtitle: `@${item.peerName}`,
    }),
    [item.peerDisplayName, item.peerName, item.peerAvatarUrl],
  );
  return (
    <ConversationPreviewCard
      channelLabel={formatMessage({ id: "agent.dmConversation.channelLabel" })}
      timestamp={formatRelative(item.lastMessageAt || item.createdAt)}
      author={author}
      preview={item.lastMessagePreview || formatMessage({ id: "agent.dmConversation.noMessages" })}
      ariaLabel={formatMessage(
        { id: "agent.dmConversation.rowAria" },
        { name: item.peerDisplayName || item.peerName },
      )}
      title={formatMessage({ id: "agent.dmConversation.activityTitle" })}
      footer={<span className="text-[11px] font-mono uppercase tracking-wide text-black/45">{formatMessage({ id: "agent.dmConversation.activityOnly" })}</span>}
    />
  );
}
