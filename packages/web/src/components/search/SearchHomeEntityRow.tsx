import { useCallback } from "react";
import { useIntl } from "react-intl";
import { Monitor } from "lucide-react";
import {
  SearchEntityResult,
  SearchEntityResultContent,
  SearchEntityResultDescription,
  SearchEntityResultHeader,
  SearchEntityResultIcon,
  SearchEntityResultLeading,
  SearchEntityResultTitle,
} from "raft-ui";
import AgentActivityDot from "../agent/AgentActivityDot";
import AvatarSlot from "../ui/AvatarSlot";
import { ChannelKindIcon } from "../channel/channelKindIcon";
import type { SearchEntityResult as SearchEntityRecord } from "./searchEntities";
import { formatEntitySubtitle } from "./MessageSearchPage";
import type { SearchSenderMember } from "./MessageSearchPage";

/** A "frequent" destination tile on the search home. */
export function SearchHomeEntityRow({
  result,
  agentAvatarUrl,
  humanMember,
  onActivate,
}: {
  result: SearchEntityRecord;
  agentAvatarUrl: string | null;
  humanMember: SearchSenderMember | undefined;
  onActivate: (result: SearchEntityRecord) => void;
}) {
  const { formatMessage } = useIntl();
  const handleClick = useCallback(() => onActivate(result), [onActivate, result]);

  return (
    <SearchEntityResult
      type="button"
      data-testid={`search-common-${result.key}`}
      onClick={handleClick}
    >
      <SearchEntityResultLeading>
        {result.type === "channel" ? (
          <SearchEntityResultIcon>
            <ChannelKindIcon type={result.channelType ?? "channel"} />
          </SearchEntityResultIcon>
        ) : result.type === "computer" ? (
          <SearchEntityResultIcon>
            <Monitor size={14} />
          </SearchEntityResultIcon>
        ) : result.type === "agentDm" ? (
          <AvatarSlot
            context="surface-list"
            type="agent"
            agentAvatarUrl={agentAvatarUrl}
            badge={result.agentId ? <AgentActivityDot agentId={result.agentId} /> : undefined}
          />
        ) : (
          <AvatarSlot
            context="surface-list"
            type="human"
            humanAvatarUrl={humanMember?.avatarUrl}
            gravatarHash={humanMember?.gravatarHash}
          />
        )}
      </SearchEntityResultLeading>
      <SearchEntityResultContent>
        <SearchEntityResultHeader>
          <SearchEntityResultTitle>{result.title}</SearchEntityResultTitle>
        </SearchEntityResultHeader>
        <SearchEntityResultDescription>
          {formatEntitySubtitle(result.subtitle, formatMessage)}
        </SearchEntityResultDescription>
      </SearchEntityResultContent>
    </SearchEntityResult>
  );
}
