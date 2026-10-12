import { Button } from "raft-ui";
import { useCallback, useMemo } from "react";
import { Link2Off } from "lucide-react";
import { useIntl } from "react-intl";
import type { ProviderConnectionAssignedAgent } from "@botiverse/raft-shared";
import { formatRuntimeLabelWithStatus } from "../../utils/runtimeAvailabilityLabel";
import AvatarListRow from "../ui/AvatarListRow";
import AvatarSlot from "../ui/AvatarSlot";
import StatusDot from "../ui/StatusDot";
import Tooltip from "../ui/Tooltip";

export function AssignedAgentRow({
  agent,
  canManage,
  busy,
  onOpenAgent,
  onDetachAgent,
}: {
  agent: ProviderConnectionAssignedAgent;
  canManage: boolean;
  busy: boolean;
  onOpenAgent?: (agentId: string) => void;
  onDetachAgent: (agentId: string) => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const label = agent.displayName || agent.name;
  const statusText = formatMessage({ id: `settings.providers.agentStatus.${agent.status}` });
  const subtitle = [
    formatMessage({ id: "settings.providers.assignedAgentHandle" }, { name: agent.name }),
    formatRuntimeLabelWithStatus(agent.runtime, formatMessage),
    agent.computerName ?? formatMessage({ id: "settings.providers.assignedAgentNoComputer" }),
  ].join(" · ");
  const handleDetach = useCallback(() => {
    const confirmed = window.confirm(
      formatMessage({ id: "settings.providers.detachConfirm" }, { name: label }),
    );
    if (confirmed) void onDetachAgent(agent.id);
  }, [agent.id, formatMessage, label, onDetachAgent]);
  const handleOpen = useCallback(() => onOpenAgent?.(agent.id), [agent.id, onOpenAgent]);
  const openButtonProps = useMemo(() => {
    const openLabel = formatMessage({ id: "settings.providers.assignedAgentOpen" }, { name: label });
    return { "aria-label": openLabel, title: openLabel };
  }, [formatMessage, label]);

  return (
    <div data-testid={`provider-connection-assigned-agent-${agent.id}`}>
      {agent.deleted ? (
        // Static row: the detach control lives in the primitive's
        // action slot, a sibling of the (absent) row button, so a
        // deleted Agent never nests one interactive target in another.
        <AvatarListRow
          avatar={<AvatarSlot context="surface-list" type="agent" agentAvatarUrl={null} className="grayscale opacity-60" />}
          name={<span className="text-foreground-hint line-through">{label}</span>}
          subtitle={subtitle}
          rightContent={(
            <span className="shrink-0 rounded-sm border border-line-muted px-1 text-[10px] font-black uppercase text-foreground-hint theme-brutal:rounded-none theme-brutal:border-2 theme-brutal:border-black/30">
              {formatMessage({ id: "settings.providers.assignedAgentDeleted" })}
            </span>
          )}
          actionContent={canManage ? (
            <Tooltip content={formatMessage({ id: "settings.providers.assignedAgentDeletedHint" })}>
            <Button
              type="button"
              size="sm"
              data-slot="button"
              disabled={busy}
              aria-label={formatMessage({ id: "settings.providers.assignedAgentDetach" })}
              onClick={handleDetach}
            >
              <Link2Off size={15} />
              {formatMessage({ id: "settings.providers.assignedAgentDetach" })}
            </Button>
            </Tooltip>
          ) : undefined}
          className="bg-gray-100"
        />
      ) : (
        <AvatarListRow
          avatar={<AvatarSlot context="surface-list" type="agent" agentAvatarUrl={null} />}
          name={label}
          subtitle={subtitle}
          rightContent={(
            <>
              <StatusDot activity={agent.status === "active" ? "online" : "offline"} title={statusText} />
              <span
                className="hidden max-w-[min(32rem,42vw)] truncate align-middle text-xs font-mono text-foreground-hint sm:inline-block"
              >
                {statusText}
              </span>
            </>
          )}
          onClick={handleOpen}
          buttonProps={openButtonProps}
          className="bg-fill-muted/50 hover:bg-fill-muted theme-brutal:bg-gray-100 theme-brutal:hover:bg-white"
        />
      )}
    </div>
  );
}
