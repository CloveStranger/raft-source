import type { TaskStatusId } from "raft-ui";
import type { MessageId } from "../../i18n/messages";
import type { ServerRole } from "@botiverse/raft-shared";
import type { Task, TaskStatus } from "../../store/taskStore";

/**
 * The task-status vocabulary — the app's canonical status set. This module owns
 * only what is status SEMANTICS: the label id (a MessageId, never a sentence)
 * and the transition rules. It deliberately owns NO colour, icon, or badge
 * recipe any more.
 *
 * Task-status APPEARANCE has exactly one source: raft-ui's `TaskStatusBadge` /
 * `TaskStatusIcon` (and the `task-status-*` tokens behind them). Surfaces render
 * those components; nothing here re-declares a colour, so a status can no longer
 * look different on different screens.
 */

export interface TaskStatusUi {
  /**
   * The status label as a MessageId — rendered by every task surface. Holding
   * an id (not finished English) is what makes a hardcoded-English regression
   * impossible rather than merely absent (task #54).
   */
  labelId: MessageId;
}

export const TASK_STATUS_UI: Record<TaskStatus, TaskStatusUi> = {
  todo: { labelId: "task.status.todo" },
  in_progress: { labelId: "task.status.inProgress" },
  in_review: { labelId: "task.status.inReview" },
  done: { labelId: "task.status.done" },
  // Closed = won't-do (cancelled / abandoned). Its disabled look comes from
  // raft-ui's task-status tokens; this map only carries the label id.
  closed: { labelId: "task.status.closed" },
};

/**
 * Back-compat alias for task list/card callsites that read the label. Keep it a
 * typed view over TASK_STATUS_UI, not a second source of truth.
 */
export const STATUS_STYLES: Record<TaskStatus, TaskStatusUi> = TASK_STATUS_UI;

/**
 * slock writes statuses snake_case (`in_progress`); raft-ui writes them
 * kebab-case (`in-progress`). One converter, one place — so no callsite
 * hand-writes the mapping.
 */
export function toRuiTaskStatus(status: TaskStatus): TaskStatusId {
  return status.replace(/_/g, "-") as TaskStatusId;
}

// Mirror of taskService.VALID_TRANSITIONS — kept in sync so the menu only
// surfaces server-allowed transitions.
const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  todo: ["in_progress", "closed"],
  in_progress: ["in_review", "done", "closed"],
  in_review: ["done", "in_progress", "closed"],
  done: ["todo", "in_progress", "in_review", "closed"],
  closed: ["todo", "in_progress"],
};

/**
 * Status is a member-level action: any member who can see the task may move it.
 *
 * This mirrors the server, where the `only the assignee can update status` rule
 * (and its `in_review -> done` carve-out, which existed only to punch a hole in
 * that rule) was removed. Leaving the old check here would have been worse than
 * a dead branch -- the server would accept the write while the browser refused
 * to offer it, so the rule would look intact to every human and only agents on
 * the CLI would get the new behavior.
 *
 * `canManageServer` is kept: admins additionally bypass transition validity.
 */
export function canEditTaskStatus(
  task: Task,
  _currentUserId: string | undefined,
  _canManageServer: boolean,
  serverRole?: ServerRole | null,
): boolean {
  return !task.readOnlyReason && serverRole !== "guest";
}

export function getTaskStatusOptions(task: Task, _currentUserId: string | undefined, canManageServer: boolean) {
  const current = task.status;

  // Members get the legal transitions from where the task is now; admins keep
  // their existing ability to force any status regardless of transition rules.
  const allowed: TaskStatus[] = canManageServer
    ? ["todo", "in_progress", "in_review", "done", "closed"]
    : [current, ...VALID_TRANSITIONS[current]];

  return allowed.map((status) => ({
    id: status,
    labelId: current === "closed" && status === "todo"
      ? ("task.status.reopenToTodo" satisfies MessageId)
      : TASK_STATUS_UI[status].labelId,
  }));
}
