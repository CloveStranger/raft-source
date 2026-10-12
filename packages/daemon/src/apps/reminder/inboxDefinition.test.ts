import assert from "node:assert/strict";

import { createAgentAppInboxStore } from "../../agentAppInbox";
import { projectReminderInboxTitle, REMINDER_AGENT_INBOX_REGISTRY } from "./inboxDefinition";

const REMINDER_ID = "12345678-1234-4123-8123-123456789abc";

test("Reminder due item has exact OS-minted identity/action and no message identity", () => {
  const store = createAgentAppInboxStore({ registry: REMINDER_AGENT_INBOX_REGISTRY });
  const result = store.mint({
    appId: "system.reminder",
    notificationClass: "due",
    sourceRef: { kind: "reminder", id: REMINDER_ID, revision: "7" },
    title: "Follow up",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.item.itemId, `reminder:${REMINDER_ID}:7`);
  assert.equal(result.item.retention, "until_explicit_ack");
  assert.equal(result.item.actionCli, "raft reminder ack --id 12345678 --revision 7");
  assert.deepEqual(result.item.primaryAction, {
    kind: "run_command",
    commandId: "reminder.ack",
  });
  for (const field of ["msgId", "seq", "sender", "latestMsgId", "latestSenderName"]) {
    assert.equal(field in result.item, false, field);
  }
});

test("Reminder source identity rejects extra fields and app-supplied action", () => {
  const store = createAgentAppInboxStore({ registry: REMINDER_AGENT_INBOX_REGISTRY });
  const extra = store.mint({
    appId: "system.reminder",
    notificationClass: "due",
    sourceRef: {
      kind: "reminder",
      id: REMINDER_ID,
      revision: "7",
      command: "rm -rf /",
    },
  });
  assert.equal(extra.ok, false);
  if (!extra.ok) assert.equal(extra.code, "invalid_source_ref");

  const action = store.mint({
    appId: "system.reminder",
    notificationClass: "due",
    sourceRef: { kind: "reminder", id: REMINDER_ID, revision: "7" },
    requestedPrimaryAction: { kind: "run_command", commandId: "shell" },
  });
  assert.equal(action.ok, false);
  if (!action.ok) assert.equal(action.code, "invalid_primary_action");
});

test("Reminder source identity rejects malformed UUID and revision shapes", () => {
  const store = createAgentAppInboxStore({ registry: REMINDER_AGENT_INBOX_REGISTRY });
  for (const sourceRef of [
    { kind: "reminder", id: "12345678-1234-4123-8123-123456789ab-", revision: "7" },
    { kind: "reminder", id: REMINDER_ID, revision: "0" },
    { kind: "reminder", id: REMINDER_ID, revision: "01" },
  ]) {
    const result = store.mint({
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "invalid_source_ref");
  }
});

test("Reminder projects every legal title into one bounded Inbox preview line", () => {
  const long = "x".repeat(500);
  // A shortened title must be visibly incomplete: a silently cut structured
  // value (version, id, count) is well-formed and therefore self-concealing.
  assert.equal(projectReminderInboxTitle(long), "x".repeat(119) + "\u2026");
  assert.equal(projectReminderInboxTitle("x".repeat(120)), "x".repeat(120), "exactly at the bound: no marker");
  assert.equal(projectReminderInboxTitle("x".repeat(121)), "x".repeat(119) + "\u2026");
  assert.equal(
    projectReminderInboxTitle("check  CLI < 0.0.28 ".padEnd(130, "y")),
    "check CLI < 0.0.28 ".padEnd(119, "y") + "\u2026",
    "whitespace is collapsed before the bound is applied",
  );
  // The cut must not split a surrogate pair: a lone high surrogate at the end
  // is not well-formed and renders as garbage before the marker.
  const emojiAtCut = "x".repeat(118) + "\u{1F600}" + "y".repeat(10);
  assert.equal(projectReminderInboxTitle(emojiAtCut), "x".repeat(118) + "\u2026");
  // (ES2022 target: no String#isWellFormed; a lone high surrogate right before
  // the marker is the only malformed shape this cut can produce.)
  assert.doesNotMatch(projectReminderInboxTitle(emojiAtCut)!, /[\uD800-\uDBFF]\u2026$/);
  assert.equal(projectReminderInboxTitle("first\nsecond\r\nthird"), "first second third");

  const store = createAgentAppInboxStore({ registry: REMINDER_AGENT_INBOX_REGISTRY });
  for (const [revision, title] of [["8", long], ["9", "first\nsecond"]] as const) {
    const result = store.mint({
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef: { kind: "reminder", id: REMINDER_ID, revision },
      title: projectReminderInboxTitle(title),
    });
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.ok((result.item.title?.length ?? 0) <= 120);
    assert.doesNotMatch(result.item.title ?? "", /[\r\n\u0000-\u001f\u007f]/);
  }
  assert.equal(store.list().length, 2, "both legal Reminder titles mint exactly one item");
});
