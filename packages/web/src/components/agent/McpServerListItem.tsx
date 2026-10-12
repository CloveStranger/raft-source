import Banner from "../ui/Banner";
import { Button } from "raft-ui";
import { ChevronDown, ChevronUp, FlaskConical, Info, Link2, Pencil, Trash2, Unplug } from "lucide-react";
import type { IntlShape } from "react-intl";
import type { ManagedMcpServerView } from "@botiverse/raft-shared";
import SurfaceListItem from "../ui/SurfaceListItem";
import Tooltip from "../ui/Tooltip";
import api from "../../api/client";
import { normalizeManagedMcpToolDescription } from "./managedMcpToolDescription";
import { useCallback } from "react";

/** Static tooltip placement for tool descriptions (hoisted — task #709). */
const TOOL_TOOLTIP_CONTENT_PROPS = {
  side: "top",
  align: "end",
  className: "max-h-64 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto px-3 py-2 font-normal",
} as const;

type McpServerListItemProps = {
  server: ManagedMcpServerView;
  scope: "server" | "agent";
  canManageServer: boolean;
  busyId: string | null;
  expandedTools: ReadonlySet<string>;
  setExpandedTools: (updater: (current: Set<string>) => Set<string>) => void;
  connectOAuth: (server: ManagedMcpServerView) => Promise<void>;
  disconnectOAuth: (server: ManagedMcpServerView) => Promise<void>;
  mutate: (id: string, operation: () => Promise<unknown>) => Promise<void>;
  beginEdit: (server: ManagedMcpServerView) => void;
  onDeleteTarget: (server: ManagedMcpServerView) => void;
  formatMessage: IntlShape["formatMessage"];
  formatDate: (date: Date, options: Record<string, unknown>) => string;
  formatTime: (date: Date, options: Record<string, unknown>) => string;
};

