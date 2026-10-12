// The Slack OAuth callback sends the installer back to the IM bridges settings
// page. On failure it appends `slack_oauth=error`, an allowlisted `code`, and
// for some codes a diagnostic `reason` / `provider_error` (see
// packages/server/src/routes/slackBridge.ts redirectOAuthOutcome). This maps
// them to a message the page can show, and strips them from the URL so a
// refresh does not show the same failure again.

import type { MessageId } from "../../i18n/messages/en";

export const SLACK_OAUTH_RETURN_PARAMS = ["slack_oauth", "code", "reason", "provider_error"] as const;

export interface SlackOAuthReturnError {
  messageId: MessageId;
  /** Echoed into the generic message so support can match it to server logs. */
  code: string;
}

export function readSlackOAuthReturnError(search: string): SlackOAuthReturnError | null {
  const params = new URLSearchParams(search);
  if (params.get("slack_oauth") !== "error") return null;
  const code = params.get("code") ?? "unknown";
  switch (code) {
    case "slack_oauth_provider_rejected":
      return { messageId: "settings.slackBridge.oauthReturn.cancelled", code };
    case "slack_oauth_retryable":
      return { messageId: "settings.slackBridge.oauthReturn.retryable", code };
    case "slack_oauth_reconciliation_required":
      return { messageId: "settings.slackBridge.oauthReturn.unconfirmed", code };
    case "slack_oauth_identity_conflict":
      return { messageId: "settings.slackBridge.oauthReturn.identityConflict", code };
    default:
      return { messageId: "settings.slackBridge.oauthReturn.failed", code };
  }
}

/** The same search string without the OAuth return params ("" when none remain). */
export function stripSlackOAuthReturnParams(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of SLACK_OAUTH_RETURN_PARAMS) params.delete(key);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}
