import { Button } from "raft-ui";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import type { Credential } from "./ExternalAgentToken";

export function CredentialRow({
  credential,
  confirming,
  pending,
  revokingId,
  onConfirmRevoke,
  onCancelRevoke,
  onStartRevoke,
}: {
  credential: Credential;
  confirming: boolean;
  pending: boolean;
  revokingId: string | null;
  onConfirmRevoke: (credentialId: string) => void;
  onCancelRevoke: () => void;
  onStartRevoke: (credentialId: string) => void;
}) {
  const { formatMessage, formatDate } = useIntl();
  const handleConfirmClick = useCallback(() => onConfirmRevoke(credential.id), [onConfirmRevoke, credential.id]);
  const handleStartClick = useCallback(() => onStartRevoke(credential.id), [onStartRevoke, credential.id]);
  return (
    <div className="min-w-0 space-y-1 rounded-md border border-line-muted p-2 text-xs theme-brutal:rounded-none theme-brutal:border-black/20">
      <p className="break-words font-bold">{credential.name || formatMessage({ id: "agent.detail.externalTokenLabel" })} <span className="break-all font-mono font-normal">{credential.maskedToken || credential.id.slice(0, 8)}</span></p>
      <p>{formatMessage({ id: "agent.detail.externalTokenCreated" }, { date: formatDate(credential.createdAt, { dateStyle: "medium", timeStyle: "short" }) })}</p>
      <p>{formatMessage({ id: credential.revokedAt ? "agent.detail.externalTokenRevoked" : "agent.detail.externalTokenActive" })}</p>
      {!credential.revokedAt && (confirming ? (
        <>
          <p>{formatMessage({ id: "agent.detail.externalTokenRevokeWarning" })}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" disabled={pending || revokingId !== null} onClick={handleConfirmClick}
              className="whitespace-normal">
              {formatMessage({ id: "agent.detail.externalTokenConfirmRevoke" })}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={revokingId !== null} onClick={onCancelRevoke}
              className="whitespace-normal">
              {formatMessage({ id: "agent.detail.externalTokenCancel" })}
            </Button>
          </div>
        </>
      ) : (
        <Button type="button" size="sm" variant="outline" disabled={pending || revokingId !== null} onClick={handleStartClick}
          className="whitespace-normal">
          {formatMessage({ id: "agent.detail.externalTokenRevoke" })}
        </Button>
      ))}
    </div>
  );
}
