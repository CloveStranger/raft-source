import { Badge, Button } from "raft-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import type {
  AgentAppEventDetail,
  AgentAppEventListResponse,
  AgentAppEventSummary,
} from "@botiverse/raft-shared";
import api from "../../api/client";
import Banner from "../ui/Banner";
import SectionHeader from "../ui/SectionHeader";
import SurfaceListItem from "../ui/SurfaceListItem";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import type { MessageId } from "../../i18n/messages";
import { AppEventFilterButton } from "./AppEventFilterButton";
import { GrantableAppOption } from "./GrantableAppOption";
import { GrantScopeCheckbox } from "./GrantScopeCheckbox";
import { IntegrationActionButton } from "./IntegrationActionButton";

interface AgentIntegrationItem {
  id: string;
  type: "pending" | "active";
  clientId: string;
  clientName: string;
  clientDescription: string | null;
  clientHomepageUrl: string | null;
  clientAgentManifestUrl: string | null;
  scopes: string[];
  createdAt: string;
  grantSource: "person" | "agent_login" | "app_request" | null;
}

export interface GrantableApp {
  clientId: string;
  clientKey: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  scopes: string[];
}

const GRANT_SOURCE_LABEL: Record<NonNullable<AgentIntegrationItem["grantSource"]>, MessageId> = {
  person: "agent.apps.grantSource.person",
  agent_login: "agent.apps.grantSource.agentLogin",
  app_request: "agent.apps.grantSource.appRequest",
};

const APPROVE_REQUEST_BODY = { remember: true };
const EMPTY_BODY = {};

const EVENT_STATUS_VARIANT: Record<AgentAppEventSummary["status"], "success" | "warning" | "muted"> = {
  delivered: "success",
  queued: "warning",
  expired: "muted",
};

function errorText(err: unknown, fallback: string): string {
  const message = (err as { response?: { data?: { error?: unknown } } })?.response?.data?.error;
  return typeof message === "string" && message ? message : fallback;
}

function ScopeChips({ scopes }: { scopes: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {scopes.map((scope) => (
        <span key={scope} className="inline-flex border border-line-muted bg-layer-card px-1.5 py-0.5 text-[10px] font-bold uppercase theme-brutal:border-black theme-brutal:bg-white">
          {scope}
        </span>
      ))}
    </div>
  );
}

