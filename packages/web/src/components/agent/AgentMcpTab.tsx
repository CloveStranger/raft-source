import { Input,
  Button,
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
  SelectValue, Textarea } from "raft-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import type { MessageId } from "../../i18n/messages/en";
import { Blocks, Check, FlaskConical, Plus, Trash2 } from "lucide-react";
import {
  MANAGED_MCP_OAUTH_RESULT_CHANNEL,
} from "@botiverse/raft-shared";
import type {
  ManagedMcpAgentCatalogResponse,
  ManagedMcpAuthMode,
  ManagedMcpProvider,
  ManagedMcpRecommendation,
  ManagedMcpServerView,
} from "@botiverse/raft-shared";
import api from "../../api/client";
import ConfirmDialog from "../ConfirmDialog";
import Banner from "../ui/Banner";
import DialogCard from "../ui/DialogCard";
import EmptyState from "../ui/EmptyState";
import FormField from "../ui/FormField";
import { KeyValueAddButton } from "../ui/KeyValueInput";
import SectionHeader from "../ui/SectionHeader";
import {
  buildManagedMcpCredentialPatch,
  managedMcpHeadersForCreate,
  managedMcpHeadersIncomplete,
} from "./managedMcpCredentials";
import type {
  ManagedMcpHeaderDraft,
} from "./managedMcpCredentials";
import { McpServerListItem } from "./McpServerListItem";
import { McpRecommendationItem } from "./McpRecommendationItem";
import { McpHeaderRow } from "./McpHeaderRow";

type ConnectionTestResult = { status: "testing" } | { status: "success"; toolCount: number } | { status: "error"; message: string };
export type ServerDraft = {
  id: string | null;
  name: string;
  description: string;
  provider: ManagedMcpProvider;
  authMode: ManagedMcpAuthMode;
  endpointUrl: string;
  headers: ManagedMcpHeaderDraft[];
  persistedHeaderNames: string[];
};

const EMPTY_DRAFT: ServerDraft = {
  id: null,
  name: "",
  description: "",
  provider: "custom",
  authMode: "none",
  endpointUrl: "",
  headers: [],
  persistedHeaderNames: [],
};

const PROVIDER_OPTIONS = [
  { value: "custom", labelId: "agent.mcp.provider.custom" },
  { value: "notion", labelId: "agent.mcp.provider.notion" },
  { value: "linear", labelId: "agent.mcp.provider.linear" },
] as const;

const AUTH_MODE_OPTIONS = [
  { value: "none", labelId: "agent.mcp.authMode.none" },
  { value: "headers", labelId: "agent.mcp.authMode.headers" },
  { value: "oauth", labelId: "agent.mcp.authMode.oauth" },
] as const;

function renderSelectItems(
  options: readonly { value: string; labelId: MessageId }[],
  formatMessage: IntlShape["formatMessage"],
) {
  return options.map((option) => (
    <SelectItem key={option.value} value={option.value}>
      <SelectItemText>{formatMessage({ id: option.labelId })}</SelectItemText>
      <SelectItemIndicator />
    </SelectItem>
  ));
}

function messageFor(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: { error?: unknown } } })?.response?.data;
  return typeof data?.error === "string" ? data.error : fallback;
}

