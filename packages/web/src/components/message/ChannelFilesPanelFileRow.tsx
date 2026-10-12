import { Archive, Clock3, Download, File, FileText, Image, MapPin, Video } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import {
  Button,
  FileRow,
} from "raft-ui";
import api from "../../api/client";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import AvatarListRow from "../ui/AvatarListRow";
import AttachmentTooltip from "./attachmentTooltip";
import {
  formatChannelFileSize,
  getChannelFileType,
} from "../../utils/channelFiles";
import type {
  ChannelFileTypeFilter,
} from "../../utils/channelFiles";
import { ChannelFileOverflowMenu } from "./ChannelFileOverflowMenu";
import { ChannelFileVisual } from "./ChannelFileVisual";
import type { ChannelFileEntry } from "./ChannelFilesPanel";

export interface AttachmentUrlResponse {
  url: string;
  expiresAt: string | null;
}

export function fileTypeIcon(type: Exclude<ChannelFileTypeFilter, "all">) {
  if (type === "image") return Image;
  if (type === "video") return Video;
  if (type === "pdf") return FileText;
  if (type === "archive") return Archive;
  return File;
}

export function isPreviewableImage(file: ChannelFileEntry): boolean {
  const mimeType = file.mimeType.split(";")[0]?.trim().toLowerCase();
  if (mimeType === "image/svg+xml") return Boolean(file.thumbnailUrl);
  return mimeType?.startsWith("image/") ?? false;
}

export async function downloadAttachment(file: ChannelFileEntry) {
  const { data } = await api.get(`/attachments/${file.id}/url?disposition=attachment`);
  const link = document.createElement("a");
  link.href = data.url;
  link.download = file.filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

// Per-file row (task #709 oxlint slice): the row's click handlers close over
// `file`, so they live here — memoized per row — instead of being recreated
// as inline closures for every row on every panel render.
export function ChannelFilesPanelFileRow({
  file,
  onOpenPreview,
  onOpenSource,
}: {
  file: ChannelFileEntry;
  onOpenPreview: (file: ChannelFileEntry) => Promise<void>;
  onOpenSource: (file: ChannelFileEntry) => void;
}) {
  const { formatMessage } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  const type = getChannelFileType(file);
  const Icon = fileTypeIcon(type);
  const canPreview = isPreviewableImage(file);

  const handlePreview = useCallback(() => {
    void onOpenPreview(file);
  }, [onOpenPreview, file]);
  const handleOpenSource = useCallback(() => {
    onOpenSource(file);
  }, [onOpenSource, file]);
  const handleDownload = useCallback(() => {
    void downloadAttachment(file);
  }, [file]);
  const previewButtonProps = useMemo(
    () => ({ "aria-label": formatMessage({ id: "message.channelFilesPanel.previewFile" }) }),
    [formatMessage],
  );

  return (
    <FileRow className="contents">
    <AvatarListRow
      align="start"
      avatar={<ChannelFileVisual file={file} canPreview={canPreview} icon={Icon} />}
      name={<AttachmentTooltip content={file.filename}><span>{file.filename}</span></AttachmentTooltip>}
      subtitle={
        <>
          <span>{formatChannelFileSize(file.sizeBytes, formatMessage)}</span>
          <span className="inline-flex items-center gap-1">
            <Clock3 size={12} />
            {formatShortDateTime(file.createdAt)}
          </span>
        </>
      }
      onClick={handlePreview}
      buttonProps={previewButtonProps}
      actionContent={
        <div className="channel-file-responsive-actions" data-testid="channel-file-responsive-actions">
          <div className="channel-file-inline-actions" data-testid="channel-file-inline-actions">
            <AttachmentTooltip content={formatMessage({ id: "message.channelFilesPanel.jumpToMessage" })}>
              <Button
                onClick={handleOpenSource}
                size="icon-sm"
                variant="ghost"
                className="size-7 p-0"
                aria-label={formatMessage({ id: "message.channelFilesPanel.jumpToMessage" })}
                data-testid="channel-file-inline-jump"
              >
                <MapPin size={14} />
              </Button>
            </AttachmentTooltip>
            <AttachmentTooltip content={formatMessage({ id: "message.channelFilesPanel.downloadFile" })}>
              <Button
                onClick={handleDownload}
                size="icon-sm"
                variant="ghost"
                className="size-7 p-0"
                aria-label={formatMessage({ id: "message.channelFilesPanel.downloadFile" })}
                data-testid="channel-file-inline-download"
              >
                <Download size={14} />
              </Button>
            </AttachmentTooltip>
          </div>
          <div className="channel-file-overflow-actions">
            <ChannelFileOverflowMenu
              file={file}
              onOpenSource={handleOpenSource}
              onDownload={handleDownload}
            />
          </div>
        </div>
      }
      className="channel-file-row"
    />
    </FileRow>
  );
}
