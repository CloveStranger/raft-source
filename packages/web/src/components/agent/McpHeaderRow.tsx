import type { IntlShape } from "react-intl";
import { KeyValueInputRow } from "../ui/KeyValueInput";
import { useCallback } from "react";
import type { ServerDraft } from "./AgentMcpTab";

type McpHeaderRowProps = {
  header: ServerDraft["headers"][number];
  draft: ServerDraft;
  updateDraft: (next: ServerDraft) => void;
  formatMessage: IntlShape["formatMessage"];
};

export function McpHeaderRow({ header, draft, updateDraft, formatMessage }: McpHeaderRowProps) {
  const handleKeyChange = useCallback((value: string) => {
    updateDraft({ ...draft, headers: draft.headers.map((item) => item.id === header.id ? { ...item, name: value } : item) });
  }, [draft, header.id, updateDraft]);

  const handleValueChange = useCallback((value: string) => {
    updateDraft({ ...draft, headers: draft.headers.map((item) => item.id === header.id ? { ...item, value } : item) });
  }, [draft, header.id, updateDraft]);

  const handleRemove = useCallback(() => {
    updateDraft({ ...draft, headers: draft.headers.filter((item) => item.id !== header.id) });
  }, [draft, header.id, updateDraft]);

  return (
    <KeyValueInputRow
  keyValue={header.name}
  value={header.value}
  valueType="password"
  keyRequired
  valueRequired={header.persistedName === null || header.name.trim().toLowerCase() !== header.persistedName.toLowerCase()}
  keyPlaceholder={formatMessage({ id: "agent.mcp.authorizationPlaceholder" })}
  valuePlaceholder={header.persistedName && header.name.trim().toLowerCase() === header.persistedName.toLowerCase() ? "••••••••" : formatMessage({ id: "agent.mcp.bearerPlaceholder" })}
  keyLabel={formatMessage({ id: "agent.mcp.headerNameLabel" })}
  valueLabel={formatMessage({ id: "agent.mcp.headerValueLabel" }, { name: header.name || formatMessage({ id: "agent.mcp.credentialHeaderFallback" }) })}
  removeLabel={formatMessage({ id: "agent.mcp.removeHeader" })}
  onKeyChange={handleKeyChange}
  onValueChange={handleValueChange}
  onRemove={handleRemove}

    />
  );
}
