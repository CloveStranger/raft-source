import { memo, useCallback } from "react";
import { useIntl } from "react-intl";
import { SidebarItem } from "raft-ui";
import type { ServerMember } from "../../store/serverStore";
import Tooltip from "../ui/Tooltip";
import AvatarSlot from "../ui/AvatarSlot";
import { sidebarItemClass } from "./Sidebar";
import type { SidebarCtxKind, SidebarLongPress } from "./Sidebar";

// Members-tab human row; same stable-callback contract as <MemberAgentRow>.
// Stryker disable all: member-row interaction glue is browser-smoke verified.
export const MemberHumanRow = memo(function MemberHumanRow({
  human,
  isSelf,
  selected,
  menuOpen,
  onSelect,
  onOpenDm,
  onContextMenu,
  makeLongPress,
}: {
  human: ServerMember;
  isSelf: boolean;
  selected: boolean;
  menuOpen: boolean;
  onSelect: (userId: string, clickCount: number) => void;
  onOpenDm: (userId: string) => Promise<void>;
  onContextMenu: (e: React.MouseEvent, type: SidebarCtxKind, id: string) => void;
  makeLongPress: (type: SidebarCtxKind, id: string) => SidebarLongPress;
}) {
  const { formatMessage } = useIntl();
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => onSelect(human.userId, event.detail),
    [human.userId, onSelect],
  );
  const handleDoubleClick = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void onOpenDm(human.userId);
  }, [human.userId, onOpenDm]);
  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => onContextMenu(event, "member-human", human.userId),
    [human.userId, onContextMenu],
  );
  return (
    <Tooltip content={isSelf ? formatMessage({ id: "layout.sidebar.youTitle" }) : `${human.displayName || human.name}`}>
    <SidebarItem variant="accent"
      type="button"
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      data-slot="sidebar-item"
      active={selected}
      {...makeLongPress("member-human", human.userId)}
      className={sidebarItemClass(selected, menuOpen)}
    >
      <AvatarSlot context="sidebar-list" type="human" humanAvatarUrl={human.avatarUrl} gravatarHash={human.gravatarHash} />
      <div className="flex min-w-0 flex-1 items-baseline gap-1 text-left">
        <span className="min-w-0 truncate text-sm">
          {human.displayName || human.name}
          {isSelf && <span className="text-foreground-placeholder ml-1 theme-brutal:text-black/40">{formatMessage({ id: "layout.sidebar.youSuffix" })}</span>}
        </span>
        {/* Only Guest is labeled: it is the rare role whose access differs. Same chip as ChannelMemberList. */}
        {human.role === "guest" && (
          <span className="shrink-0 self-center rounded-sm border border-line-muted bg-info-soft px-1.5 py-0.5 font-mono text-[10px] leading-3 text-foreground-strong theme-brutal:rounded-none theme-brutal:border-[1.5px] theme-brutal:border-black theme-brutal:bg-brutal-cyan theme-brutal:text-black">
            {formatMessage({ id: "layout.sidebar.guestLabel" })}
          </span>
        )}
        {human.description && (
          <span className="min-w-0 flex-1 truncate text-xs text-foreground-muted theme-brutal:text-black/40">{human.description}</span>
        )}
      </div>
    </SidebarItem>
    </Tooltip>
  );
});
// Stryker restore all
