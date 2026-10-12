import { Paperclip } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { UIEvent } from "react";
import { useIntl } from "react-intl";
import {
  Button,
  FilesList,
  FilesPanel,
  FilesViewport,
} from "raft-ui";
import api from "../../api/client";
import type { Channel } from "../../store/channelStore";
import type { MessageAttachment } from "../../store/messageStore";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useImageLightboxStore } from "../../store/imageLightboxStore";
import EmptyState from "../ui/EmptyState";
import {
  isAudioPreviewAttachment,
  isDocumentPreviewAttachment,
  isHtmlPreviewAttachment,
  isVideoPreviewAttachment,
} from "./attachmentPreview";
import { openDocumentPreview } from "./openDocumentPreview";
import { openMediaPreview } from "./openMediaPreview";
import {
  ChannelFilesPanelFileRow,
  downloadAttachment,
  isPreviewableImage,
} from "./ChannelFilesPanelFileRow";
import type { AttachmentUrlResponse } from "./ChannelFilesPanelFileRow";

export interface ChannelFileEntry {
  id: string;
  messageId: string;
  channelId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
  thumbnailUrl?: string | null;
  createdAt: string;
  uploader: {
    type: "user" | "agent" | "external_projection";
    id: string;
    name: string | null;
    displayName: string | null;
  };
  source: {
    type: "channel" | "thread";
    channelId: string;
    parentMessageId: string | null;
    parentMessageShortId: string | null;
  };
}

interface ChannelFilesResponse {
  files: ChannelFileEntry[];
  nextCursor: string | null;
}

const FILES_PAGE_SIZE = 50;

function fileToMessageAttachment(file: ChannelFileEntry): MessageAttachment {
  return {
    id: file.id,
    filename: file.filename,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    width: file.width ?? null,
    height: file.height ?? null,
    thumbnailUrl: file.thumbnailUrl ?? null,
  };
}

