import { useCallback } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useIntl } from "react-intl";
import { Monitor } from "lucide-react";
import {
  Badge,
  Kbd,
  SearchEntityResult,
  SearchEntityResultContent,
  SearchEntityResultDescription,
  SearchEntityResultHeader,
  SearchEntityResultIcon,
  SearchEntityResultLeading,
} from "raft-ui";
import AgentActivityDot from "../agent/AgentActivityDot";
import AvatarSlot from "../ui/AvatarSlot";
import {
  ARCHIVED_CHANNEL_ICON_CLASS,
  ARCHIVED_CHANNEL_MUTED_TEXT_CLASS,
  ARCHIVED_CHANNEL_TEXT_CLASS,
} from "../channel/channelArchiveVisual";
import { ChannelKindIcon } from "../channel/channelKindIcon";
import type { SearchEntityResult as SearchEntityRecord } from "./searchEntities";
import { formatEntitySubtitle, RETURN_KEY_GLYPH } from "./MessageSearchPage";
import type { SearchSenderMember } from "./MessageSearchPage";

/**
 * Destination (entity) row — shared by the overlay's exact-match head row and
 * the destinations section (task #102), so both render identically.
 */
export function EntityResultRow({
  result,
  returnHint,
  selected,
  agentAvatarUrl,
  humanMember,
  onResultContextMenu,
  onResultClick,
}: {
  result: SearchEntityRecord;
  returnHint: boolean;
  selected: boolean;
  agentAvatarUrl: string | null;
  humanMember: SearchSenderMember | undefined;
  onResultContextMenu: (event: ReactMouseEvent, result: SearchEntityRecord) => void;
  onResultClick: (event: ReactMouseEvent<HTMLButtonElement>, result: SearchEntityRecord) => void;
}) {
  const { formatMessage } = useIntl();
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) => onResultContextMenu(event, result),
    [onResultContextMenu, result],
  );
  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => onResultClick(event, result),
    [onResultClick, result],
  );
  const channelPinnedRef = result.type === "channel" && result.channelId
    ? { kind: "channel", id: result.channelId } as const
    : null;
  const isArchivedChannelResult = result.type === "channel" && !!result.archivedAt;

  // The card frame, hover and selected states belong to rui's
  // SearchEntityResult. A second square frame on this wrapper showed its dark
  // corners around rui's rounded selection ring (task #694).
  return (
    <div
      data-testid={channelPinnedRef ? `search-channel-result-${channelPinnedRef.id}` : undefined}
      data-active={selected ? "true" : undefined}
      onContextMenu={channelPinnedRef && !result.archivedAt ? handleContextMenu : undefined}
      className="flex w-full"
    >
      <SearchEntityResult
        type="button"
        onClick={handleClick}
        selected={selected}
        className="theme-brutal:hover:shadow-brutal-sm theme-brutal:active:shadow-brutal-sm theme-brutal:data-[selected=true]:shadow-brutal-sm"
      >
        <SearchEntityResultLeading>
          {result.type === "channel" ? (
            <SearchEntityResultIcon
              className={isArchivedChannelResult ? ARCHIVED_CHANNEL_ICON_CLASS : undefined}
            >
              <ChannelKindIcon type={result.channelType ?? "channel"} />
            </SearchEntityResultIcon>
          ) : result.type === "computer" ? (
            <SearchEntityResultIcon>
              <Monitor size={14} />
            </SearchEntityResultIcon>
          ) : result.type === "agentDm" ? (
            result.agentId ? (
              <AvatarSlot
                context="surface-list"
                type="agent"
                agentAvatarUrl={agentAvatarUrl}
                badge={<AgentActivityDot agentId={result.agentId} />}
              />
            ) : (
              <AvatarSlot context="surface-list" type="agent" agentAvatarUrl={null} />
            )
          ) : result.userId ? (
            <AvatarSlot
              context="surface-list"
              type="human"
              humanAvatarUrl={humanMember?.avatarUrl}
              gravatarHash={humanMember?.gravatarHash}
            />
          ) : (
            <AvatarSlot context="surface-list" type="human" humanPlaceholder />
          )}
        </SearchEntityResultLeading>
        <SearchEntityResultContent>
          <SearchEntityResultHeader>
            <span className={`truncate text-sm font-bold ${isArchivedChannelResult ? ARCHIVED_CHANNEL_TEXT_CLASS : "text-foreground-strong"}`}>
              {result.title}
            </span>
            <Badge appearance="soft" variant="muted" uppercase>
              {result.type === "channel" ? formatMessage({ id: "search.channel" }) : result.type === "computer" ? formatMessage({ id: "search.badgeComputer" }) : result.type === "agentDm" ? formatMessage({ id: "search.badgeAgent" }) : formatMessage({ id: "search.badgeHuman" })}
            </Badge>
            {result.archivedAt && (
              <Badge appearance="soft" variant={isArchivedChannelResult ? "muted" : "warning"} uppercase>
                {formatMessage({ id: "search.archived" })}
              </Badge>
            )}
          </SearchEntityResultHeader>
          <SearchEntityResultDescription className={isArchivedChannelResult ? ARCHIVED_CHANNEL_MUTED_TEXT_CLASS : undefined}>
            {formatEntitySubtitle(result.subtitle, formatMessage)}
          </SearchEntityResultDescription>
        </SearchEntityResultContent>
        {returnHint && selected ? <Kbd aria-hidden="true">{RETURN_KEY_GLYPH}</Kbd> : null}
      </SearchEntityResult>
    </div>
  );
}
