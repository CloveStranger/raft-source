import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import { showToast } from "../toastBridge";
import { useDocumentPreviewStore } from "../../store/documentPreviewStore";
import { DocumentAttachmentPreviewModal } from "./attachmentPreviewSurfaces";
import { downloadAttachmentById } from "./downloadAttachment";

/**
 * Single app-level host for the document preview, mounted beside
 * <ImageLightbox />. Surfaces open it through `openDocumentPreview`; none of
 * them own the modal, so none of them can drift from it.
 *
 * Comments render only when the opener supplied a host message. A forward
 * preview shows a snapshot with no host, so it deliberately supplies none —
 * an explicit absence rather than an accident of which surface opened it.
 */
export default function DocumentPreviewHost() {
  const { formatMessage } = useIntl();
  const entry = useDocumentPreviewStore((s) => s.entry);
  const close = useDocumentPreviewStore((s) => s.close);
  // Hooks stay above the !entry early return; entry identity is stable from
  // the store selector, so these memoize on it directly.
  const onDownload = useCallback(() => {
    if (entry) void downloadAttachmentById(entry.attachment);
  }, [entry]);
  // A failed copy is reported rather than swallowed; the toast bridge keeps
  // this host renderable without a provider (its tests do exactly that).
  const onCopyError = useCallback(() => {
    showToast({ title: formatMessage({ id: "common.lightbox.copyFailed" }), type: "error" });
  }, [formatMessage]);
  const comments = useMemo(
    () => (entry?.commentContext ? {
      attachmentId: entry.attachment.id,
      filename: entry.attachment.filename,
      commentCount: entry.attachment.commentCount ?? 0,
      parentMessage: entry.commentContext.parentMessage,
    } : undefined),
    [entry],
  );
  if (!entry) return null;
  return (
    <DocumentAttachmentPreviewModal
      filename={entry.attachment.filename}
      preview={entry.preview}
      truncated={entry.truncated}
      url={entry.url}
      onClose={close}
      onDownload={onDownload}
      onCopyError={onCopyError}
      comments={comments}
    />
  );
}