export default function ChannelFilesPanel({ channel }: { channel: Channel }) {
  const { formatMessage } = useIntl();
  const nav = useAppNavigate();
  const loadingMoreRef = useRef(false);
  const [files, setFiles] = useState<ChannelFileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadFilesPage = useCallback(async (cursor: string | null, mode: "reset" | "append") => {
    if (mode === "append") {
      if (!cursor || loadingMoreRef.current) return;
      loadingMoreRef.current = true;
      setLoadingMore(true);
    } else {
      setLoading(true);
      setNextCursor(null);
    }
    setError(null);
    try {
      const { data } = await api.get<ChannelFilesResponse>(`/channels/${channel.id}/files`, {
        params: { limit: FILES_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
      });
      const nextFiles = data.files ?? [];
      setFiles((prev) => mode === "append" ? [...prev, ...nextFiles] : nextFiles);
      setNextCursor(data.nextCursor ?? null);
    } catch {
      setError(formatMessage({ id: mode === "append"
        ? "message.channelFilesPanel.loadMoreError"
        : "message.channelFilesPanel.loadError" }));
    } finally {
      if (mode === "append") {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      } else {
        setLoading(false);
      }
    }
  }, [channel.id, formatMessage]);

  useEffect(() => {
    let cancelled = false;
    const loadInitial = async () => {
      setLoading(true);
      setError(null);
      setNextCursor(null);
      try {
        const { data } = await api.get<ChannelFilesResponse>(`/channels/${channel.id}/files`, {
          params: { limit: FILES_PAGE_SIZE },
        });
        if (cancelled) return;
        setFiles(data.files ?? []);
        setNextCursor(data.nextCursor ?? null);
      } catch {
        if (!cancelled) setError(formatMessage({ id: "message.channelFilesPanel.loadError" }));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void loadInitial();
    return () => {
      cancelled = true;
    };
  }, [channel.id, formatMessage]);

  const handleScroll = useCallback((target: HTMLDivElement) => {
    if (!nextCursor || loading || loadingMore) return;
    if (target.scrollHeight - target.scrollTop - target.clientHeight < 320) {
      void loadFilesPage(nextCursor, "append");
    }
  }, [loadFilesPage, loading, loadingMore, nextCursor]);

  const openSource = useCallback((file: ChannelFileEntry) => {
    if (file.source.type === "thread" && file.source.parentMessageId) {
      nav.toThreadMessage(channel.id, file.source.parentMessageId, file.messageId, channel.type === "dm" ? "dm" : "channel");
      return;
    }
    if (channel.type === "dm") nav.toDmMessage(channel.id, file.messageId);
    else nav.toMessage(channel.id, file.messageId);
  }, [channel.id, channel.type, nav]);

  // Row click opens a preview of the file itself (not the source message).
  // Images go through the shared image lightbox, documents through the shared
  // document preview surface, media through the shared media preview surface,
  // and remaining file types keep the signed URL fallback that lets the
  // browser decide whether it can render them inline.
  const openPreview = useCallback(async (file: ChannelFileEntry) => {
    const attachment = fileToMessageAttachment(file);
    if (isPreviewableImage(file)) {
      useImageLightboxStore.getState().open(
        [attachment],
        0,
      );
      return;
    }
    if (isDocumentPreviewAttachment(attachment)) {
      await openDocumentPreview(attachment, {
        onFallbackDownload: () => downloadAttachment(file),
      });
      return;
    }
    if (isHtmlPreviewAttachment(attachment)) {
      await openMediaPreview("html", attachment, {
        onFallbackDownload: () => downloadAttachment(file),
      });
      return;
    }
    if (isVideoPreviewAttachment(attachment)) {
      await openMediaPreview("video", attachment, {
        onFallbackDownload: () => downloadAttachment(file),
      });
      return;
    }
    if (isAudioPreviewAttachment(attachment)) {
      await openMediaPreview("audio", attachment, {
        onFallbackDownload: () => downloadAttachment(file),
      });
      return;
    }
    try {
      const { data } = await api.get<AttachmentUrlResponse>(`/attachments/${file.id}/url`);
      window.open(data.url, "_blank", "noopener,noreferrer");
    } catch {
      // Swallow — the row's icon buttons still offer download / jump-to-message.
    }
  }, []);

  const handleViewportScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    handleScroll(event.currentTarget);
  }, [handleScroll]);

  const handleLoadMore = useCallback(() => {
    void loadFilesPage(nextCursor, "append");
  }, [loadFilesPage, nextCursor]);

  return (
    <FilesPanel>
      <FilesViewport onScroll={handleViewportScroll}>
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm font-mono text-foreground-muted">{formatMessage({ id: "message.channelFilesPanel.loading" })}</div>
        ) : error ? (
          <div className="flex h-full items-center justify-center text-sm font-bold text-danger">{error}</div>
        ) : files.length === 0 ? (
          <EmptyState
            className="h-full"
            icon={<Paperclip size={36} />}
            title={formatMessage({ id: "emptyState.noFilesTitle" })}
            description={formatMessage({ id: "emptyState.noFilesDesc" })}
          />
        ) : (
          <>
            <FilesList className="flex flex-col gap-2 p-3">
              {files.map((file) => (
                <ChannelFilesPanelFileRow
                  key={file.id}
                  file={file}
                  onOpenPreview={openPreview}
                  onOpenSource={openSource}
                />
              ))}
            </FilesList>
            {(loadingMore || nextCursor) && (
              <div className="flex justify-center p-4">
                {loadingMore ? (
                  <div className="font-mono text-xs text-foreground-muted">{formatMessage({ id: "message.channelFilesPanel.loadingMore" })}</div>
                ) : (
                  <Button
                    type="button"
                    onClick={handleLoadMore}
                    size="sm"
                    variant="outline"
                  >
                    {formatMessage({ id: "message.channelFilesPanel.loadMore" })}
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </FilesViewport>
    </FilesPanel>
  );
}
