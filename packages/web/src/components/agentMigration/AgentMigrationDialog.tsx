import { useCallback, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useIntl } from "react-intl";
import {
  Banner,
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  buttonVariants,
  useTheme,
} from "raft-ui";
import { ExternalLink } from "lucide-react";
import { ComboboxSelect } from "raft-ui/wip";
import api from "../../api/client";
import { useServerStore } from "../../store/serverStore";
import type { Agent } from "../../store/agentStore";
import type { Machine } from "../../store/machineStore";
import { isMigrationProPlanRequiredError } from "./billing";
import type { MigrationErrorPresentation } from "./errors";
import { migrationStartErrorPresentation } from "./presentation";
import { MigrationErrorContent } from "./MigrationErrorContent";

interface MigrationStartResponse {
  migrationRef: string;
  state: string;
  sourceMachineId: string;
  targetMachineId: string;
  deadlines?: Record<string, string>;
}

export function AgentMigrationDialog({
  agent,
  machines,
  sourceMachineId,
  onClose,
  onProRequired,
  onStarted,
}: {
  agent: Agent;
  machines: Machine[];
  sourceMachineId: string | null;
  onClose: () => void;
  onProRequired: () => void;
  onStarted: (result: MigrationStartResponse) => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const serverSlug = useServerStore((state) => state.current?.slug);
  const targetComputers = useMemo(() =>
    machines.filter((machine) =>
      machine.id !== sourceMachineId &&
      machine.isComputer === true
    ),
  [machines, sourceMachineId]);
  const targetComputerOptions = useMemo(() =>
    targetComputers.map((machine) => ({ value: machine.id, label: machine.name })),
  [targetComputers]);
  const [targetComputer, setTargetComputer] = useState(targetComputers[0]?.id ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<MigrationErrorPresentation | null>(null);
  const selectedTargetComputer = targetComputers.some((machine) => machine.id === targetComputer)
    ? targetComputer
    : targetComputers[0]?.id ?? "";
  const sourceComputerName = machines.find((machine) => machine.id === sourceMachineId)?.name;
  const targetComputerName = machines.find((machine) => machine.id === selectedTargetComputer)?.name;
  const recoveryComputerId = error?.recoveryComputerId;

  const handleTargetComputerChange = useCallback((value: string | number | null) => {
    if (value == null) return;
    setTargetComputer(String(value));
  }, []);
  // Recovery happens on the Computers page; open it in a new tab so this
  // dialog (and the chosen target) stays put for the retry.
  // A real anchor (new tab) dressed as raft-ui's link button, so it reads as
  // a quiet text link in every theme instead of a primary-colored hyperlink.
  const { theme } = useTheme();
  const recoveryLinkClassName = buttonVariants({ theme, variant: "link", size: "inline" })
    .root({ className: "w-fit gap-1 text-sm" });
  const recoveryComputersHref = serverSlug
    ? `/s/${serverSlug}/${recoveryComputerId ? `computer/${recoveryComputerId}` : "computers"}`
    : null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTargetComputer) return;
    setSubmitting(true);
    setError(null);
    try {
      const { data } = await api.post<MigrationStartResponse>(`/agents/${agent.id}/migrate`, {
        targetComputer: selectedTargetComputer,
      });
      await onStarted(data);
    } catch (err: unknown) {
      if (isMigrationProPlanRequiredError(err)) {
        onProRequired();
        return;
      }
      setError(migrationStartErrorPresentation(err, formatMessage, {
        sourceComputerName,
        targetComputerName,
        sourceComputerId: sourceMachineId,
        targetComputerId: selectedTargetComputer,
      }));
    } finally {
      setSubmitting(false);
    }
  }

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open && !submitting) onClose();
  }, [onClose, submitting]);

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      {/* Size follows the viewport: width about a third of it (28–40rem), both
          axes capped at 90% with a 16–32px gutter, no fixed height. raft-ui's
          DialogBody scrolls and the header/footer stay pinned when it overflows. */}
      <DialogContent
        className="w-[calc(100%_-_2*clamp(16px,3vw,32px))] max-w-[min(90vw,clamp(28rem,32vw,40rem))] max-h-[min(90dvh,calc(100dvh_-_2*clamp(16px,3vh,32px)))]"
        aria-busy={submitting}
      >
        <form onSubmit={handleSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>{formatMessage({ id: "agent.detail.moveToAnotherComputer" })}</DialogTitle>
            <DialogClose disabled={submitting} aria-label={formatMessage({ id: "common.close" })} />
          </DialogHeader>
          <DialogBody className="grid gap-4 font-normal">
            <Field>
              <FieldLabel id="agent-migration-target-computer-label">
                {formatMessage({ id: "agent.detail.targetComputer" })}
              </FieldLabel>
              <ComboboxSelect
                aria-labelledby="agent-migration-target-computer-label"
                options={targetComputerOptions}
                value={selectedTargetComputer || null}
                onValueChange={handleTargetComputerChange}
                disabled={submitting || targetComputers.length === 0}
                placeholder={formatMessage({ id: "agent.detail.noOtherAttachedComputer" })}
                emptyContent={formatMessage({ id: "ui.selectionPopover.emptyLabel" })}
                showArrow
                autoHighlight
              />
            </Field>
            {/* The one choice first; what happens next follows as plain theme-token text. */}
            <div className="space-y-2 text-sm leading-relaxed text-foreground-strong">
              <p>{formatMessage({ id: "agent.detail.migrationModeStopBeforeExport" })}</p>
              <p>{formatMessage({ id: "agent.detail.migrationSessionResetDetailed" })}</p>
            </div>
            {error ? (
              <Banner status="warning" size="sm" role="alert">
                <MigrationErrorContent presentation={error} />
              </Banner>
            ) : null}
            {error?.recovery === "open_computers_and_retry" && recoveryComputersHref ? (
              <a
                href={recoveryComputersHref}
                target="_blank"
                rel="noopener noreferrer"
                className={recoveryLinkClassName}
              >
                {formatMessage({
                  id: recoveryComputerId
                    ? "agent.migration.error.openComputerSettings"
                    : "agent.migration.error.openComputers",
                })}
                <ExternalLink size={14} aria-hidden="true" />
              </a>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" size="md"
              type="button"
              onClick={onClose}
              disabled={submitting}
            >
              {formatMessage({ id: "agent.detail.cancel" })}
            </Button>
            <Button variant="accent" size="md"
              type="submit"
              disabled={submitting || !selectedTargetComputer}
            >
              {submitting
                ? formatMessage({ id: "agent.detail.starting" })
                : error?.recovery === "open_computers_and_retry"
                  ? formatMessage({ id: "agent.migration.error.tryAgain" })
                  : formatMessage({ id: "agent.detail.startMigration" })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
