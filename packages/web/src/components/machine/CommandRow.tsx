import { CopyableCode, CopyableCodeAction, CopyableCodeRoot } from "raft-ui";
import Tooltip from "../ui/Tooltip";
import { useCallback } from "react";
import type { CommandStep, CopyTarget } from "./ComputerCommandGuide";

export function CommandRow({
  step,
  copied,
  onCopy,
}: {
  step: CommandStep;
  copied: boolean;
  onCopy: (target: CopyTarget) => void;
}) {
  const { target, label, command, copyAriaLabel } = step;
  const handleCopy = useCallback(() => onCopy(target), [onCopy, target]);
  return (
    <div>
      {label ? <div className="mb-1 text-xs font-bold text-foreground-muted theme-brutal:text-black/60">{label}</div> : null}
      <CopyableCodeRoot
        copied={copied}
        onCopy={handleCopy}
      >
        <CopyableCode className="min-w-0 flex-1 px-3 py-2 font-mono text-xs break-all">
          {command}
        </CopyableCode>
        <Tooltip content={copyAriaLabel}>
          <CopyableCodeAction
            aria-label={copyAriaLabel}
            className="shrink-0"
          />
        </Tooltip>
      </CopyableCodeRoot>
    </div>
  );
}