/** Pick an app usable on this server and the scopes to grant, then confirm. */
function GrantAccessForm({ agentId, onDone, onCancel }: { agentId: string; onDone: () => void; onCancel: () => void }) {
  const { formatMessage } = useIntl();
  const [apps, setApps] = useState<GrantableApp[] | null>(null);
  const [selected, setSelected] = useState<GrantableApp | null>(null);
  const [scopes, setScopes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let canceled = false;
    api.get(`/integrations/agents/${agentId}/grantable-apps`)
      .then(({ data }) => { if (!canceled) setApps(data.apps ?? []); })
      .catch((err) => { if (!canceled) setError(errorText(err, formatMessage({ id: "agent.apps.loadGrantableFailed" }))); });
    return () => { canceled = true; };
  }, [agentId, formatMessage]);

  const choose = useCallback((app: GrantableApp) => {
    setSelected(app);
    setScopes(app.scopes);
  }, []);

  const toggleScope = useCallback((scope: string, checked: boolean) => {
    setScopes((prev) => checked ? [...prev, scope] : prev.filter((s) => s !== scope));
  }, []);

  const submit = useCallback(async () => {
    if (!selected || scopes.length === 0) return;
    setSaving(true);
    setError("");
    try {
      await api.post(`/integrations/agents/${agentId}/grants`, { clientId: selected.clientId, scopes });
      onDone();
    } catch (err) {
      setError(errorText(err, formatMessage({ id: "agent.apps.grantFailed" })));
    } finally {
      setSaving(false);
    }
  }, [agentId, selected, scopes, onDone, formatMessage]);

  const handleSubmit = useCallback(() => { void submit(); }, [submit]);

  return (
    <SurfaceListItem className="space-y-3" interactive={false} data-testid="agent-grant-access-form">
      <div className="text-sm font-bold text-foreground-strong">{formatMessage({ id: "agent.apps.grantTitle" })}</div>
      <div className="text-xs text-foreground-muted">{formatMessage({ id: "agent.apps.grantDescription" })}</div>
      {error && <Banner intent="warning" density="sm" className="font-bold">{error}</Banner>}
      {apps === null ? (
        !error && <div className="text-xs font-bold text-foreground-muted">{formatMessage({ id: "common.loading" })}</div>
      ) : apps.length === 0 ? (
        <div className="text-sm text-foreground-muted">{formatMessage({ id: "agent.apps.noGrantableApps" })}</div>
      ) : (
        <div className="grid gap-2">
          {apps.map((app) => (
            <GrantableAppOption key={app.clientId} app={app} selected={selected?.clientId === app.clientId} onChoose={choose} />
          ))}
        </div>
      )}
      {selected && (
        <div className="space-y-2">
          <div className="text-xs font-bold text-foreground-strong">{formatMessage({ id: "agent.apps.grantScopes" })}</div>
          {selected.scopes.map((scope) => (
            <GrantScopeCheckbox key={scope} scope={scope} checked={scopes.includes(scope)} onToggle={toggleScope} />
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={handleSubmit} disabled={!selected || scopes.length === 0 || saving}>
          {formatMessage({ id: "agent.apps.grantConfirm" })}
        </Button>
        <Button variant="outline" size="sm" onClick={onCancel}>{formatMessage({ id: "agent.detail.cancel" })}</Button>
      </div>
    </SurfaceListItem>
  );
}

function AppEventRow({ agentId, event }: { agentId: string; event: AgentAppEventSummary }) {
  const { formatMessage } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<AgentAppEventDetail | null>(null);
  const [error, setError] = useState("");

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || detail) return;
    try {
      const { data } = await api.get(`/integrations/agents/${agentId}/events/${event.id}`);
      setDetail(data);
    } catch (err) {
      setError(errorText(err, formatMessage({ id: "agent.apps.loadEventFailed" })));
    }
  };

  return (
    <SurfaceListItem className="space-y-1.5" interactive={false}>
      <button type="button" onClick={() => void toggle()} aria-expanded={open} className="block w-full text-left">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 text-sm font-bold text-foreground-strong break-words">{event.summary}</div>
          <Badge appearance="soft" variant={EVENT_STATUS_VARIANT[event.status]} uppercase className="shrink-0 text-[10px]">
            {formatMessage({ id: `agent.apps.eventStatus.${event.status}` as MessageId })}
          </Badge>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-foreground-muted">
          <span className="font-bold">{event.app.name}</span>
          <span className="font-mono">{event.kind}</span>
          <span className="font-mono">{formatShortDateTime(event.createdAt)}</span>
        </div>
      </button>
      {open && (
        error ? (
          <Banner intent="warning" density="sm" className="font-bold">{error}</Banner>
        ) : detail ? (
          // App-supplied data: shown as inert JSON text, never rendered as links or markup.
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all border border-line-muted bg-layer-card p-2 font-mono text-[11px] text-foreground-strong theme-brutal:border-black/15">
            {JSON.stringify(detail.payload, null, 2)}
          </pre>
        ) : (
          <div className="text-xs font-bold text-foreground-muted">{formatMessage({ id: "common.loading" })}</div>
        )
      )}
    </SurfaceListItem>
  );
}

/** Recent events apps sent to this agent, newest first, filterable by app. */
function AgentAppEventsSection({ agentId }: { agentId: string }) {
  const { formatMessage } = useIntl();
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;
  const [events, setEvents] = useState<AgentAppEventSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [appFilter, setAppFilter] = useState<string | null>(null);
  const [apps, setApps] = useState<Array<{ clientId: string; name: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (cursor: string | null) => {
    setLoading(true);
    setError("");
    try {
      const params: Record<string, string> = {};
      if (appFilter) params.clientId = appFilter;
      if (cursor) params.before = cursor;
      const { data } = await api.get(`/integrations/agents/${agentId}/events`, { params });
      const page = data as AgentAppEventListResponse;
      setEvents((prev) => cursor ? [...prev, ...page.events] : page.events);
      setNextCursor(page.nextCursor);
      if (!appFilter) {
        // Filter chips come from the apps seen so far in the unfiltered list.
        setApps((prev) => {
          const byId = new Map(prev.map((app) => [app.clientId, app]));
          for (const event of page.events) byId.set(event.app.clientId, { clientId: event.app.clientId, name: event.app.name });
          return [...byId.values()];
        });
      }
    } catch (err) {
      setError(errorText(err, formatMessageRef.current({ id: "agent.apps.loadEventsFailed" })));
    } finally {
      setLoading(false);
    }
  }, [agentId, appFilter]);

  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-derived-state -- async loading indicator, same pattern as the grants list
    void load(null);
  }, [load]);

  const reload = useCallback(() => { void load(null); }, [load]);
  const loadMore = useCallback(() => { void load(nextCursor); }, [load, nextCursor]);

  return (
    <div className="space-y-3" data-testid="agent-app-events">
      <div>
        <SectionHeader
          label={formatMessage({ id: "agent.apps.eventsTitle" })}
          action={
            <Button variant="outline" size="sm" onClick={reload} disabled={loading} className="text-[11px]">
              {loading ? formatMessage({ id: "common.loading" }) : formatMessage({ id: "agent.apps.refresh" })}
            </Button>
          }
        />
        <div className="mt-1 text-xs text-foreground-muted">{formatMessage({ id: "agent.apps.eventsDescription" })}</div>
      </div>
      {apps.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          <AppEventFilterButton clientId={null} active={appFilter === null} onSelect={setAppFilter}>
            {formatMessage({ id: "agent.apps.allApps" })}
          </AppEventFilterButton>
          {apps.map((app) => (
            <AppEventFilterButton key={app.clientId} clientId={app.clientId} active={appFilter === app.clientId} onSelect={setAppFilter}>
              {app.name}
            </AppEventFilterButton>
          ))}
        </div>
      )}
      {error && <Banner intent="warning" density="sm" className="font-bold">{error}</Banner>}
      {events.length === 0 && !loading && !error ? (
        <div className="text-sm text-foreground-muted theme-brutal:text-black/50">{formatMessage({ id: "agent.apps.noEvents" })}</div>
      ) : (
        <div className="space-y-2">
          {events.map((event) => <AppEventRow key={event.id} agentId={agentId} event={event} />)}
        </div>
      )}
      {nextCursor && (
        <Button variant="outline" size="sm" onClick={loadMore} disabled={loading}>
          {formatMessage({ id: "agent.apps.loadMore" })}
        </Button>
      )}
    </div>
  );
}

