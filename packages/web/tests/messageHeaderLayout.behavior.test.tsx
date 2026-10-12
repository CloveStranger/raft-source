import assert from "node:assert/strict";
import { MemoryRouter } from "react-router-dom";
import { cleanup, render as rtlRender } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import type { Agent } from "../src/store/agentStore";
import type { User } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import type { Locale } from "../src/i18n/locale";
import type { Message } from "../src/store/messageStore";
import type { Server, ServerMember } from "../src/store/serverStore";

// DOM behavior coverage for the message header layout: the reserved top-right
// action gutter (so floating hover affordances never overlap the header text)
// and the time / name / subtitle truncation priorities. Replaces the
// source-scanning assertions previously in messageBookmarkActionSpacing.test.ts
// (artin 铁律1) which read MessageItem.tsx after the mutation-diff gate
// instrumented it in place.

const channelId = "channel-1";
const messageId = "message-1";

function makeUser(): User {
  return {
    id: "user-1",
    email: "current@example.com",
    gravatarHash: "currenthash",
    name: "current",
    displayName: "Current User",
    description: null,
    avatarUrl: null,
    emailVerified: true,
    preferredLanguage: null,
    preferredTimezone: null,
    autoTranslationEnabled: false,
    preferredTimeFormat: null,
    preferredMessageBodyFontSize: null,
    referralSource: null,
    referralSourceOther: null,
    referralSourceSkippedAt: null,
  };
}

function makeServer(): Server {
  return {
    id: "server-1",
    name: "Server",
    slug: "server",
    ownerId: "user-1",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "free",
    planDowngradedAt: null,
    role: "member",
    createdAt: "2026-06-30T00:00:00.000Z",
  };
}

function makeMessage(): Message {
  return {
    id: messageId,
    channelId,
    senderType: "user",
    senderId: "user-1",
    senderName: "Current User",
    senderDescription: "Head of Ops",
    messageType: "chat",
    content: "header layout body",
    createdAt: "2026-06-30T00:00:00.000Z",
  };
}

