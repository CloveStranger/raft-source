import type { runtimeFormV2SourceStatus } from "@botiverse/raft-runtime-form";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import { FieldAction } from "./RuntimeConfigFields";

/** `option_source.status` reasons → copy; an unknown reason gets the generic line. */
const RUNTIME_FORM_V2_SOURCE_REASON_MESSAGE = {
  probe_timeout: "agent.runtimeFormV2.sourceStatus.probeTimeout",
  probe_failed: "agent.runtimeFormV2.sourceStatus.probeFailed",
  missing_config: "agent.runtimeFormV2.sourceStatus.missingConfig",
  no_models: "agent.runtimeFormV2.sourceStatus.noModels",
  unsupported: "agent.runtimeFormV2.sourceStatus.unsupported",
  machine_offline: "agent.runtimeFormV2.sourceStatus.machineOffline",
} as const;

type RuntimeFormV2SourceStatusInfo = NonNullable<ReturnType<typeof runtimeFormV2SourceStatus>>;

/** A non-live source (`option_source.status`): why, and a retry when the server says it may help. */
export function RuntimeFormV2SourceStatusLine({
  status,
  sourceId,
  testId,
  onRetrySource,
  retrying,
}: {
  status: RuntimeFormV2SourceStatusInfo;
  sourceId: string;
  testId: string;
  onRetrySource?: (sourceId: string) => void;
  retrying: boolean;
}) {
  const { formatMessage } = useIntl();
  const handleRetry = useCallback(() => onRetrySource?.(sourceId), [onRetrySource, sourceId]);
  const reasonId = status.reason && status.reason in RUNTIME_FORM_V2_SOURCE_REASON_MESSAGE
    ? RUNTIME_FORM_V2_SOURCE_REASON_MESSAGE[status.reason as keyof typeof RUNTIME_FORM_V2_SOURCE_REASON_MESSAGE]
    : "agent.runtimeFormV2.sourceStatus.unknown";
  return (
    <div className="mt-2 border-l-2 border-line-muted pl-2 text-xs text-foreground-muted" data-testid={`${testId}-status`} data-source-status={status.status}>
      <p>
        {formatMessage({ id: reasonId })}
        {status.status === "fallback" ? <>{" "}{formatMessage({ id: "agent.runtimeFormV2.sourceStatus.fallback" })}</> : null}
        {status.retryable && onRetrySource ? (
          <>
            {" "}
            <FieldAction
              tone="link"
              type="button"
              onClick={handleRetry}
              disabled={retrying}
              className="font-bold text-foreground-strong underline underline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              data-testid={`${testId}-retry`}
            >
              {formatMessage({ id: "agent.runtimeFormV2.retry" })}
            </FieldAction>
          </>
        ) : null}
      </p>
    </div>
  );
}
