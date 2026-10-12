import { Button, Popover, PopoverContent, PopoverTrigger, toast } from "raft-ui";
import { AlertCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { getSocket } from "../../api/socket";
import {
  requestThreadAgentFollowers,
  useThreadAgentFollowerStore,
} from "../../store/threadAgentFollowerStore";
import { useServerStore } from "../../store/serverStore";
import AvatarSlot from "../ui/AvatarSlot";
import Tooltip from "../ui/Tooltip";
import { ThreadAgentFollowerRow } from "./ThreadAgentFollowerRow";

function stopEventPropagation(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

export default function ThreadAgentFollowers({
  threadChannelId,
  variant,
}: {
  threadChannelId: string;
  variant: "card" | "header";
}) {
  const { formatMessage } = useIntl();
  const roster = useThreadAgentFollowerStore((state) => state.rosters[threadChannelId]);
  const load = useThreadAgentFollowerStore((state) => state.load);
  const remove = useThreadAgentFollowerStore((state) => state.remove);
  const restore = useThreadAgentFollowerStore((state) => state.restore);
  const currentServerId = useServerStore((state) => state.current?.id);
  const [open, setOpen] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  useEffect(() => {
    requestThreadAgentFollowers(threadChannelId);
  }, [threadChannelId]);

  useEffect(() => {
    const socket = getSocket();
    const handleMessageNew = (message: { channelId?: string } | null | undefined) => {
      if (message?.channelId !== threadChannelId) return;
      requestThreadAgentFollowers(threadChannelId, true);
    };
    socket.on("message:new", handleMessageNew);
    return () => {
      socket.off("message:new", handleMessageNew);
    };
  }, [threadChannelId]);

  const agents = roster?.agents ?? [];
  const label = roster?.error
    ? formatMessage({ id: "thread.followers.loadFailed" })
    : formatMessage({ id: "thread.followers.label" }, { count: agents.length });

  const handleRemove = useCallback(async (agentId: string, agentLabel: string) => {
    setRemovingId(agentId);
    try {
      const undoToken = await remove(threadChannelId, agentId);
      if (!undoToken) return;
      toast.success(
        formatMessage({ id: "thread.followers.removed" }, { agent: agentLabel }),
        {
          timeout: 5_000,
          dismissible: false,
          contentClassName: "thread-follower-removal-toast",
          action: {
            label: formatMessage({ id: "thread.followers.undo" }),
            onClick: () => {
              void restore(threadChannelId, agentId, undoToken).then((restored) => {
                if (restored) toast.success(formatMessage({ id: "thread.followers.restored" }, { agent: agentLabel }));
              });
            },
          },
        },
      );
    } catch {
      toast.error(formatMessage({ id: "thread.followers.removeFailed" }));
    } finally {
      setRemovingId(null);
    }
  }, [formatMessage, remove, restore, threadChannelId]);

  const retryLoad = useCallback(() => {
    void load([threadChannelId], true);
  }, [load, threadChannelId]);

  // Do not show a zero-count affordance. While the count is unknown there is
  // nothing actionable yet; a failed load still exposes Retry via an error-only
  // trigger rather than presenting the failure as "0 followers".
  if (!roster || roster.loading && !roster.loaded) return null;
  if (roster.loaded && agents.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip content={label}>
      <PopoverTrigger
        render={(
          <Button
            type="button"
            onClick={stopEventPropagation}
            onPointerDown={stopEventPropagation}
            size={variant === "header" ? "sm" : undefined}
            variant="outline"
            className={variant === "header"
              ? "h-7 gap-1 px-1.5 text-xs font-bold"
              : "inline-flex h-5 items-center gap-1 rounded border border-line-muted theme-brutal:border-black/25 bg-layer-panel theme-brutal:bg-white px-1.5 text-[10px] font-bold text-foreground-muted theme-brutal:text-black/60 hover:border-line-muted theme-brutal:hover:border-black"}
            aria-label={label}
            data-testid={`thread-followers-${variant}-trigger`}
          >
            <span className="flex -space-x-1" aria-hidden="true">
              {roster.error ? (
                <AlertCircle size={variant === "header" ? 14 : 12} />
              ) : agents.slice(0, 3).map((agent) => (
                <AvatarSlot key={agent.id} context={variant === "header" ? "sidebar-list" : "preview-mini"} type="agent" agentAvatarUrl={agent.avatarUrl} />
              ))}
            </span>
            {roster.error ? null : <span>{agents.length}</span>}
          </Button>
        )}
      />
      </Tooltip>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={6}
        // The trigger lives in a thread header that reflows when a profile
        // panel opens or the pane is resized. raft-ui disables anchor
        // tracking by default, which would leave this popover stranded at
        // the trigger's old coordinates.
        disableAnchorTracking={false}
        className="w-72 p-0"
        data-testid="thread-followers-popover"
      >
        <div className="border-b-2 border-line-muted theme-brutal:border-black bg-layer-panel theme-brutal:bg-brutal-cream px-3 py-2 text-sm font-bold">
          {formatMessage({ id: "thread.followers.title" })}
        </div>
        <div className="max-h-72 overflow-y-auto p-2">
          {roster?.loading && !roster.loaded ? (
            <div className="px-2 py-4 text-center text-xs font-bold text-foreground-placeholder theme-brutal:text-black/45" data-testid="thread-followers-loading">
              {formatMessage({ id: "thread.followers.loading" })}
            </div>
          ) : roster?.error ? (
            <div className="flex flex-col items-center gap-2 px-2 py-4 text-center text-xs font-bold text-foreground-muted theme-brutal:text-black/60" data-testid="thread-followers-error">
              <AlertCircle size={18} />
              {formatMessage({ id: "thread.followers.loadFailed" })}
              <Button variant="outline" size="sm" type="button" className="bg-layer-panel theme-brutal:bg-white px-2 py-1" onClick={retryLoad}>
                {formatMessage({ id: "thread.followers.retry" })}
              </Button>
            </div>
          ) : agents.length === 0 ? (
            <div className="px-2 py-4 text-center text-xs font-bold text-foreground-placeholder theme-brutal:text-black/45" data-testid="thread-followers-empty">
              {formatMessage({ id: "thread.followers.empty" })}
            </div>
          ) : agents.map((agent) => (
            <ThreadAgentFollowerRow
              key={agent.id}
              agent={agent}
              canManage={roster?.canManage}
              removing={removingId === agent.id}
              currentServerId={currentServerId}
              onRemove={handleRemove}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
