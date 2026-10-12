import { useCallback } from "react";
import { FileUp, X } from "lucide-react";
import { useIntl } from "react-intl";
import type { RecoveryView } from "../../utils/directAttachmentUpload";
import { Button } from "raft-ui";
import Tooltip from "../ui/Tooltip";

export function ActiveUploadRow({
  upload,
  cancelBusy,
  onOpenChannel,
  onCancel,
}: {
  upload: RecoveryView;
  cancelBusy: boolean;
  onOpenChannel: () => void;
  onCancel: (uploadId: string) => void;
}) {
  const { formatMessage } = useIntl();
  const { uploadId } = upload;
  const handleCancel = useCallback(() => onCancel(uploadId), [onCancel, uploadId]);

  return (
    <li
      className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-line-muted pt-2 first:border-t-0 first:pt-0 theme-brutal:border-black/20"
      data-testid={`channel-settings-joint-upload-${uploadId}`}
    >
      <Tooltip content={upload.filename}>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-xs font-bold">
          <FileUp size={14} aria-hidden="true" className="shrink-0" />
          <span className="truncate">{upload.filename}</span>
        </span>
      </Tooltip>
      <div className="flex shrink-0 flex-wrap justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onOpenChannel}
          data-testid={`channel-settings-joint-upload-open-${uploadId}`}
        >
          {formatMessage({ id: "channel.edit.continueUpload" })}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleCancel}
          disabled={cancelBusy}
          data-testid={`channel-settings-joint-upload-cancel-${uploadId}`}
        >
          <X size={14} aria-hidden="true" />
          {cancelBusy
            ? formatMessage({ id: "channel.edit.cancelingUpload" })
            : formatMessage({ id: "channel.edit.cancelUpload" })}
        </Button>
      </div>
    </li>
  );
}
