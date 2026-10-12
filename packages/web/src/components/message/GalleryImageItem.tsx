import { useCallback } from "react";
import { useIntl } from "react-intl";
import { Download } from "lucide-react";
import {
  MessageImageGalleryAction,
  MessageImageGalleryItem,
  MessageImageGalleryOverlay,
  MessageImageGalleryPreview,
  Spinner,
} from "raft-ui";
import type { MessageImageGalleryItemLayout } from "raft-ui";
import Tooltip from "../ui/Tooltip";
import type { Message } from "../../store/messageStore";
import { useImageLightboxStore } from "../../store/imageLightboxStore";

/** Image-gallery tile — owns its open/download closures so the gallery map
    passes only stable references (task #709 react-perf). */
export function GalleryImageItem({
  att,
  previewSrc,
  isOptimistic,
  imageIndex,
  lightboxImages,
  layout,
  onDownload,
}: {
  att: NonNullable<Message["attachments"]>[number];
  previewSrc: string;
  isOptimistic: boolean;
  imageIndex: number;
  lightboxImages: NonNullable<Message["attachments"]>[number][];
  layout: MessageImageGalleryItemLayout;
  onDownload: (attachment: NonNullable<Message["attachments"]>[number]) => void | Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const handleOpenImage = useCallback(() => {
    if (!isOptimistic && imageIndex >= 0) {
      // Image comments are descoped for now (cindyz 6/11): no comment
      // contexts → the lightbox renders no comment affordance.
      useImageLightboxStore.getState().open(lightboxImages, imageIndex);
    }
  }, [isOptimistic, imageIndex, lightboxImages]);
  const handleDownloadImage = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void onDownload(att);
  }, [onDownload, att]);
  return (
    <Tooltip content={att.filename}>
    <MessageImageGalleryItem
      className="bg-brutal-cream/60"
      layout={layout}
    >
      <img
        src={previewSrc}
        alt={att.filename}
        data-select-screenshot-attachment-id={att.id}
        data-select-screenshot-attachment-width={att.width ?? undefined}
        data-select-screenshot-attachment-height={att.height ?? undefined}
        width={att.width ?? undefined}
        height={att.height ?? undefined}
        loading="lazy"
      />
      {isOptimistic && (
        <MessageImageGalleryOverlay>
          <Spinner size="md" variant="inverse" aria-label={formatMessage({ id: "common.loadingLabel" })} />
        </MessageImageGalleryOverlay>
      )}
      {!isOptimistic && (
        <MessageImageGalleryPreview
          onClick={handleOpenImage}
          aria-label={formatMessage({ id: "message.messageItem.previewFile" }, { filename: att.filename })}
        />
      )}
      {!isOptimistic && (
        <MessageImageGalleryAction
          onClick={handleDownloadImage}
          data-message-affordance="image-download"
          aria-label={formatMessage({ id: "message.messageItem.downloadFile" }, { filename: att.filename })}
        >
          <Download size={12} />
        </MessageImageGalleryAction>
      )}
    </MessageImageGalleryItem>
    </Tooltip>
  );
}
