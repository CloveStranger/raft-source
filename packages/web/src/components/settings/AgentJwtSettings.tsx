import { useCallback, useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { appAgentJwtSettingsSchema } from "@botiverse/raft-shared";
import type { AppAgentJwtSettings } from "@botiverse/raft-shared";
import { Button, Card, Switch } from "raft-ui";
import Banner from "../ui/Banner";
import api from "../../api/client";

type Props = { serverId: string | null; clientId: string | null; canManage: boolean };
type State = { settings: AppAgentJwtSettings | null; enabled: boolean; loading: boolean; saving: boolean; failed: boolean };

// A different App gets its own request/state lifetime, including pending saves.
export function AgentJwtSettings(props: Props) {
  return <AgentJwtSettingsContent key={`${props.serverId ?? "none"}:${props.clientId ?? "new"}`} {...props} />;
}

function AgentJwtSettingsContent({ serverId, clientId, canManage }: Props) {
  const { formatMessage } = useIntl();
  const [state, setState] = useState<State>(() => ({ settings: null, enabled: false, loading: clientId !== null && serverId !== null, saving: false, failed: false }));
  const { settings, enabled, loading, saving, failed } = state;
  useEffect(() => {
    if (!clientId || !serverId) return;
    let current = true;
    api.get(`/integrations/clients/${clientId}/agent-jwt`, { headers: { "X-Server-Id": serverId } }).then(({ data }) => {
      const result = appAgentJwtSettingsSchema.parse(data);
      if (current) setState({ settings: result, enabled: result.enabled, loading: false, saving: false, failed: false });
    }).catch(() => { if (current) setState((previous) => ({ ...previous, loading: false, failed: true })); });
    return () => { current = false; };
  }, [clientId, serverId]);
  const save = useCallback(async () => {
    if (!serverId || !clientId || !settings || !canManage) return;
    setState((previous) => ({ ...previous, saving: true, failed: false }));
    try {
      const { data } = await api.put(`/integrations/clients/${clientId}/agent-jwt`, { enabled }, { headers: { "X-Server-Id": serverId } });
      const result = appAgentJwtSettingsSchema.parse(data);
      setState({ settings: result, enabled: result.enabled, loading: false, saving: false, failed: false });
    } catch { setState((previous) => ({ ...previous, saving: false, failed: true })); }
  }, [canManage, clientId, enabled, serverId, settings]);
  const changeEnabled = useCallback((value: boolean) => { setState((previous) => ({ ...previous, enabled: value })); }, []);
  return (
    <Card className="space-y-3 p-3" data-testid="agent-jwt-settings">
      <div className="text-sm font-bold">{formatMessage({ id: "settings.connectedApps.agentJwt.title" })}</div>
      <p className="text-xs text-foreground-muted">{formatMessage({ id: "settings.connectedApps.agentJwt.description" })}</p>
      {!clientId ? <p className="text-xs text-foreground-muted">{formatMessage({ id: "settings.connectedApps.agentJwt.registerFirst" })}</p> : null}
      {loading ? <p className="text-xs text-foreground-muted">{formatMessage({ id: "settings.common.loading" })}</p> : null}
      {failed ? <Banner intent="warning" density="sm">{formatMessage({ id: "settings.connectedApps.agentJwt.failed" })}</Banner> : null}
      {settings ? (
        <>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>{formatMessage({ id: settings.scope === "app" ? "settings.connectedApps.agentJwt.appLabel" : "settings.connectedApps.agentJwt.installationLabel" })}</span>
            <Switch checked={enabled} onCheckedChange={changeEnabled} disabled={!canManage || saving || (!settings.canEnable && !enabled)} />
          </label>
          <p className="text-xs text-foreground-muted">{formatMessage({ id: settings.scope === "app" ? "settings.connectedApps.agentJwt.appHint" : "settings.connectedApps.agentJwt.installationHint" })}</p>
          <p className="break-words text-xs text-foreground-muted">{formatMessage({ id: "settings.connectedApps.agentJwt.audience" }, { audience: settings.audience })}</p>
          {!settings.canEnable ? <p className="text-xs text-foreground-muted">{formatMessage({ id: settings.scope === "app" ? "settings.connectedApps.agentJwt.unavailable" : "settings.connectedApps.agentJwt.publisherRequired" })}</p> : null}
          {canManage ? <Button type="button" size="sm" onClick={save} disabled={saving || enabled === settings.enabled || (enabled && !settings.canEnable)}>{formatMessage({ id: saving ? "settings.common.saving" : "settings.connectedApps.agentJwt.save" })}</Button> : null}
        </>
      ) : null}
    </Card>
  );
}
