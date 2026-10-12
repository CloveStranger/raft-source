import { useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { Badge, Button } from "raft-ui";
import Banner from "../ui/Banner";
import SectionEyebrow from "../ui/SectionEyebrow";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useAgentStore } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import { useMachineStore } from "../../store/machineStore";
import { useServerStore } from "../../store/serverStore";
import { agentMigrationRequiresUpgrade } from "./billing";
import { migrationStatusErrorPresentation } from "./presentation";
import { canCancelMigration, isActiveMigrationState, isCanceledMigrationState, isCompletedMigrationState, isFailedMigrationState } from "./state";
import { useAgentMigrationStatus } from "./useAgentMigrationStatus";
import { useAgentMigrationUiEnabled } from "./useAgentMigrationUiEnabled";
import { AgentMigrationCancelDialog } from "./AgentMigrationCancelDialog";
import { AgentMigrationDialog } from "./AgentMigrationDialog";
import { AgentMigrationUpgradeDialog } from "./AgentMigrationUpgradeDialog";
import { MigrationErrorContent } from "./MigrationErrorContent";
import { MigrationProgressPanel } from "./MigrationProgressPanel";

/**
 * Move-to-another-computer action, live progress, and its dialogs. The caller
 * mounts this only where the viewer can manage a non-external agent.
 */
export function AgentMigrationSection({ agent }: { agent: Agent }) {
  const { formatMessage } = useIntl();
  const nav = useAppNavigate();
  const machines = useMachineStore((s) => s.machines);
  const billing = useServerStore((s) => s.billing);
  const loadingBilling = useServerStore((s) => s.loadingBilling);
  const loadBilling = useServerStore((s) => s.loadBilling);
  const uiEnabled = useAgentMigrationUiEnabled();
  const enabled = uiEnabled && Boolean(agent.machineId);
  const [showDialog, setShowDialog] = useState(false);
  const [showUpgradeDialog, setShowUpgradeDialog] = useState(false);
  const [showCancel, setShowCancel] = useState(false);

  const presentStatusError = useCallback(
    (error: { code?: string; message?: string }) => migrationStatusErrorPresentation(error, formatMessage),
    [formatMessage],
  );
  const { model, error: statusError, refresh } = useAgentMigrationStatus({
    agentId: agent.id,
    enabled,
    presentError: presentStatusError,
  });
  const notice = model.migration?.agentId === agent.id ? model.migration : null;
  const active = notice ? isActiveMigrationState(notice.state) : false;
  const canRetry = notice ? isFailedMigrationState(notice.state) : false;
  const requiresUpgrade = agentMigrationRequiresUpgrade(billing?.plan);
  const billingChecking = billing == null && loadingBilling;

  useEffect(() => {
    if (!enabled) return;
    void loadBilling();
  }, [enabled, loadBilling]);

  // A completed migration moves the agent to another computer, but no agent
  // update is broadcast for it. When this view watched the migration finish,
  // re-read agents once so the Computer row and sidebar grouping follow it.
  const loadAgents = useAgentStore((s) => s.loadAgents);
  const watchedActiveRef = useRef<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    if (isActiveMigrationState(notice.state)) {
      watchedActiveRef.current = notice.migrationRef;
    } else if (isCompletedMigrationState(notice.state) && watchedActiveRef.current === notice.migrationRef) {
      watchedActiveRef.current = null;
      void loadAgents();
    }
  }, [notice, loadAgents]);

  const openMigration = useCallback(() => {
    if (requiresUpgrade) {
      setShowUpgradeDialog(true);
      return;
    }
    setShowDialog(true);
  }, [requiresUpgrade]);
  const showCancelDialog = useCallback(() => setShowCancel(true), []);
  const closeCancelDialog = useCallback(() => setShowCancel(false), []);
  const closeMigrationDialog = useCallback(() => setShowDialog(false), []);
  const closeUpgradeDialog = useCallback(() => setShowUpgradeDialog(false), []);
  const handleProRequired = useCallback(() => {
    setShowDialog(false);
    setShowUpgradeDialog(true);
    void loadBilling();
  }, [loadBilling]);
  const handleMigrationStarted = useCallback(async () => {
    setShowDialog(false);
    await refresh();
  }, [refresh]);
  const viewPlans = useCallback(() => nav.toSettings("billing"), [nav]);

  if (!enabled) return null;

  return (
    <section
      aria-labelledby="agent-migration-section-title"
      className="px-5 py-4 border-t border-line-muted theme-brutal:border-black/10"
      data-testid="agent-migration-section"
    >
      <div className="flex items-center gap-2">
        <h3 id="agent-migration-section-title">
          <SectionEyebrow>{formatMessage({ id: "agent.migration.sectionTitle" })}</SectionEyebrow>
        </h3>
        {/* Migration is a Pro feature; on other plans Migrate opens the upgrade prompt. */}
        <Badge variant="accent" data-testid="agent-migration-pro-badge">
          {formatMessage({ id: "billing.pro" })}
        </Badge>
      </div>
      {/* What migration does matters before one exists; once a migration is shown, its block says it. */}
      {notice && !isCompletedMigrationState(notice.state) && !isCanceledMigrationState(notice.state) ? null : (
        <p className="mt-1 text-xs font-normal text-foreground-muted">
          {formatMessage({ id: "agent.migration.sectionDescription" })}
        </p>
      )}
      {notice ? (
        <div className="mt-3">
          <MigrationProgressPanel
            notice={notice}
            machines={machines}
            onShowCancel={showCancelDialog}
          />
        </div>
      ) : null}
      {statusError ? (
        <Banner
          intent="warning"
          density="sm"
          className="mt-3"
          title={formatMessage({ id: "agent.detail.migrationStatusUnavailable" })}
        >
          <MigrationErrorContent presentation={statusError} />
        </Banner>
      ) : null}
      {/* While a migration runs, the progress block owns the only action (Cancel). */}
      {active ? null : (
        <div className="mt-3 flex justify-end">
          <Button variant="outline" size="sm"
            type="button"
            onClick={openMigration}
            disabled={billingChecking}
            aria-busy={billingChecking}
          >
            {canRetry
              ? formatMessage({ id: "agent.detail.tryMigrationAgain" })
              : formatMessage({ id: "agent.detail.startMigration" })}
          </Button>
        </div>
      )}

      {showDialog && (
        <AgentMigrationDialog
          agent={agent}
          machines={machines}
          sourceMachineId={agent.machineId ?? null}
          onClose={closeMigrationDialog}
          onProRequired={handleProRequired}
          onStarted={handleMigrationStarted}
        />
      )}

      {showUpgradeDialog && (
        <AgentMigrationUpgradeDialog
          onClose={closeUpgradeDialog}
          onViewPlans={viewPlans}
        />
      )}

      {showCancel && notice && canCancelMigration(notice) && (
        <AgentMigrationCancelDialog
          agentId={agent.id}
          notice={notice}
          machines={machines}
          onClose={closeCancelDialog}
          onRefresh={refresh}
        />
      )}
    </section>
  );
}