export function McpServerListItem({
  server,
  scope,
  canManageServer,
  busyId,
  expandedTools,
  setExpandedTools,
  connectOAuth,
  disconnectOAuth,
  mutate,
  beginEdit,
  onDeleteTarget,
  formatMessage,
  formatDate,
  formatTime,
}: McpServerListItemProps) {
  const toolsOpen = expandedTools.has(server.id);
  const connectionReady = server.authMode !== "oauth" || server.oauthStatus === "connected";

  const handleConnect = useCallback(() => {
    void connectOAuth(server);
  }, [connectOAuth, server]);

  const handleDisconnect = useCallback(() => {
    void disconnectOAuth(server);
  }, [disconnectOAuth, server]);

  const handleTest = useCallback(() => {
    void mutate(server.id, () => api.post(`/mcp/servers/${server.id}/test`));
  }, [mutate, server.id]);

  const handleEdit = useCallback(() => {
    beginEdit(server);
  }, [beginEdit, server]);

  const handleDelete = useCallback(() => {
    onDeleteTarget(server);
  }, [onDeleteTarget, server]);

  const handleToolsToggle = useCallback(() => {
    setExpandedTools((current) => {
      const next = new Set(current);
      if (toolsOpen) next.delete(server.id); else next.add(server.id);
      return next;
    });
  }, [setExpandedTools, toolsOpen, server.id]);

  return (
    <SurfaceListItem interactive={false}>
  <div className="flex items-start gap-3">
    <div className="flex min-w-0 flex-1 items-start gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="break-words text-sm font-bold text-foreground-strong theme-brutal:text-black">{server.name}</h4>
          {!server.enabled && <span className="border border-line-muted bg-fill-muted px-1.5 py-0.5 text-[10px] font-bold uppercase theme-brutal:border-black theme-brutal:bg-gray-200">{formatMessage({ id: "agent.mcp.disabledBadge" })}</span>}
          <span className="border border-line-muted bg-layer-panel px-1.5 py-0.5 text-[10px] font-bold uppercase theme-brutal:border-black theme-brutal:bg-white">{server.provider}</span>
          {server.authMode === "oauth" ? (
            <span className={`border border-line-muted px-1.5 py-0.5 text-[10px] font-bold uppercase theme-brutal:border-black ${server.oauthStatus === "connected" ? "bg-success-soft text-success-strong theme-brutal:bg-brutal-lime theme-brutal:text-black" : server.oauthStatus === "error" ? "bg-danger-soft text-danger-strong theme-brutal:bg-brutal-red/30 theme-brutal:text-black" : "bg-accent-soft text-accent-strong theme-brutal:bg-brutal-lavender/40 theme-brutal:text-black"}`}>
              {formatMessage({ id: "agent.mcp.oauthStatus" }, { status: server.oauthStatus })}
            </span>
          ) : server.hasCredentials ? (
            <span className="border border-line-muted bg-accent-soft px-1.5 py-0.5 text-[10px] font-bold uppercase text-accent-strong theme-brutal:border-black theme-brutal:bg-brutal-lavender/40 theme-brutal:text-black">{formatMessage({ id: "agent.mcp.credentialsStoredBadge" })}</span>
          ) : null}
        </div>
        {server.description && <p className="mt-1 text-sm text-foreground-muted theme-brutal:text-black/70">{server.description}</p>}
        <p className="mt-1 break-all font-mono text-xs text-foreground-placeholder theme-brutal:text-black/50">{server.endpointUrl}</p>
        {scope === "agent" && server.usage && (
          <dl className="mt-3 grid gap-2 text-xs text-foreground-muted sm:grid-cols-3 theme-brutal:text-black/65">
            <div>
              <dt className="font-bold text-foreground-strong theme-brutal:text-black">
                {formatMessage({ id: "agent.mcpUsage.callsLabel" })}
              </dt>
              <dd>
                {formatMessage(
                  { id: "agent.mcpUsage.callCount" },
                  { count: server.usage.invocationCount },
                )}
              </dd>
            </div>
            <div>
              <dt className="font-bold text-foreground-strong theme-brutal:text-black">
                {formatMessage({ id: "agent.mcpUsage.lastUsedLabel" })}
              </dt>
              <dd>
                {formatDate(new Date(server.usage.lastInvokedAt), {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}{" "}
                {formatTime(new Date(server.usage.lastInvokedAt), {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </dd>
            </div>
            <div>
              <dt className="font-bold text-foreground-strong theme-brutal:text-black">
                {formatMessage({ id: "agent.mcpUsage.lastToolLabel" })}
              </dt>
              <dd className="break-all font-mono">{server.usage.lastToolName}</dd>
            </div>
          </dl>
        )}
        {server.lastCheckError && (
          <Banner intent="warning" density="sm" className="mt-3 font-bold">{server.lastCheckError}</Banner>
        )}
      </div>
    </div>
    {scope === "server" && canManageServer && (
      <div className="flex shrink-0 items-center gap-1">
        {server.authMode === "oauth" && server.oauthStatus !== "connected" && (
          <Tooltip content={formatMessage({ id: "agent.mcp.connectName" }, { name: server.name })}>
            <Button
              size="icon-sm"
              variant="success"
              aria-label={formatMessage({ id: "agent.mcp.connectName" }, { name: server.name })}
              disabled={busyId === server.id}
              onClick={handleConnect}
            >
              <Link2 size={14} />
            </Button>
          </Tooltip>
        )}
        {server.authMode === "oauth" && server.oauthStatus === "connected" && (
          <Tooltip content={formatMessage({ id: "agent.mcp.disconnectName" }, { name: server.name })}>
            <Button
              size="icon-sm"
              aria-label={formatMessage({ id: "agent.mcp.disconnectName" }, { name: server.name })}
              disabled={busyId === server.id}
              onClick={handleDisconnect}
            >
              <Unplug size={14} />
            </Button>
          </Tooltip>
        )}
        <Tooltip content={formatMessage({ id: "agent.mcp.testRefreshTools" })}>
          <Button
            size="icon-sm"
            aria-label={formatMessage({ id: "agent.mcp.testName" }, { name: server.name })}
            disabled={busyId === server.id || !connectionReady}
            onClick={handleTest}
          >
            <FlaskConical size={14} />
          </Button>
        </Tooltip>
        <Tooltip content={formatMessage({ id: "agent.mcp.editServer" })}>
          <Button size="icon-sm" aria-label={formatMessage({ id: "agent.mcp.editName" }, { name: server.name })} onClick={handleEdit}>
            <Pencil size={14} />
          </Button>
        </Tooltip>
        <Tooltip content={formatMessage({ id: "agent.mcp.deleteServer" })}>
          <Button size="icon-sm" variant="danger" aria-label={formatMessage({ id: "agent.mcp.deleteName" }, { name: server.name })} onClick={handleDelete}>
            <Trash2 size={14} />
          </Button>
        </Tooltip>
      </div>
    )}
  </div>

  <button
    type="button"
    className="mt-3 flex items-center gap-1 text-xs font-bold text-foreground-muted underline hover:text-foreground-strong theme-brutal:text-black/70 theme-brutal:hover:text-black"
    aria-expanded={toolsOpen}
    onClick={handleToolsToggle}
  >
    {toolsOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
    {formatMessage({ id: "agent.mcp.toolCount" }, { count: server.toolCatalog.length })}
  </button>
  {toolsOpen && (
    <div className="mt-2 max-h-80 overflow-y-auto border-y border-line-muted bg-fill-muted/40">
      <div className="grid grid-cols-1 sm:grid-cols-2">
        {server.toolCatalog.map((tool) => {
          const label = tool.title || tool.name;
          const description = tool.description ? normalizeManagedMcpToolDescription(tool.description) : null;
          return (
            <div key={tool.name} className="flex min-h-16 items-start gap-2 border-b border-line-muted px-2.5 py-2 sm:even:border-l sm:even:border-line-muted">
              <span className="min-w-0 flex-1 break-words">
                <span className="flex items-start gap-1">
                  <strong className="min-w-0 flex-1 text-sm leading-5 text-foreground-strong theme-brutal:text-black">{label}</strong>
                  {description && (
                    <Tooltip
                      content={<span className="block text-left">{description}</span>}
                      contentProps={TOOL_TOOLTIP_CONTENT_PROPS}
                    >
                      <button type="button" className="mt-0.5 shrink-0 text-foreground-placeholder hover:text-foreground-strong theme-brutal:text-black/45 theme-brutal:hover:text-black" aria-label={formatMessage({ id: "agent.mcp.aboutTool" }, { name: label })}>
                        <Info size={13} />
                      </button>
                    </Tooltip>
                  )}
                </span>
                {description && <span className="mt-0.5 line-clamp-2 text-xs leading-4 text-foreground-muted theme-brutal:text-black/55">{description}</span>}
              </span>
            </div>
          );
        })}
      </div>
      {server.toolCatalog.length === 0 && (
        <p className="px-2.5 py-3 text-xs text-foreground-muted theme-brutal:text-black/50">{formatMessage({ id: "agent.mcp.testToDiscoverTools" })}</p>
      )}
    </div>
  )}

    </SurfaceListItem>
  );
}
