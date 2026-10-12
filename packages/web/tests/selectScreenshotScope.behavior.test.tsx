import "./helpers/domSetup";
import assert from "node:assert/strict";
import { findSelectedMessageRows } from "../src/utils/selectScreenshot";

afterEach(() => { document.body.replaceChildren(); });

function row(id: string): HTMLElement {
  const el = document.createElement("div");
  el.id = `message-${id}`;
  return el;
}

test("thread share capture uses the thread panel's parent row, not the channel timeline copy", () => {
  // A thread parent renders in both the channel timeline and the thread
  // panel; the channel column comes first in the document and is narrower.
  const channelColumn = document.createElement("div");
  const channelCopy = row("parent");
  channelColumn.append(channelCopy);
  const threadPanel = document.createElement("div");
  const threadParent = row("parent");
  const reply = row("reply");
  threadPanel.append(threadParent, reply);
  document.body.append(channelColumn, threadPanel);

  const scoped = findSelectedMessageRows(["reply", "parent"], threadPanel);
  assert.equal(scoped[0], threadParent);
  assert.equal(scoped[1], reply);

  assert.equal(findSelectedMessageRows(["parent"])[0], channelCopy);
});

test("rows missing from the scope fall back to the document", () => {
  const elsewhere = row("loose");
  const panel = document.createElement("div");
  document.body.append(elsewhere, panel);
  assert.deepEqual(findSelectedMessageRows(["loose"], panel), [elsewhere]);
});
