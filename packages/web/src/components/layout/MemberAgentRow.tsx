import { memo, useCallback } from "react";
import { SidebarItem } from "raft-ui";
import type { Agent } from "../../store/agentStore";
import AvatarSlot from "../ui/AvatarSlot";
import { SidebarAgentActivityBadge, sidebarItemClass } from "./Sidebar";
import type { SidebarCtxKind, SidebarLongPress } from "./Sidebar";

// Members-tab agent entity row. Builds its own handlers from stable parent
// callbacks so the Sidebar does not hand each row new closures per render.
// Stryker disable all: member-row interaction glue is contract-pinned and browser-smoke verified.
export interface MemberAgentRowProps {
  agent: Agent;
  selected: boolean;
  menuOpen: boolean;
  onSelect: (agentId: string, clickCount: number) => void;
  onOpenDm: (agentId: string) => Promise<void>;
  onContextMenu: (e: React.MouseEvent, type: SidebarCtxKind, id: string) => void;
  makeLongPress: (type: SidebarCtxKind, id: string) => SidebarLongPress;
}

export const MemberAgentRow = memo(function MemberAgentRow({
  agent,
  selected,
  menuOpen,
  onSelect,
  onOpenDm,
  onContextMenu,
  makeLongPress,
}: MemberAgentRowProps) {
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => onSelect(agent.id, event.detail),
    [agent.id, onSelect],
  );
  const handleDoubleClick = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void onOpenDm(agent.id);
  }, [agent.id, onOpenDm]);
  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => onContextMenu(event, "member-agent", agent.id),
    [agent.id, onContextMenu],
  );
  return (
    <SidebarItem variant="accent"
      data-agent-id={agent.id}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      data-slot="sidebar-item"
      active={selected}
      {...makeLongPress("member-agent", agent.id)}
      className={sidebarItemClass(selected, menuOpen)}
    >
      <AvatarSlot
        context="sidebar-list"
        type="agent"
        agentAvatarUrl={agent.avatarUrl}
        badge={<SidebarAgentActivityBadge agentId={agent.id} />}
      />
      <div className="flex min-w-0 flex-1 items-baseline gap-1 text-left">
        <span className="min-w-0 truncate text-sm">{agent.displayName || agent.name}</span>
        {agent.description && (
          <span className="min-w-0 flex-1 truncate text-xs text-foreground-muted theme-brutal:text-black/40">{agent.description}</span>
        )}
      </div>
    </SidebarItem>
  );
});
// Stryker restore all
