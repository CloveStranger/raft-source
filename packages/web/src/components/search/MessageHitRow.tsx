import { useCallback } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useIntl } from "react-intl";
import {
  Badge,
  SearchMessageResult,
  SearchMessageResultBody,
  SearchMessageResultHeader,
  SearchMessageResultMeta,
  SearchMessageResultSender,
  SearchMessageResultThreadMeta,
  SearchMessageResultTimestamp,
  SearchThreadMessageResult,
  ThreadIcon,
} from "raft-ui";
import { formatRelativeTimeParts } from "../../utils/relativeTime";
import AvatarSlot from "../ui/AvatarSlot";
import { getSearchRelativeTimeParts } from "./searchGrouping";
import { SearchHighlight } from "./MessageSearchPage";
import type { MessageSearchResult, SearchSenderMember } from "./MessageSearchPage";

/** One message hit, top-level or nested inside a thread group. */
export function MessageHitRow({
  result,
  nested,
  selected,
  sourceLabel,
  agentAvatarUrl,
  senderMember,
  historyCutoffMs,
  query,
  onResultClick,
}: {
  result: MessageSearchResult;
  nested: boolean;
  selected: boolean;
  sourceLabel: string;
  agentAvatarUrl: string | null;
  senderMember: SearchSenderMember | null;
  historyCutoffMs: number | null;
  query: string;
  onResultClick: (event: ReactMouseEvent<HTMLButtonElement>, result: MessageSearchResult) => void;
}) {
  const intl = useIntl();
  const { formatMessage } = intl;
  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => onResultClick(event, result),
    [onResultClick, result],
  );

  const Result = nested ? SearchThreadMessageResult : SearchMessageResult;

  return (
    <Result
      type="button"
      onClick={handleClick}
      selected={selected}
      className={nested ? "border-t-2" : undefined}
    >
    <SearchMessageResultHeader>
      <SearchMessageResultMeta>{sourceLabel}</SearchMessageResultMeta>
      {result.channelType === "thread" && (
        <SearchMessageResultThreadMeta>
          <ThreadIcon width={10} height={10} />
          {formatMessage({ id: "search.threadInline" })}
        </SearchMessageResultThreadMeta>
      )}
      {(result.channelType === "thread"
        ? result.parentChannelArchivedAt
        : result.channelArchivedAt) && (
        <Badge appearance="soft" variant="warning" uppercase>
          {formatMessage({ id: "search.archived" })}
        </Badge>
      )}
      {historyCutoffMs !== null && new Date(result.createdAt).getTime() < historyCutoffMs && (
        <Badge appearance="soft" variant="warning" data-testid="search-hit-beyond-history">
          {formatMessage({ id: "search.beyondHistory" })}
        </Badge>
      )}
      <SearchMessageResultSender>
        {result.senderType === "agent" ? (
          <AvatarSlot context="preview-mini" type="agent" agentAvatarUrl={agentAvatarUrl} />
        ) : result.senderType === "external_projection" ? (
          <AvatarSlot context="preview-mini" type="app" appAvatarUrl={result.senderAvatarUrl} appInitials={result.senderName} />
        ) : (
          <AvatarSlot context="preview-mini" type="human" humanAvatarUrl={senderMember?.avatarUrl} gravatarHash={senderMember?.gravatarHash} />
        )}
        <span>{result.senderName}</span>
      </SearchMessageResultSender>
      <SearchMessageResultTimestamp>{(() => {
        const parts = getSearchRelativeTimeParts(result.createdAt);
        return parts ? formatRelativeTimeParts(parts.value, parts.unit, intl.locale) : formatMessage({ id: "search.grpUnknownTime" });
      })()}</SearchMessageResultTimestamp>
    </SearchMessageResultHeader>
    <SearchMessageResultBody>
      <SearchHighlight text={result.snippet} query={query} />
    </SearchMessageResultBody>
    </Result>
  );
}