function makeDeletedAgent(): Agent {
  return {
    id: "agent-1",
    serverId: "server-1",
    serverName: "Server",
    serverSlug: "server",
    name: "milo",
    displayName: "Milo",
    avatarUrl: null,
    description: "macmini",
    status: "inactive",
    model: "claude",
    runtime: "codex",
    external: false,
    serverRole: "member",
    runtimeConfig: null,
    lastRuntimeError: null,
    reasoningEffort: null,
    executionMode: "byoc",
    envVars: null,
    machineId: null,
    sessionId: null,
    runtimeProfile: null,
    creatorType: null,
    creatorId: null,
    creator: null,
    createdAgents: [],
    deletedAt: "2026-08-14T00:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

function makeActiveAgent(): Agent {
  return {
    ...makeDeletedAgent(),
    id: "agent-2",
    name: "nora",
    displayName: "Nora",
    description: "reviews css",
    status: "active",
    model: "claude",
    deletedAt: null,
  };
}

function makeActiveAgentMessage(): Message {
  return {
    ...makeMessage(),
    senderType: "agent",
    senderId: "agent-2",
    senderName: "Nora",
    senderDescription: "reviews css",
  };
}

function makeAgentMessage(): Message {
  return {
    ...makeMessage(),
    senderType: "agent",
    senderId: "agent-1",
    senderName: "Milo",
    senderDescription: "macmini",
  };
}

async function renderMessage(options: { agents?: Agent[]; message?: Message; locale?: Locale } = {}) {
  const { default: MessageItem } = await import("../src/components/message/MessageItem");
  const { useAgentStore } = await import("../src/store/agentStore");
  const { useAuthStore } = await import("../src/store/authStore");
  const { useChannelStore } = await import("../src/store/channelStore");
  const { useSavedStore } = await import("../src/store/savedStore");
  const { useServerStore } = await import("../src/store/serverStore");

  useAuthStore.setState({
    user: makeUser(),
    accessToken: "token",
    refreshToken: "refresh",
    loading: false,
    initialized: true,
  });
  useServerStore.setState({ current: makeServer(), members: [] as ServerMember[] });
  useAgentStore.setState({ agents: options.agents ?? [], agentActivities: {} });
  useChannelStore.setState({ dmChannels: [] as Channel[] });
  useSavedStore.setState({ saved: [], savedIds: new Set(), loading: false, hasMore: false });

  const ui = (
    <MemoryRouter>
      <MessageItem message={options.message ?? makeMessage()} mentionMap={new Map()} channels={[]} />
    </MemoryRouter>
  );
  const view = options.locale
    ? rtlRender(<TestIntlProvider locale={options.locale}>{ui}</TestIntlProvider>)
    : render(ui);
  const row = view.container.querySelector<HTMLElement>(`#message-${messageId}`);
  assert.ok(row);
  return { ...view, row };
}

afterEach(cleanup);

function findSenderName(row: HTMLElement, displayName = "Current User") {
  // The mention button carries a stable testid; the plain sender span falls
  // back to a text lookup so agent senders work too.
  return (
    row.querySelector<HTMLElement>('[data-testid^="message-sender-mention-"]') ??
    Array.from(row.querySelectorAll<HTMLElement>("span, button")).find(
      (el) => el.textContent === displayName,
    ) ??
    null
  );
}

test("header reserves a variable-driven right-side gutter so floating affordances never overlap text", async () => {
  const { row } = await renderMessage();
  const name = findSenderName(row);
  assert.ok(name, "sender name renders");
  const cluster = name.parentElement;
  assert.ok(cluster, "sender sits inside the left cluster");
  const header = cluster.parentElement;
  assert.ok(header);
  // The header keeps a right-side reserve — `--mi-hdr-pr`, 6rem by default,
  // lowered by narrow hosts (the Thread panel) — and clips overflow inside
  // the left cluster so the floating hover toolbar sits in reserved space.
  assert.match(header.className, /pr-\(--mi-hdr-pr,6rem\)/);
  assert.match(header.className, /(?:^| )overflow-hidden(?: |$)/);
  assert.match(cluster.className, /(?:^| )min-w-0(?: |$)/);
  assert.match(cluster.className, /(?:^| )overflow-hidden(?: |$)/);
  // The cluster shrinks but never grows: the time keeps following the
  // description in wide rows and is only pushed right when the row overflows.
  assert.doesNotMatch(cluster.className, /(?:^| )flex-1(?: |$)/);
});

test("header gives up the subtitle first, then the model, then the name; time sits outside the cluster", async () => {
  const { row } = await renderMessage();

  const name = findSenderName(row);
  assert.ok(name);
  // Name is OUT of the shrink pool (task #743): any nonzero shrink — even
  // `shrink` against a `shrink-[999]` sibling — hands it a sub-pixel share and
  // `truncate` then shows "C…" while the subtitle still has room. It truncates
  // only when it alone is wider than the cluster (max-w-full).
  assert.match(name.className, /(?:^| )truncate(?: |$)/);
  assert.match(name.className, /(?:^| )shrink-0(?: |$)/);
  assert.match(name.className, /(?:^| )max-w-full(?: |$)/);

  // Innermost match: the tail wrapper has the same text when it holds only the subtitle.
  const subtitle = [...row.querySelectorAll<HTMLElement>("span")].findLast((el) => el.textContent === "Head of Ops");
  assert.ok(subtitle, "subtitle renders with a title tooltip");
  // Subtitle yields first: it is the only shrinkable item in the tail.
  assert.match(subtitle.className, /(?:^| )min-w-0(?: |$)/);
  assert.match(subtitle.className, /(?:^| )truncate(?: |$)/);
  assert.doesNotMatch(subtitle.className, /(?:^| )shrink-0(?: |$)/);
  assert.doesNotMatch(subtitle.className, /shrink-\[/, "no weighted shrink: weights leak onto siblings");

  // The tail (model · badges · subtitle) is its own shrinkable flex box beside
  // the name, so the name never shares in its shrink.
  const tail = subtitle.parentElement;
  assert.ok(tail);
  assert.match(tail.getAttribute("data-testid") ?? "", /^message-sender-tail-/);
  assert.match(tail.className, /(?:^| )min-w-0(?: |$)/);
  assert.match(tail.className, /(?:^| )overflow-hidden(?: |$)/);
  assert.ok(tail.parentElement === name.parentElement, "tail sits beside the name in the left cluster");

  // Cluster and time are siblings: time sits OUTSIDE the cluster, so a
  // narrow panel can never clip it.
  const cluster = name.parentElement;
  assert.ok(cluster);
  const time = Array.from(row.querySelectorAll<HTMLElement>("span")).find((el) =>
    /(?:^| )whitespace-nowrap(?: |$)/.test(el.className) && /font-mono/.test(el.className),
  );
  assert.ok(time, "timestamp renders as a non-wrapping mono span");
  assert.match(time.className, /(?:^| )shrink-0(?: |$)/);
  assert.ok(time.parentElement === cluster.parentElement, "time is a sibling of the cluster");
});

test("model label yields after the subtitle and before the name", async () => {
  const { row } = await renderMessage({ agents: [makeActiveAgent()], message: makeActiveAgentMessage() });
  const model = row.querySelector<HTMLElement>('[data-testid^="message-sender-model-"]');
  assert.ok(model, "model label renders for an agent message");
  // Fixed while the subtitle still has room; truncates only once the tail is
  // narrower than the model itself (max-w-full of the tail).
  assert.match(model.className, /(?:^| )shrink-0(?: |$)/);
  assert.match(model.className, /(?:^| )max-w-full(?: |$)/);
  assert.match(model.className, /(?:^| )truncate(?: |$)/);
  const name = findSenderName(row, "Nora");
  assert.ok(name);
  const tail = model.parentElement;
  assert.ok(tail);
  assert.match(tail.getAttribute("data-testid") ?? "", /^message-sender-tail-/);
  assert.ok(tail.parentElement === name.parentElement, "model sits in the tail beside the name");
});

test("deleted sender badge stays on one line in compact localized headers", async () => {
  const { row } = await renderMessage({ agents: [makeDeletedAgent()], message: makeAgentMessage(), locale: "zh-cn" });

  const deletedBadge = Array.from(row.querySelectorAll<HTMLElement>("span")).find((el) => el.textContent === "已删除");
  assert.ok(deletedBadge, "localized deleted sender badge renders");
  assert.match(deletedBadge.className, /(?:^| )shrink-0(?: |$)/);
  assert.match(deletedBadge.className, /(?:^| )whitespace-nowrap(?: |$)/);
});
