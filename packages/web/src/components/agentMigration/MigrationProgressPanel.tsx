import { useLayoutEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { Button, Step, Steps } from "raft-ui";
import type { StepStatus } from "raft-ui";
import Banner from "../ui/Banner";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import type { Machine } from "../../store/machineStore";
import { migrationNoticePresentation, migrationTargetLabel } from "./presentation";
import type { AgentMigrationNotice } from "./realtime";
import {
  MIGRATION_PROGRESS_STEPS,
  canCancelMigration,
  isActiveMigrationState,
  isCanceledMigrationState,
  isCompletedMigrationState,
  isFailedMigrationState,
  migrationProgressStep,
} from "./state";
import { MigrationErrorContent } from "./MigrationErrorContent";
import { MigrationReference } from "./MigrationReference";

export function MigrationProgressPanel({
  notice,
  machines,
  onShowCancel,
}: {
  notice: AgentMigrationNotice;
  machines: Machine[];
  onShowCancel: () => void;
}) {
  const { formatMessage } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  // Steps lie in a row only when every label fits beside the others; otherwise
  // (phones, narrow profile panels, longer translations) they stack.
  const phone = useMediaQuery("(max-width: 767px)");
  const stepsRef = useRef<HTMLOListElement>(null);
  const rowFits = useStepsRowFits(stepsRef);
  const narrow = phone || !rowFits;
  const target = migrationTargetLabel(formatMessage, machines, notice.targetMachineId);
  const presentation = migrationNoticePresentation(formatMessage, notice, machines, formatShortDateTime);
  const completed = isCompletedMigrationState(notice.state);
  const failed = isFailedMigrationState(notice.state)
    || (notice.state === "starting" && notice.failureReason === "auto_start_failed");
  const canceled = isCanceledMigrationState(notice.state);
  const active = isActiveMigrationState(notice.state);
  const currentStep = migrationProgressStep(notice);
  const cancelRequested = notice.state.startsWith("cancel_requested_");
  const stepStatus: StepStatus = completed
    ? "finish"
    : failed || notice.cancelNeedsAttention
      ? "error"
      : canceled
        ? "wait"
        : "process";
  const headerMessageId = completed
    ? "agent.detail.movedToTarget"
    : canceled
      ? "agent.detail.migrationToTargetCanceled"
      : failed || notice.cancelNeedsAttention
        ? "agent.detail.migrationToTargetNeedsAttention"
        : cancelRequested
          ? "agent.detail.cancelingMigrationToTarget"
          : active
            ? "agent.detail.movingToTarget"
            : "agent.detail.migrationToTarget";

  return (
    <section aria-label={formatMessage({ id: "agent.detail.migrationToTarget" }, { target })}>
      <div className="flex flex-col gap-3">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <h3 className="min-w-0 break-words text-sm font-bold leading-tight text-foreground-strong">
          {formatMessage({ id: headerMessageId }, { target })}
        </h3>
      </div>

      <Steps
        ref={stepsRef}
        size="sm"
        vertical={narrow}
        current={completed ? MIGRATION_PROGRESS_STEPS.length : currentStep + 1}
        status={stepStatus}
        finishLabel={formatMessage({ id: "agent.migration.stepDone" })}
        errorLabel={formatMessage({ id: "agent.migration.stepFailed" })}
        aria-label={formatMessage({ id: "agent.detail.migrationProgressToTarget" }, { target })}
      >
        {MIGRATION_PROGRESS_STEPS.map((labelId) => (
          <Step key={labelId} title={formatMessage({ id: labelId })} />
        ))}
      </Steps>

      {/* Problems keep the warning banner; normal progress is plain text. */}
      {failed || notice.cancelNeedsAttention ? (
        <Banner
          intent="warning"
          density="sm"
          title={failed || cancelRequested ? presentation.title : undefined}
          aria-live="polite"
        >
          <MigrationErrorContent presentation={presentation} />
        </Banner>
      ) : (
        <div aria-live="polite" className="text-sm text-foreground-muted">
          {cancelRequested && presentation.title ? <p className="font-bold">{presentation.title}</p> : null}
          <p>{presentation.message}</p>
        </div>
      )}
      {/* The reference is for support, so it only appears when something needs attention. */}
      {failed || notice.cancelNeedsAttention ? <MigrationReference notice={notice} /> : null}
      {active && canCancelMigration(notice) ? (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" type="button" onClick={onShowCancel}>
            {formatMessage({ id: "agent.detail.cancel" })}
          </Button>
        </div>
      ) : null}
      </div>
    </section>
  );
}

/**
 * Whether the Steps fit on one row: the labels' natural widths plus markers,
 * gaps and the minimum connectors, against the width available to the list.
 * Measured the same way in both layouts, so switching cannot oscillate.
 */
function useStepsRowFits(ref: React.RefObject<HTMLOListElement | null>): boolean {
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    const list = ref.current;
    const host = list?.parentElement;
    if (!list || !host || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const styles = getComputedStyle(list);
      const px = (name: string) => Number.parseFloat(styles.getPropertyValue(name)) || 0;
      const steps = [...list.querySelectorAll<HTMLElement>('[data-slot="step"]')];
      if (steps.length === 0) return;
      let needed = (steps.length - 1) * (px("--r-steps-connector-min-width") + 2 * px("--r-steps-connector-gap"));
      const range = document.createRange();
      // Text extent, not box width: a stacked title stretches to the row.
      const textWidth = (el: HTMLElement | null) => {
        if (!el) return 0;
        range.selectNodeContents(el);
        return range.getBoundingClientRect().width;
      };
      for (const step of steps) {
        const indicator = step.querySelector<HTMLElement>('[data-slot="step-indicator"]');
        const title = step.querySelector<HTMLElement>('[data-slot="step-title"]');
        needed += (indicator?.offsetWidth ?? 0) + px("--r-steps-gap") + textWidth(title);
      }
      setFits(needed <= host.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [ref]);
  return fits;
}
