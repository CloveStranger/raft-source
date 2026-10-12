import { useEffect, useState } from "react";
import api from "../../api/client";
import { imageGalleryBackgroundClass } from "../../utils/imagePreviewStyles";
import { AttachmentTypeBadge } from "./AttachmentTypeBadge";
import type { ChannelFileEntry } from "./ChannelFilesPanel";
import type { AttachmentUrlResponse, fileTypeIcon } from "./ChannelFilesPanelFileRow";

function imageFitClass(file: ChannelFileEntry): string {
  if (!file.width || !file.height || file.width <= 0 || file.height <= 0) return "object-cover";
  const ratio = file.width / file.height;
  return ratio >= 2.2 || ratio <= 0.55 ? "object-contain" : "object-cover";
}

export function ChannelFileVisual({
  file,
  canPreview,
  icon: Icon,
}: {
  file: ChannelFileEntry;
  canPreview: boolean;
  icon: ReturnType<typeof fileTypeIcon>;
}) {
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const src = file.thumbnailUrl || fallbackUrl;

  // Async-loader pattern: when `file.id` or `canPreview` changes, reset the
  // fallback URL and (if the file lacks a `thumbnailUrl`) async-fetch a
  // presigned URL. The cascading reset+fetch is intended — a different file
  // needs a different presigned URL. Same family as PR #2530's async-loader
  // FPs. Listed all 3 sister rules per @铁根 msg=2e922c7d broaden strategy.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    let cancelled = false;
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setFallbackUrl(null);
    if (!canPreview || file.thumbnailUrl) return () => {
      cancelled = true;
    };

    api
      .get<AttachmentUrlResponse>(`/attachments/${file.id}/url`)
      .then(({ data }) => {
        if (!cancelled) setFallbackUrl(data.url);
      })
      .catch(() => {
        if (!cancelled) setFallbackUrl(null);
      });

    return () => {
      cancelled = true;
    };
  }, [canPreview, file.id, file.thumbnailUrl]);

  return (
    <span className="relative flex size-14 shrink-0 items-center justify-center overflow-hidden border border-line-muted bg-layer-card theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white">
      {canPreview && src ? (
        <img
          src={src}
          alt=""
          className={`block h-full w-full ${imageFitClass(file)} ${imageGalleryBackgroundClass}`}
          loading="lazy"
        />
      ) : (
        <Icon size={18} />
      )}
      <AttachmentTypeBadge
        filename={file.filename}
        data-message-affordance="channel-file-type-badge"
        className="!absolute bottom-0 left-0"
      />
    </span>
  );
}
