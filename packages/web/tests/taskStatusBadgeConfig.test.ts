/**
 * Task status has ONE source of appearance: raft-ui (its `TaskStatusBadge` /
 * `TaskStatusIcon` over the `task-status-*` tokens). Slock's `taskStatusUi.ts`
 * owns only the label copy and transition rules — it carries no colour, icon,
 * or badge recipe, so no surface can drift the look.
 *
 * This file guards that split (it replaced the old "every surface reads the
 * local color map" assertions when the appearance moved into raft-ui, task
 * #proj-rui:4f2a251d / slock #9154). The visual consistency itself (same status,
 * same colour + icon across surfaces and themes) is asserted against the real
 * components in the DOM suites.
 */

import { strict as assert } from "node:assert";
import { TASK_STATUS_UI, STATUS_STYLES, toRuiTaskStatus } from "../src/components/task/taskStatusUi";
import type { TaskStatus } from "../src/store/taskStore";

const STATUSES: TaskStatus[] = ["todo", "in_progress", "in_review", "done", "closed"];

test("STATUS_STYLES is the same source as TASK_STATUS_UI, not a divergent copy", () => {
  // Callsites read this alias; it must stay identical to TASK_STATUS_UI or a
  // surface could quietly diverge again.
  assert.equal(STATUS_STYLES, TASK_STATUS_UI);
});

test("taskStatusUi carries only label ids — no colour, icon, or badge recipe", () => {
  for (const status of STATUSES) {
    const entry = TASK_STATUS_UI[status] as Record<string, unknown>;
    assert.equal(typeof entry.labelId, "string", `${status} must carry a labelId`);
    // The appearance lives in raft-ui now; none of these may come back here.
    for (const forbidden of ["bg", "icon", "variant", "appearance"]) {
      assert.equal(
        forbidden in entry,
        false,
        `${status} must not carry a local \`${forbidden}\` — appearance is raft-ui's single source`,
      );
    }
  }
});

test("every status maps to its raft-ui kebab-case id", () => {
  // The snake_case↔kebab-case converter is the one place the naming differs.
  assert.equal(toRuiTaskStatus("todo"), "todo");
  assert.equal(toRuiTaskStatus("in_progress"), "in-progress");
  assert.equal(toRuiTaskStatus("in_review"), "in-review");
  assert.equal(toRuiTaskStatus("done"), "done");
  assert.equal(toRuiTaskStatus("closed"), "closed");
  for (const status of STATUSES) {
    assert.equal(typeof toRuiTaskStatus(status), "string");
  }
});