export function AgentMcpTab({
  agentId,
  canManageServer,
  scope = "agent",
}: {
  agentId?: string;
  canManageServer: boolean;
  scope?: "agent" | "server";
}) {
  const { formatDate, formatMessage, formatTime } = useIntl();
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;
  const [catalog, setCatalog] = useState<ManagedMcpAgentCatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ServerDraft | null>(null);
  const [connectionTest, setConnectionTest] = useState<ConnectionTestResult | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ManagedMcpServerView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [headerSequence, setHeaderSequence] = useState(0);
  const providerSelectOptions = useMemo(
    () => PROVIDER_OPTIONS.map((option) => ({
      value: option.value,
      label: formatMessage({ id: option.labelId }),
    })),
    [formatMessage],
  );
  const authModeSelectOptions = useMemo(
    () => AUTH_MODE_OPTIONS.map((option) => ({
      value: option.value,
      label: formatMessage({ id: option.labelId }),
    })),
    [formatMessage],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (scope === "agent" && !agentId) throw new Error(formatMessageRef.current({ id: "agent.mcp.errorAgentIdRequired" }));
      const endpoint = scope === "server" ? "/mcp/servers" : `/mcp/agents/${agentId}`;
      const { data } = await api.get<ManagedMcpAgentCatalogResponse>(endpoint);
      setCatalog(data);
    } catch (loadError) {
      setError(messageFor(loadError, formatMessageRef.current({ id: "agent.mcp.errorRequestFailed" })));
    } finally {
      setLoading(false);
    }
  }, [agentId, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const refreshAfterOAuth = () => void load();
    window.addEventListener("focus", refreshAfterOAuth);
    return () => window.removeEventListener("focus", refreshAfterOAuth);
  }, [load]);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(MANAGED_MCP_OAUTH_RESULT_CHANNEL);
    const refreshAfterOAuth = (event: MessageEvent) => {
      if ((event.data as { type?: unknown } | null)?.type === MANAGED_MCP_OAUTH_RESULT_CHANNEL) void load();
    };
    channel.addEventListener("message", refreshAfterOAuth);
    return () => {
      channel.removeEventListener("message", refreshAfterOAuth);
      channel.close();
    };
  }, [load]);

  const beginAdd = useCallback(() => {
    setDraft({ ...EMPTY_DRAFT });
    setConnectionTest(null);
    setEditorError(null);
  }, []);

  const beginRecommendation = useCallback((recommendation: ManagedMcpRecommendation) => {
    const firstId = headerSequence + 1;
    setDraft({
      ...EMPTY_DRAFT,
      name: recommendation.name,
      description: recommendation.description,
      provider: recommendation.provider,
      authMode: recommendation.authMode,
      endpointUrl: recommendation.endpointUrl,
      persistedHeaderNames: [],
      headers: recommendation.credentialHeaderNames.map((name, index) => ({
        id: firstId + index, name, value: "", persistedName: null,
      })),
    });
    setConnectionTest(null);
    setEditorError(null);
    setHeaderSequence((value) => value + recommendation.credentialHeaderNames.length);
  }, [headerSequence]);

  const beginEdit = useCallback((server: ManagedMcpServerView) => {
    const firstId = headerSequence + 1;
    setDraft({
      id: server.id,
      name: server.name,
      description: server.description ?? "",
      provider: server.provider,
      authMode: server.authMode,
      endpointUrl: server.endpointUrl,
      persistedHeaderNames: server.credentialHeaderNames,
      headers: server.credentialHeaderNames.map((name, index) => ({
        id: firstId + index, name, value: "", persistedName: name,
      })),
    });
    setConnectionTest(null);
    setEditorError(null);
    setHeaderSequence((value) => value + server.credentialHeaderNames.length);
  }, [headerSequence]);

  const updateDraft = useCallback((next: ServerDraft) => {
    setDraft(next);
    setConnectionTest(null);
    setEditorError(null);
  }, []);


  const closeEditor = useCallback(() => {
    setDraft(null);
    setConnectionTest(null);
    setEditorError(null);
  }, []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    if (draft.authMode === "headers" && managedMcpHeadersIncomplete(draft.headers)) {
      setEditorError(formatMessage({ id: "agent.mcp.errorCredentialHeadersIncomplete" }));
      return;
    }
    setBusyId(draft.id ?? "new");
    setEditorError(null);
    try {
      const payload = {
        name: draft.name,
        description: draft.description || null,
        provider: draft.provider,
        authMode: draft.authMode,
        endpointUrl: draft.endpointUrl,
        ...(draft.authMode === "headers"
          ? draft.id
            ? { credentialPatch: buildManagedMcpCredentialPatch(draft.headers, draft.persistedHeaderNames) }
            : { headers: managedMcpHeadersForCreate(draft.headers) }
          : {}),
      };
      if (draft.id) await api.patch(`/mcp/servers/${draft.id}`, payload);
      else await api.post("/mcp/servers", payload);
      closeEditor();
      await load();
    } catch (saveError) {
      setEditorError(messageFor(saveError, formatMessage({ id: "agent.mcp.errorRequestFailed" })));
    } finally {
      setBusyId(null);
    }
  };

  const mutate = useCallback(async (id: string, operation: () => Promise<unknown>) => {
    setBusyId(id);
    setError(null);
    try {
      await operation();
      await load();
    } catch (mutationError) {
      setError(messageFor(mutationError, formatMessage({ id: "agent.mcp.errorRequestFailed" })));
    } finally {
      setBusyId(null);
    }
  }, [load, formatMessage]);

  const connectOAuth = useCallback(async (server: ManagedMcpServerView) => {
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    setBusyId(server.id);
    setError(null);
    try {
      const { data } = await api.post<{ authorizationUrl: string }>(`/mcp/servers/${server.id}/oauth/start`);
      if (popup) {
        popup.location.href = data.authorizationUrl;
      } else {
        window.location.assign(data.authorizationUrl);
      }
    } catch (oauthError) {
      popup?.close();
      setError(messageFor(oauthError, formatMessage({ id: "agent.mcp.errorRequestFailed" })));
    } finally {
      setBusyId(null);
    }
  }, [formatMessage]);

  const disconnectOAuth = useCallback(async (server: ManagedMcpServerView) => {
    await mutate(server.id, () => api.delete(`/mcp/servers/${server.id}/oauth`));
  }, [mutate]);

  const testDraftConnection = useCallback(async () => {
    if (!draft) return;
    setConnectionTest({ status: "testing" });
    try {
      const { data } = await api.post<{ tools: unknown[] }>("/mcp/servers/test-configuration", {
        ...(draft.id ? { mcpServerId: draft.id } : {}),
        endpointUrl: draft.endpointUrl,
        authMode: draft.authMode,
        ...(draft.authMode === "headers"
          ? draft.id
            ? { credentialPatch: buildManagedMcpCredentialPatch(draft.headers, draft.persistedHeaderNames) }
            : { headers: managedMcpHeadersForCreate(draft.headers) }
          : {}),
      });
      setConnectionTest({ status: "success", toolCount: data.tools.length });
    } catch (testError) {
      setConnectionTest({ status: "error", message: messageFor(testError, formatMessage({ id: "agent.mcp.errorRequestFailed" })) });
    }
  }, [draft, formatMessage]);

  const deleteServer = useCallback(async (server: ManagedMcpServerView) => {
    setBusyId(server.id);
    setError(null);
    try {
      await api.delete(`/mcp/servers/${server.id}`);
      await load();
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const handleProviderChange = useCallback((value: unknown) => {
    if (value == null || !draft) return;
    const provider = value as ManagedMcpProvider;
    updateDraft({
      ...draft,
      provider,
      authMode: provider === "custom" ? "none" : "oauth",
      endpointUrl: provider === "notion"
        ? "https://mcp.notion.com/mcp"
        : provider === "linear"
          ? "https://mcp.linear.app/mcp"
          : "",
      headers: [],
      persistedHeaderNames: [],
    });
  }, [draft, updateDraft]);

  const handleAuthModeChange = useCallback((value: unknown) => {
    if (value == null || !draft) return;
    const authMode = value as ManagedMcpAuthMode;
    const firstId = headerSequence + 1;
    updateDraft({
      ...draft,
      authMode,
      headers: authMode === "headers"
        ? draft.persistedHeaderNames.map((name, index) => ({
            id: firstId + index, name, value: "", persistedName: name,
          }))
        : [],
    });
    if (authMode === "headers") {
      setHeaderSequence((value) => value + draft.persistedHeaderNames.length);
    }
  }, [draft, headerSequence, updateDraft]);

  const handleDraftNameChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    if (draft) updateDraft({ ...draft, name: event.target.value });
  }, [draft, updateDraft]);

  const handleDraftEndpointChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    if (draft) updateDraft({ ...draft, endpointUrl: event.target.value });
  }, [draft, updateDraft]);

  const handleDraftDescriptionChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (draft) updateDraft({ ...draft, description: event.target.value });
  }, [draft, updateDraft]);

  const handleAddHeader = useCallback(() => {
    if (!draft) return;
    const id = headerSequence + 1;
    setHeaderSequence(id);
    updateDraft({ ...draft, headers: [...draft.headers, { id, name: "", value: "", persistedName: null }] });
  }, [draft, headerSequence, updateDraft]);

  const handleTestConnectionClick = useCallback(() => {
    void testDraftConnection();
  }, [testDraftConnection]);

  // Return the promise: ConfirmDialog awaits it for its loading state and
  // surfaces a rejected delete as the dialog error.
  const handleDeleteConfirm = useCallback(async () => {
    if (deleteTarget) await deleteServer(deleteTarget);
  }, [deleteServer, deleteTarget]);

  const handleDeleteClose = useCallback(() => {
    setDeleteTarget(null);
  }, []);

  const draftHeadersIncomplete = draft?.authMode === "headers" ? managedMcpHeadersIncomplete(draft.headers) : false;
  const visibleServers = scope === "agent"
    ? catalog?.servers.filter((server) => server.usage !== null) ?? []
    : catalog?.servers ?? [];

  return (
    <div className={scope === "server" ? "" : "flex-1 overflow-y-auto bg-layer-panel px-5 py-4 text-foreground-strong theme-brutal:bg-white theme-brutal:text-black"}>
      <div className="space-y-6">
        {error && <Banner intent="warning" density="sm" className="font-bold">{error}</Banner>}

        <section className="space-y-3">
          <div>
            <SectionHeader
              label={scope === "server"
                ? formatMessage({ id: "agent.mcp.serverTitle" })
                : formatMessage({ id: "agent.mcpUsage.title" })}
              count={visibleServers.length}
              action={
                scope === "server" && canManageServer ? (
                  <Button variant="outline" size="sm" onClick={beginAdd}>
                    <Plus size={13} /> {formatMessage({ id: "agent.mcp.addServer" })}
                  </Button>
                ) : loading ? (
                  <span className="text-xs font-bold text-foreground-muted theme-brutal:text-black/50">{formatMessage({ id: "common.loading" })}</span>
                ) : null
              }
            />
            <p className="mt-1 text-xs text-foreground-muted theme-brutal:text-black/60">
              {scope === "server"
                ? formatMessage({ id: "agent.mcp.serverDescription" })
                : formatMessage({ id: "agent.mcpUsage.description" })}
            </p>
          </div>

          {loading ? (
            <div className="font-mono text-xs text-foreground-placeholder theme-brutal:text-black/40">{formatMessage({ id: "agent.mcp.loadingServers" })}</div>
          ) : visibleServers.length > 0 ? (
            <div className="space-y-3">
              {visibleServers.map((server) => (
                <McpServerListItem
                  key={server.id}
                  server={server}
                  scope={scope}
                  canManageServer={canManageServer}
                  busyId={busyId}
                  expandedTools={expandedTools}
                  setExpandedTools={setExpandedTools}
                  connectOAuth={connectOAuth}
                  disconnectOAuth={disconnectOAuth}
                  mutate={mutate}
                  beginEdit={beginEdit}
                  onDeleteTarget={setDeleteTarget}
                  formatMessage={formatMessage}
                  formatDate={formatDate}
                  formatTime={formatTime}
                />
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<Blocks size={36} />}
              title={formatMessage({
                id: scope === "server"
                  ? "emptyState.noMcpServersTitle"
                  : "agent.mcpUsage.emptyTitle",
              })}
              description={scope === "server"
                ? formatMessage({ id: "agent.mcp.emptyServerDescription" })
                : formatMessage({ id: "agent.mcpUsage.emptyDescription" })}
              action={scope === "server" && canManageServer ? (
                <Button onClick={beginAdd}>
                  <Plus size={13} /> {formatMessage({ id: "agent.mcp.addServer" })}
                </Button>
              ) : undefined}
            />
          )}
        </section>

        {scope === "server" && canManageServer && catalog && catalog.recommendations.length > 0 && (
          <section className="space-y-3">
            <div>
              <SectionHeader label={formatMessage({ id: "agent.mcp.recommendedTitle" })} count={catalog.recommendations.length} />
              <p className="mt-1 text-xs text-foreground-muted theme-brutal:text-black/60">{formatMessage({ id: "agent.mcp.recommendedDescription" })}</p>
            </div>
            <div className="space-y-3">
              {catalog.recommendations.map((recommendation) => (
                <McpRecommendationItem
                  key={recommendation.id}
                  recommendation={recommendation}
                  added={catalog.servers.some((server) => server.provider === recommendation.provider)}
                  beginRecommendation={beginRecommendation}
                  formatMessage={formatMessage}
                />
              ))}
            </div>
          </section>
        )}
      </div>

      {scope === "server" && canManageServer && draft && (
        <DialogCard
          title={draft.id ? draft.name || formatMessage({ id: "agent.mcp.serverFallbackTitle" }) : formatMessage({ id: "agent.mcp.newServerTitle" })}
          titleId="mcp-server-form-title"
          onClose={closeEditor}
          maxWidthClass="max-w-2xl"
        >
          <form
            onSubmit={save}
            className="space-y-4"
            aria-labelledby="mcp-server-form-title"
          >
            <p className="text-xs text-foreground-muted theme-brutal:text-black/60">{formatMessage({ id: "agent.mcp.formDescription" })}</p>

            {editorError && (
              <Banner intent="warning" density="sm" className="font-bold">
                {editorError}
              </Banner>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label={formatMessage({ id: "agent.mcp.providerLabel" })} labelStyle="plain" size="compact" required>
                <Select
                  value={draft.provider}
                  disabled={draft.id !== null}
                  items={providerSelectOptions}
                  onValueChange={handleProviderChange}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={formatMessage({ id: "agent.mcp.providerLabel" })} />
                    <SelectIcon />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectList>{renderSelectItems(PROVIDER_OPTIONS, formatMessage)}</SelectList>
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label={formatMessage({ id: "agent.mcp.authenticationLabel" })} labelStyle="plain" size="compact" required>
                <Select
                  value={draft.authMode}
                  disabled={draft.provider !== "custom"}
                  items={authModeSelectOptions}
                  onValueChange={handleAuthModeChange}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={formatMessage({ id: "agent.mcp.authenticationLabel" })} />
                    <SelectIcon />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectList>{renderSelectItems(AUTH_MODE_OPTIONS, formatMessage)}</SelectList>
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label={formatMessage({ id: "agent.mcp.nameLabel" })} labelStyle="plain" size="compact" required>
                <Input required maxLength={120} className="w-full text-sm" value={draft.name} onChange={handleDraftNameChange} />
              </FormField>
              <FormField label={formatMessage({ id: "agent.mcp.serverUrlLabel" })} labelStyle="plain" size="compact" required>
                <Input required type="url" disabled={draft.provider !== "custom"} className="w-full text-sm disabled:bg-fill-muted theme-brutal:disabled:bg-gray-100" value={draft.endpointUrl} onChange={handleDraftEndpointChange} />
              </FormField>
            </div>

            <FormField label={formatMessage({ id: "agent.mcp.descriptionLabel" })} labelStyle="plain" size="compact" optional>
              <Textarea rows={2} className="resize-y text-sm" value={draft.description} onChange={handleDraftDescriptionChange} />
            </FormField>

            {draft.authMode === "oauth" && (
              <Banner intent="info" density="sm" withIcon>
                {formatMessage({ id: "agent.mcp.oauthSaveHint" })}
              </Banner>
            )}

            {draft.authMode === "headers" && (
              <FormField label={formatMessage({ id: "agent.mcp.credentialHeadersLabel" })} labelStyle="plain" size="compact" optional>
                <div className="mt-3 space-y-2">
                  {draft.headers.map((header) => (
                    <McpHeaderRow key={header.id} header={header} draft={draft} updateDraft={updateDraft} formatMessage={formatMessage} />
                  ))}
                  <KeyValueAddButton label={formatMessage({ id: "agent.mcp.addHeader" })} onClick={handleAddHeader} />
                  {draft.headers.length === 0 && (
                    <p className="text-xs text-foreground-muted theme-brutal:text-black/50">{formatMessage({ id: "agent.mcp.noCredentialHeaders" })}</p>
                  )}
                </div>
              </FormField>
            )}

            {draft.authMode !== "oauth" && <div className="flex justify-start">
              <Button
                size="sm"
                disabled={connectionTest?.status === "testing" || !draft.endpointUrl.trim() || draftHeadersIncomplete}
                onClick={handleTestConnectionClick}
              >
                <FlaskConical size={13} /> {formatMessage({ id: connectionTest?.status === "testing" ? "agent.mcp.testingConnection" : "agent.mcp.testConnection" })}
              </Button>
            </div>}

            {connectionTest?.status === "success" && (
              <Banner intent="success" density="sm" withIcon>
                {formatMessage({ id: "agent.mcp.connectionSucceeded" }, { count: connectionTest.toolCount })}
              </Banner>
            )}
            {connectionTest?.status === "error" && (
              <Banner intent="warning" density="sm" withIcon>{connectionTest.message}</Banner>
            )}

            <div className="flex items-center justify-end gap-2 border-t border-line-muted pt-4 theme-brutal:border-t-2 theme-brutal:border-black">
              <Button variant="outline" size="md" onClick={closeEditor}>{formatMessage({ id: "common.confirm.cancel" })}</Button>
              <Button type="submit" variant="success" size="md" disabled={busyId !== null}>
                <Check size={14} /> {formatMessage({ id: busyId === (draft.id ?? "new") ? "agent.mcp.saving" : "agent.mcp.save" })}
              </Button>
            </div>
          </form>
        </DialogCard>
      )}

      {scope === "server" && canManageServer && deleteTarget && (
        <ConfirmDialog
          title={formatMessage({ id: "agent.mcp.deleteDialogTitle" })}
          message={formatMessage(
            { id: "settings.mcp.deleteConfirmMessage" },
            { name: deleteTarget.name },
          )}
          confirmLabel={formatMessage({ id: "agent.mcp.deleteConfirmLabel" })}
          loadingLabel={formatMessage({ id: "agent.mcp.deleting" })}
          confirmIcon={<Trash2 size={14} />}
          onConfirm={handleDeleteConfirm}
          onClose={handleDeleteClose}
        />
      )}
    </div>
  );
}
