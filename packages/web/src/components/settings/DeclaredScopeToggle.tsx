import { Checkbox } from "raft-ui";
import Tooltip from "../ui/Tooltip";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import { OAUTH_SCOPE_PRESENTATION } from "../../lib/oauthScopePresentation";
import type { RaftOAuthScopeId } from "../../lib/oauthScopePresentation";

export function DeclaredScopeToggle({
  scope,
  checked,
  className,
  onScopeChange,
}: {
  scope: RaftOAuthScopeId;
  checked: boolean;
  className: string;
  onScopeChange: (scope: RaftOAuthScopeId, checked: boolean) => void;
}) {
  const { formatMessage } = useIntl();
  const handleCheckedChange = useCallback((next: boolean) => onScopeChange(scope, next), [onScopeChange, scope]);
  return (
    <Tooltip content={formatMessage({ id: OAUTH_SCOPE_PRESENTATION[scope].copyId })}>
    <label className={className}>
      <Checkbox
        size="sm"
        checked={checked}
        onCheckedChange={handleCheckedChange}
      />
      <span>{scope}</span>
    </label>
    </Tooltip>
  );
}
