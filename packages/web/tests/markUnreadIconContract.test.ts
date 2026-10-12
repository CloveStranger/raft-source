import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readSource = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("mark read/unread menu actions use conversation bubble icons", () => {
  const threadsInbox = readSource("src/components/thread/ThreadsInbox.tsx");
  // The Activity row context menu lives in its own file since task #709.
  const inboxContextMenu = readSource("src/components/thread/InboxContextMenu.tsx");
  // The sidebar read/unread menu item lives in its own file since task #709.
  const sidebar = readSource("src/components/layout/SidebarReadToggleMenuItem.tsx");
  const sidebarParent = readSource("src/components/layout/Sidebar.tsx");

  assert.match(threadsInbox, /<InboxContextMenu\b/);
  assert.match(
    inboxContextMenu,
    /ctxMenu\.item\.unreadCount > 0 \? <MessageSquareCheck size=\{14\} \/> : <MessageSquareDot size=\{14\} \/>/u,
  );
  assert.match(sidebarParent, /<SidebarReadToggleMenuItem\b/);
  assert.match(
    sidebar,
    /hasUnread \? <MessageSquareCheck size=\{14\} \/> : <MessageSquareDot size=\{14\} \/>/u,
  );

  for (const source of [threadsInbox, inboxContextMenu]) {
    assert.doesNotMatch(
      source,
      /ctxMenu\.item\.unreadCount > 0 \? <MailOpen size=\{14\} \/> : <Mail size=\{14\} \/>/u,
    );
  }
  for (const source of [sidebar, sidebarParent]) {
    assert.doesNotMatch(
      source,
      /hasUnread \? <MailOpen size=\{14\} \/> : <Mail size=\{14\} \/>/u,
    );
  }
});
