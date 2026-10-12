import { memo, useCallback, useMemo, useState } from "react";
import {
  TaskCard as RuiTaskCard,
  TaskCardBody,
  TaskCardChannel,
  TaskCardDescription,
  TaskCardLegacy,
  TaskCardMeta,
  TaskCardNumber,
  TaskCardRow,
  TaskCardTitle,
} from "raft-ui";
import type { Task, TaskStatus } from "../../store/taskStore";
import { useTaskStore } from "../../store/taskStore";
import { useAuthStore } from "../../store/authStore";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import InlineBadgeEditor from "../InlineBadgeEditor";
import { useIntl } from "react-intl";
import { StatusBadge } from "./StatusBadge";

import { STATUS_STYLES, canEditTaskStatus, getTaskStatusOptions, toRuiTaskStatus } from "./taskStatusUi";

// Memoized so a single task update (status change, drag-reorder, socket
// task:* broadcast) re-renders only the changed card, not the whole board.
// `onOpen` takes the task so callsites can pass a *stable* handler instead of
// an inline `() => open(task)` closure that would break this memo for every row
// (#proj-frontend render-perf, same churn class as the channelActivity slice).
function TaskCard({ task, onOpen, showChannelName = true }: {
  task: Task;
  onOpen: (task: Task) => void;
  showChannelName?: boolean;
}) {
  const updateTaskStatus = useTaskStore((s) => s.updateTaskStatus);
  const currentUser = useAuthStore((s) => s.user);
  const { capabilities, role } = useServerPermissions();
  const [editingStatus, setEditingStatus] = useState(false);
  const [busy, setBusy] = useState(false);
  const canManageServer = capabilities.deleteAnyTask;
  const canEditStatus = canEditTaskStatus(task, currentUser?.id, canManageServer, role);
  const { formatMessage } = useIntl();
  const currentUserId = currentUser?.id;
  const statusOptions = useMemo(
    () => getTaskStatusOptions(task, currentUserId, canManageServer)
      .map((option) => ({ id: option.id, label: formatMessage({ id: option.labelId }) })),
    [task, currentUserId, canManageServer, formatMessage],
  );
  const style = STATUS_STYLES[task.status];

  const handleStatusSelect = useCallback(async (id: string) => {
    const nextStatus = id as TaskStatus;
    if (nextStatus === task.status) {
      setEditingStatus(false);
      return;
    }
    setBusy(true);
    try {
      await updateTaskStatus(task.channelId, task.id, nextStatus);
      setEditingStatus(false);
    } catch (err) {
      console.error("Failed to update task status:", err);
    } finally {
      setBusy(false);
    }
  }, [task.status, task.channelId, task.id, updateTaskStatus]);

  const toggleStatusEditor = useCallback(() => setEditingStatus((prev) => !prev), []);
  const closeStatusEditor = useCallback(() => setEditingStatus(false), []);

  return (
    <RuiTaskCard className="w-full">
      <button type="button" onClick={() => onOpen(task)} className="w-full text-left">
        <TaskCardRow>
          <TaskCardBody>
            <TaskCardMeta>
              {showChannelName && (
                <TaskCardChannel>
                  #{task.channelName || formatMessage({ id: "task.legacyPanel.unknownChannel" })}
                </TaskCardChannel>
              )}
              <TaskCardNumber>#{task.taskNumber}</TaskCardNumber>
              {task.isLegacy && (
                <TaskCardLegacy>
                  {formatMessage({ id: "task.badge.legacy" })}
                </TaskCardLegacy>
              )}
            </TaskCardMeta>
            <TaskCardTitle>{task.title}</TaskCardTitle>
            {task.description && (
              <TaskCardDescription>
                {task.description}
              </TaskCardDescription>
            )}
          </TaskCardBody>
        </TaskCardRow>
      </button>
      <div className="mt-2 flex justify-end">
        {canEditStatus ? (
          <div className={`relative shrink-0 ${busy ? "pointer-events-none opacity-60" : ""}`}>
            <InlineBadgeEditor
              badgeStatus={toRuiTaskStatus(task.status)}
              displayValue={formatMessage({ id: style.labelId })}
              selectedId={task.status}
              options={statusOptions}
              onSelect={handleStatusSelect}
              open={editingStatus}
              onToggle={toggleStatusEditor}
              onRequestClose={closeStatusEditor}
              badgeClassName=""
              uppercase={false}
              dropdownMinWidth="min-w-[140px]"
              dropdownAlign="right"
              dropdownTestId="task-status-menu"
              optionTestIdPrefix="task-status-option"
            />
          </div>
        ) : (
          <StatusBadge status={task.status} data-testid="task-status-readonly">
            {formatMessage({ id: style.labelId })}
          </StatusBadge>
        )}
      </div>
    </RuiTaskCard>
  );
}

export default memo(TaskCard);