/**
 * The Agent panel's Apps tab: which apps can act for this agent (and how they
 * got access), pending requests, granting access on the agent's behalf, and
 * the events apps sent to it. `canManageAgentAccess` is the agent's creator or
 * a server owner/admin; the server enforces the same rule.
 */
export default function AgentAppAccessTab({ agentId, canManageAgentAccess }: { agentId: string; canManageAgentAccess: boolean }) {
  const { formatMessage } = useIntl();
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;
  const { formatShortDateTime } = useTimeFormatter();
  const [items, setItems] = useState<AgentIntegrationItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [granting, setGranting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { data } = await api.get(`/integrations/agents/${agentId}`);
      setItems(data);
    } catch (err) {
      setError(errorText(err, formatMessageRef.current({ id: "agent.detail.loadIntegrationsFailed" })));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-derived-state -- async loading indicator (set at request start, cleared in finally)
    void load();
  }, [load]);

  const act = useCallback(async (path: string, body: unknown, fallbackId: MessageId) => {
    setError("");
    try {
      await api.post(path, body);
      await load();
    } catch (err) {
      setError(errorText(err, formatMessage({ id: fallbackId })));
    }
  }, [load, formatMessage]);

  const startGranting = useCallback(() => setGranting(true), []);
  const cancelGranting = useCallback(() => setGranting(false), []);
  const finishGranting = useCallback(() => {
    setGranting(false);
    void load();
  }, [load]);

  const pending = items.filter((item) => item.type === "pending");
  const active = items.filter((item) => item.type === "active");

  return (
    <div className="flex-1 overflow-y-auto bg-layer-panel px-5 py-4 space-y-6 theme-brutal:bg-white">
      {error && <Banner intent="warning" density="sm" className="font-bold">{error}</Banner>}

      {pending.length > 0 && (
        <div className="space-y-3" data-testid="agent-app-pending">
          <SectionHeader label={formatMessage({ id: "agent.apps.pendingTitle" })} count={pending.length} />
          {pending.map((item) => (
            <SurfaceListItem key={item.id} className="space-y-2" interactive={false}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-bold text-foreground-strong">{item.clientName}</div>
                  <div className="text-xs text-foreground-muted">{formatShortDateTime(item.createdAt)}</div>
                </div>
                <Badge appearance="soft" variant="warning" uppercase className="text-[10px]">
                  {formatMessage({ id: "agent.apps.pending" })}
                </Badge>
              </div>
              <ScopeChips scopes={item.scopes} />
              {canManageAgentAccess && (
                <div className="flex flex-wrap gap-2">
                  <IntegrationActionButton path={`/integrations/requests/${item.id}/approve`} body={APPROVE_REQUEST_BODY} failureMessageId="agent.apps.approveFailed" onAct={act}>
                    {formatMessage({ id: "agent.apps.approve" })}
                  </IntegrationActionButton>
                  <IntegrationActionButton variant="outline" path={`/integrations/requests/${item.id}/deny`} body={EMPTY_BODY} failureMessageId="agent.apps.denyFailed" onAct={act}>
                    {formatMessage({ id: "agent.apps.deny" })}
                  </IntegrationActionButton>
                </div>
              )}
            </SurfaceListItem>
          ))}
        </div>
      )}

      <div className="space-y-3">
        <div>
          <SectionHeader
            label={formatMessage({ id: "agent.detail.applications" })}
            action={loading
              ? <span className="text-xs font-bold text-foreground-muted">{formatMessage({ id: "common.loading" })}</span>
              : canManageAgentAccess && !granting
                ? <Button variant="outline" size="sm" onClick={startGranting} className="text-[11px]">{formatMessage({ id: "agent.apps.grantAccess" })}</Button>
                : null}
          />
          <div className="mt-1 text-xs text-foreground-muted">
            {formatMessage({ id: "agent.detail.applicationsDescription" })}
          </div>
        </div>
        {granting && (
          <GrantAccessForm
            agentId={agentId}
            onCancel={cancelGranting}
            onDone={finishGranting}
          />
        )}
        {active.length === 0 ? (
          <div className="text-sm text-foreground-muted theme-brutal:text-black/50">{formatMessage({ id: "agent.detail.noConnectedApps" })}</div>
        ) : (
          <div className="space-y-3">
            {active.map((item) => (
              <SurfaceListItem key={item.id} className="space-y-2" interactive={false}>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-bold text-foreground-strong">{item.clientName}</div>
                    <div className="text-xs text-foreground-muted">{formatShortDateTime(item.createdAt)}</div>
                    {item.grantSource && (
                      <div className="text-xs text-foreground-muted">{formatMessage({ id: GRANT_SOURCE_LABEL[item.grantSource] })}</div>
                    )}
                  </div>
                  <Badge appearance="soft" variant="success" uppercase className="text-[10px]">
                    {formatMessage({ id: "agent.detail.active" })}
                  </Badge>
                </div>
                {item.clientDescription && <div className="text-sm text-foreground-muted">{item.clientDescription}</div>}
                {item.clientAgentManifestUrl && (
                  <div className="break-all font-mono text-xs text-foreground-muted">
                    {formatMessage({ id: "agent.detail.agentManifest" }, { url: item.clientAgentManifestUrl })}
                  </div>
                )}
                <ScopeChips scopes={item.scopes} />
                <div className="flex flex-wrap gap-2">
                  {canManageAgentAccess && (
                    <IntegrationActionButton variant="outline" path={`/integrations/grants/${item.id}/revoke`} body={EMPTY_BODY} failureMessageId="agent.detail.revokeIntegrationFailed" onAct={act}>
                      {formatMessage({ id: "agent.detail.revoke" })}
                    </IntegrationActionButton>
                  )}
                  {item.clientHomepageUrl && (
                    <a href={item.clientHomepageUrl} target="_blank" rel="noreferrer" className="text-xs font-bold underline text-foreground-muted self-center">
                      {formatMessage({ id: "agent.detail.viewService" })}
                    </a>
                  )}
                </div>
              </SurfaceListItem>
            ))}
          </div>
        )}
      </div>

      <AgentAppEventsSection agentId={agentId} />
    </div>
  );
}
