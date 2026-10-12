import CloseButton from "../ui/CloseButton";
import { useCallback, useEffect, useEffectEvent, useMemo, useState } from "react";
import { MapPin, X } from "lucide-react";
import { useIntl } from "react-intl";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { Button } from "raft-ui";
import ThreadPanel from "../message/ThreadPanel";
import LegacyTaskPanel from "../task/LegacyTaskPanel";
import TaskModalHead from "../task/TaskModalHead";
import Tooltip from "../ui/Tooltip";
import { useChannelStore } from "../../store/channelStore";
import { useLegacyTaskPanelStore } from "../../store/legacyTaskPanelStore";
import { selectChannelTaskBucket, useTaskStore } from "../../store/taskStore";
import { useThreadStore } from "../../store/threadStore";
import { resolveThreadHostTask } from "../layout/threadHostTask";
import { buildTaskChannelUrl, closeThreadWindow } from "./closeThreadWindow";

const NON_INTERACTIVE_TOOLTIP_PROPS = { className: "pointer-events-none" };

/**
 * Minimal host for `_blank` thread/task windows. This route intentionally
 * bypasses MainLayout so the new window contains only the requested panel —
 * no channel list, rail, or unrelated activity surface.
 */
export default function ThreadWindowRoute() {
  const { formatMessage } = useIntl();
  const { serverSlug } = useParams<{ serverSlug: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const ensureChannel = useChannelStore((state) => state.ensureChannel);
  const openThread = useThreadStore((state) => state.openThread);
  const closeThread = useThreadStore((state) => state.closeThread);
  const closeLegacyTask = useLegacyTaskPanelStore((state) => state.closeLegacyTask);
  const openLegacyTask = useLegacyTaskPanelStore((state) => state.openLegacyTask);
  const loadTasks = useTaskStore((state) => state.loadTasks);
  const loadServerTasks = useTaskStore((state) => state.loadServerTasks);
  const tasks = useTaskStore((state) => state.tasks);
  const serverTasks = useTaskStore((state) => state.serverTasks);
  const openParentChannelId = useThreadStore((state) => state.openParentChannelId);
  const legacyTask = useLegacyTaskPanelStore((state) => state.task);
  const openParentMessageId = useThreadStore((state) => state.openParentMessageId);
  // Task windows open the modal's independent slot (task #699), so their
  // surface anchor lives in taskModal, not in the side-thread open* fields.
  const taskModal = useThreadStore((state) => state.taskModal);
  const [asyncError, setAsyncError] = useState<string | null>(null);

  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const threadParam = params.get("thread");
  const legacyTaskParam = params.get("legacyTask");
  const taskIntent = params.get("task") === "1";
  const surfaceParentChannelId = taskIntent ? taskModal?.parentChannelId ?? null : openParentChannelId;
  const surfaceParentMessageId = taskIntent ? taskModal?.parentMessageId ?? null : openParentMessageId;
  const parentChannelTasks = useTaskStore((state) => selectChannelTaskBucket(state, surfaceParentChannelId));
  const invalidTarget = !serverSlug
    || (!legacyTaskParam && !threadParam)
    || (legacyTaskParam !== null && !legacyTaskParam.includes(":"))
    || (legacyTaskParam === null && !threadParam?.includes(":"));

  const closeWindow = useCallback(() => {
    closeThreadWindow({
      serverSlug,
      closeThread,
      closeLegacyTask,
      closeBrowserWindow: () => window.close(),
      isBrowserWindowClosed: () => window.closed,
      navigate,
    });
  }, [closeLegacyTask, closeThread, navigate, serverSlug]);

  const viewInChannel = useCallback((
    channelId: string,
    messageId?: string | null,
    isLegacy = false,
    channelType?: "channel" | "dm",
  ) => {
    closeThread();
    closeLegacyTask();
    const resolvedChannelType = channelType ?? (
      [...useChannelStore.getState().channels, ...useChannelStore.getState().dmChannels]
        .find((item) => item.id === channelId)?.type === "dm" ? "dm" : "channel"
    );
    navigate(buildTaskChannelUrl(serverSlug, channelId, messageId, isLegacy, resolvedChannelType), { replace: true });
  }, [closeLegacyTask, closeThread, navigate, serverSlug]);

  // Non-reactive reads for the load effect below: the URL identity
  // (server, thread/legacyTask target, task intent) is the route contract, so
  // a locale change or a `msg` focus change must not reload the window.
  const showLoadFailure = useEffectEvent(() => {
    setAsyncError(formatMessage({ id: "message.threadPanel.loadFailedTitle" }));
  });
  const readFocusedMessageId = useEffectEvent(() => params.get("msg"));

  useEffect(() => {
    let cancelled = false;
    const fail = () => {
      if (!cancelled) showLoadFailure();
    };
    closeThread();
    closeLegacyTask();

    if (!serverSlug) {
      return () => { cancelled = true; };
    }

    if (legacyTaskParam) {
      const separator = legacyTaskParam.indexOf(":");
      const channelId = separator > 0 ? legacyTaskParam.slice(0, separator) : "";
      const taskId = separator > 0 ? legacyTaskParam.slice(separator + 1) : "";
      if (!channelId || !taskId) {
        return () => { cancelled = true; };
      }
      void Promise.all([
        ensureChannel(channelId).then((resolved) => {
          if (!resolved) throw new Error("Channel unavailable");
          return loadTasks(channelId);
        }),
        loadServerTasks(),
      ]).then(() => {
        if (cancelled) return;
        const state = useTaskStore.getState();
        const task = state.tasksByChannelId[channelId]?.find((item) => item.id === taskId)
          ?? state.serverTasks.find((item) => item.id === taskId);
        // `legacyTask` is an explicit legacy-panel contract. Older API
        // projections may omit the optional `isLegacy` marker, so the stable
        // identity lookup—not that presentation hint—decides whether the
        // requested task can be shown.
        if (task) {
          openLegacyTask(task);
        } else {
          fail();
        }
      }).catch(() => {
        fail();
      });
      return () => { cancelled = true; };
    }

    if (!threadParam) {
      return () => { cancelled = true; };
    }
    const separator = threadParam.indexOf(":");
    const parentChannelId = separator > 0 ? threadParam.slice(0, separator) : "";
    const parentMessageId = separator > 0 ? threadParam.slice(separator + 1) : "";
    if (!parentChannelId || !parentMessageId) {
      return () => { cancelled = true; };
    }
    const focusedMessageId = readFocusedMessageId();
    void ensureChannel(parentChannelId).then((resolved) => {
      if (cancelled) return;
      if (!resolved) {
        fail();
        return;
      }
      return openThread({
        serverSlug,
        parentChannelId,
        parentMessageId,
        focusedMessageId,
        intent: taskIntent ? "task" : "thread",
      });
    }).catch(() => {
      fail();
    });
    return () => { cancelled = true; };
    // URL identity is the route contract; store actions are stable Zustand refs.
  }, [
    serverSlug,
    threadParam,
    legacyTaskParam,
    taskIntent,
    closeThread,
    closeLegacyTask,
    ensureChannel,
    loadTasks,
    loadServerTasks,
    openLegacyTask,
    openThread,
  ]);

  const task = taskIntent
    ? resolveThreadHostTask(surfaceParentMessageId, { tasks, parentChannelTasks, serverTasks })
    : null;
  const taskChannelId = task?.channelId;
  const taskMessageId = task?.messageId;
  const taskChannelType = task?.channelType;
  const viewTaskInChannel = useCallback(() => {
    if (taskChannelId === undefined) return;
    viewInChannel(taskChannelId, taskMessageId, false, taskChannelType === "dm" ? "dm" : undefined);
  }, [taskChannelId, taskChannelType, taskMessageId, viewInChannel]);
  const legacyChannelId = legacyTask?.channelId;
  const legacyMessageId = legacyTask?.messageId;
  const legacyChannelType = legacyTask?.channelType;
  const taskThreadIdentity = useMemo(() => taskIntent && taskModal ? {
    parentMessageId: taskModal.parentMessageId,
    parentChannelId: taskModal.parentChannelId ?? "",
    threadChannelId: taskModal.threadChannelId,
    focusedMessageId: taskModal.focusedMessageId,
  } : undefined, [taskIntent, taskModal]);

  const viewLegacyTaskInChannel = useCallback(() => {
    if (legacyChannelId === undefined) return;
    viewInChannel(legacyChannelId, legacyMessageId, true, legacyChannelType === "dm" ? "dm" : undefined);
  }, [legacyChannelId, legacyChannelType, legacyMessageId, viewInChannel]);
  const taskPageSlot = task ? (
    <>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line-hairline bg-layer-panel px-4 py-2 theme-brutal:border-b-2 theme-brutal:border-black theme-brutal:bg-white">
        <Tooltip
          content={task.title}
          disableHoverablePopup
          contentProps={NON_INTERACTIVE_TOOLTIP_PROPS}
        >
          <strong className="truncate text-sm" data-testid="task-page-identity">
            {formatMessage({ id: "task.modal.taskWithNumber" }, { taskNumber: task.taskNumber })}
          </strong>
        </Tooltip>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip
            content={formatMessage({ id: "message.threadPanel.viewInChannel" })}
            disableHoverablePopup
            contentProps={NON_INTERACTIVE_TOOLTIP_PROPS}
          >
            <Button
              type="button"
              onClick={viewTaskInChannel}
              size="icon-sm"
              variant="outline"
              className="size-7"
              aria-label={formatMessage({ id: "message.threadPanel.viewInChannel" })}
              data-testid="task-view-in-channel"
            >
              <MapPin size={14} />
            </Button>
          </Tooltip>
          <Tooltip
            content={formatMessage({ id: "task.modal.close" })}
            disableHoverablePopup
            contentProps={NON_INTERACTIVE_TOOLTIP_PROPS}
          >
            <CloseButton
              type="button"
              onClick={closeWindow}
              className=" flex size-7 items-center justify-center "
              aria-label={formatMessage({ id: "task.modal.close" })}
              data-testid="task-close"
            >
              <X size={14} />
            </CloseButton>
          </Tooltip>
        </div>
      </div>
      <TaskModalHead task={task} />
    </>
  ) : undefined;

  return (
    <main className="flex h-dvh max-h-dvh min-h-0 w-full flex-col overflow-hidden bg-layer-canvas-muted font-display theme-brutal:bg-brutal-cream" data-testid="thread-window-route">
      <div className="flex min-h-0 flex-1 justify-center bg-layer-canvas p-0 sm:bg-transparent sm:p-3">
        {invalidTarget || asyncError ? (
          <div className="flex w-full max-w-2xl flex-col items-center justify-center gap-4 rounded-lg border border-line-muted bg-layer-panel p-8 text-center shadow-raft-md theme-brutal:rounded-none theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white theme-brutal:shadow-brutal">
            <p className="font-bold text-foreground-strong">{asyncError ?? formatMessage({ id: "message.threadPanel.loadFailedTitle" })}</p>
            <Button type="button" onClick={closeWindow} size="sm" variant="outline" className="font-bold">
              {formatMessage({ id: "message.threadPanel.closeThread" })}
            </Button>
          </div>
        ) : legacyTask ? (
          <LegacyTaskPanel
            presentation="modal"
            mobilePage
            onClose={closeWindow}
            onViewInChannel={viewLegacyTaskInChannel}
          />
        ) : surfaceParentMessageId ? (
          <div data-testid="thread-window-surface" className={`flex w-full max-w-none flex-col bg-layer-canvas sm:max-w-3xl sm:border sm:border-line-muted sm:shadow-raft-md theme-brutal:sm:border-2 theme-brutal:sm:border-black theme-brutal:sm:bg-white theme-brutal:sm:shadow-brutal ${
            task
              ? "min-h-full overflow-hidden sm:min-h-0 sm:h-[calc(100dvh-1.5rem)] sm:max-h-full"
              : "min-h-full overflow-hidden sm:h-[calc(100dvh-1.5rem)] sm:max-h-full"
          }`}>
            <div className="min-h-0 flex-1">
              <ThreadPanel presentation="modal" mobilePage onClose={closeWindow} hideHeader={!!task} hideParentMessage={!!task} parentSlot={taskPageSlot}
                threadIdentity={taskThreadIdentity} />
            </div>
          </div>
        ) : (
          <div className="flex h-[calc(100dvh-1.5rem)] max-h-full w-full max-w-3xl items-center justify-center rounded-lg border border-line-muted bg-layer-panel shadow-raft-md theme-brutal:rounded-none theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white theme-brutal:shadow-brutal">
            <span className="text-foreground-hint">{formatMessage({ id: "common.loading" })}</span>
          </div>
        )}
      </div>
    </main>
  );
}
