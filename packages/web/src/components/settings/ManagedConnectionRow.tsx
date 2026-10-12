import { useCallback } from "react";
import { useIntl } from "react-intl";
import type {
  ProviderConnectionProviderOption,
  ProviderConnectionSummary,
} from "@botiverse/raft-shared";
import api from "../../api/client";
import { ConnectionRow } from "./ProviderConnectionsSettings";

/** Binds the catalog-level actions to one connection so each row's callbacks stay stable. */
export function ManagedConnectionRow({
  connection,
  providerOptions,
  canManage,
  legacyTestVisible,
  busy,
  run,
  onTestConnection,
  onEditConnection,
  onVerifyConnection,
  onOpenAgent,
}: {
  connection: ProviderConnectionSummary;
  providerOptions: ProviderConnectionProviderOption[];
  canManage: boolean;
  legacyTestVisible: boolean;
  busy: boolean;
  run: (id: string, action: () => Promise<unknown>) => Promise<void>;
  onTestConnection: (connection: ProviderConnectionSummary) => void;
  onEditConnection: (connection: ProviderConnectionSummary) => void;
  onVerifyConnection: (connection: ProviderConnectionSummary) => void;
  onOpenAgent: (agentId: string) => void;
}) {
  const { formatMessage } = useIntl();
  const handleTest = useCallback(() => onTestConnection(connection), [connection, onTestConnection]);
  const handleEdit = useCallback(() => onEditConnection(connection), [connection, onEditConnection]);
  const handleVerify = useCallback(() => onVerifyConnection(connection), [connection, onVerifyConnection]);
  const handleToggle = useCallback(() => {
    void run(connection.id, () => api.patch(`/provider-connections/${connection.id}`, { enabled: !connection.enabled }));
  }, [connection.enabled, connection.id, run]);
  const handleDetachAgent = useCallback(
    (agentId: string) => run(connection.id, () => api.delete(`/provider-connections/${connection.id}/agents/${agentId}`)),
    [connection.id, run],
  );
  const handleDelete = useCallback(() => {
    if (window.confirm(formatMessage({ id: "settings.providers.deleteConfirm" }, { name: connection.name }))) {
      void run(connection.id, () => api.delete(`/provider-connections/${connection.id}`));
    }
  }, [connection.id, connection.name, formatMessage, run]);

  return (
    <ConnectionRow
      connection={connection}
      providerOptions={providerOptions}
      canManage={canManage}
      legacyTestVisible={legacyTestVisible}
      busy={busy}
      onTest={handleTest}
      onEdit={handleEdit}
      onToggle={handleToggle}
      onOpenAgent={onOpenAgent}
      onVerify={handleVerify}
      onDetachAgent={handleDetachAgent}
      onDelete={handleDelete}
    />
  );
}
