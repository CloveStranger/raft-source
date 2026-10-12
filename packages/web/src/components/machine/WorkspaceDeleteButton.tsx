import { Button } from "raft-ui";
import Tooltip from "../ui/Tooltip";
import { Trash2 } from "lucide-react";
import { useCallback } from "react";
import { useIntl } from "react-intl";

export function WorkspaceDeleteButton({
  directoryName,
  onRequestDelete,
}: {
  directoryName: string;
  onRequestDelete: (directoryName: string) => void;
}) {
  const { formatMessage } = useIntl();
  const handleClick = useCallback(() => onRequestDelete(directoryName), [directoryName, onRequestDelete]);
  return (
    <Tooltip content={formatMessage({ id: "machine.detail.deleteWorkspace" })}>
    <Button size="sm"
      variant="danger"
      onClick={handleClick}
      className="shrink-0 p-1"
      aria-label={formatMessage({ id: "machine.detail.deleteWorkspace" })}
    >
      <Trash2 size={12} />
    </Button>
    </Tooltip>
  );
}
