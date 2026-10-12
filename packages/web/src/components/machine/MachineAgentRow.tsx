import type { Agent, AgentDisplayState } from "../../store/agentStore";
import AvatarListRow from "../ui/AvatarListRow";
import AvatarSlot from "../ui/AvatarSlot";
import CheckMarker from "../ui/CheckMarker";
import StatusDot from "../ui/StatusDot";
import SurfaceListItem from "../ui/SurfaceListItem";
import Tooltip from "../ui/Tooltip";
import { agentModelLabel } from "../../utils/agentModelName";
import { formatActivityText } from "../../utils/activity";
import { formatRuntimeLabelWithStatus } from "../../utils/runtimeAvailabilityLabel";
import { useCallback } from "react";
import { useIntl } from "react-intl";

const BULK_HIGHLIGHT_BUTTON_PROPS = { "data-bulk-highlight": "true" } as const;

export function MachineAgentRow({
  agent,
  displayState,
  selectionMode,
  selected,
  canManageMachines,
  onToggleSelection,
  onOpenAgent,
  highlighted = false,
}: {
  agent: Agent;
  displayState: AgentDisplayState;
  selectionMode: boolean;
  selected: boolean;
  canManageMachines: boolean;
  onToggleSelection: (agentId: string) => void;
  onOpenAgent: (agentId: string) => void;
  /** Briefly marks a row just changed by a bulk action (3 s, one-shot). */
  highlighted?: boolean;
}) {
  const { formatMessage } = useIntl();
  const agentId = agent.id;
  const handleToggleSelection = useCallback(() => onToggleSelection(agentId), [agentId, onToggleSelection]);
  const handleOpenAgent = useCallback(() => onOpenAgent(agentId), [agentId, onOpenAgent]);
  // A Computer page is where these agent identities are managed:
  // show the model alongside the runtime (artin 2026-09-27), not
  // only the chat-side "Show agent model" preference.
  const agentIdentityLabel = [
    formatRuntimeLabelWithStatus(agent.runtime, formatMessage),
    agentModelLabel(agent),
  ].filter(Boolean).join(" · ");
  const activityText = formatActivityText(
    formatMessage,
    displayState.activity,
    displayState.activityDetail,
    displayState.activityDetailKind,
  );
  const avatar = <AvatarSlot context="surface-list" type="agent" agentAvatarUrl={agent.avatarUrl} />;
  const rightStatus = (
    <>
      <StatusDot activity={displayState.activity} title={activityText} />
      <Tooltip content={activityText}><span
        className="hidden max-w-[min(32rem,42vw)] truncate align-middle text-xs font-mono text-foreground-muted theme-brutal:text-black/50 sm:inline-block"
      >
        {activityText}
      </span></Tooltip>
    </>
  );
  if (selectionMode) {
    // Selection mode adds a leading CheckMarker column that
    // is outside AvatarListRow's slot contract. Keep the inline
    // SurfaceListItem here — the row body still mirrors the
    // primitive's avatar / name / subtitle / rightContent layout
    // so the visual is identical to the normal-mode AvatarListRow.
    return (
      <SurfaceListItem
        selected={canManageMachines && selected}
        className={`group px-3 py-2 ${selected ? "" : "bg-layer-canvas-muted hover:bg-layer-panel theme-brutal:bg-gray-100 theme-brutal:hover:bg-white"}`}
      >
        <Tooltip content={
            selected
              ? formatMessage({ id: "machine.detail.deselectAgent" })
              : formatMessage({ id: "machine.detail.selectAgent" })
          }>
        <button
          type="button"
          onClick={handleToggleSelection}
          className="flex w-full min-w-0 items-center gap-3 text-left"
          aria-label={
            selected
              ? formatMessage({ id: "machine.detail.deselectAgentName" }, { name: agent.displayName || agent.name })
              : formatMessage({ id: "machine.detail.selectAgentName" }, { name: agent.displayName || agent.name })
          }
        >
          <CheckMarker
            checked={selected}
            size="lg"
            tone="yellow-fill"
            previewOnHover
            className="mt-0"
          />
          {avatar}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <span className="truncate text-sm font-bold text-foreground-strong theme-brutal:text-black">
                {agent.displayName || agent.name}
              </span>
              <span className="text-xs font-mono text-foreground-muted theme-brutal:text-black/50">
                {agentIdentityLabel}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">{rightStatus}</div>
        </button>
        </Tooltip>
      </SurfaceListItem>
    );
  }
  return (
    <AvatarListRow
      avatar={avatar}
      name={agent.displayName || agent.name}
      subtitle={agentIdentityLabel}
      rightContent={rightStatus}
      onClick={handleOpenAgent}
      selected={false}
      buttonProps={highlighted ? BULK_HIGHLIGHT_BUTTON_PROPS : undefined}
      className={highlighted
        ? "bg-success-soft ring-2 ring-success/40 transition-[background-color,box-shadow] duration-300 theme-brutal:bg-brutal-lime/30 theme-brutal:ring-0 theme-brutal:shadow-brutal-sm motion-reduce:transition-none"
        : "bg-layer-canvas-muted transition-[background-color,box-shadow] duration-300 hover:bg-layer-panel theme-brutal:bg-gray-100 theme-brutal:hover:bg-white motion-reduce:transition-none"}
    />
  );
}
