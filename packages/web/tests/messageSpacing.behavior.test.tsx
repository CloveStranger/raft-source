import "./helpers/installResizeObserver";
import assert from "node:assert/strict";
import { MemoryRouter } from "react-router-dom";
import { cleanup, render as rtlRender } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
import { ThemeProvider } from "raft-ui";

window.matchMedia = ((media: string) => ({
  matches: false,
  media,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => true,
})) as typeof window.matchMedia;

const render: typeof rtlRender = (ui, options) =>
  rtlRender(ui, { wrapper: TestIntlProvider, ...options });

import type { Agent } from "../src/store/agentStore";
import type { Channel } from "../src/store/channelStore";
import type { Message } from "../src/store/messageStore";
import type { Server, ServerMember } from "../src/store/serverStore";
import type { User } from "../src/store/authStore";

// DOM coverage for the 2026-10-11 spacing round (cindyz's 16/24): the explicit
// `data-followed-by` rhythm marker and the body-margin collapse that makes a
// group's first row sit the same 16 from its continuation as compact rows do.
// The collapse is driven by the marker; the marker's list computation lives in
// messageGrouping.followedByFor and is unit-tested beside the grouping rules.

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
    content: "spacing body",
    createdAt: "2026-06-30T00:00:00.000Z",
  };
}

function makeActiveAgent(): Agent {
  return {
    id: "agent-2",
    serverId: "server-1",
    serverName: "Server",
    serverSlug: "server",
    name: "nora",
    displayName: "Nora",
    avatarUrl: null,
    description: "reviews css",
    status: "active",
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
    deletedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

function makeAgentMessage(): Message {
  return {
    ...makeMessage(),
    senderType: "agent",
    senderId: "agent-2",
    senderName: "Nora",
    senderDescription: "reviews css",
  };
}

async function renderMessage(
  options: { followedBy?: "compact" | "group"; followsSystem?: boolean; agentMessage?: boolean; theme?: "elegant" | "brutal" } = {},
) {
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
  useAgentStore.setState({
    agents: options.agentMessage ? [makeActiveAgent()] : [],
    agentActivities: {},
  });
  useChannelStore.setState({ dmChannels: [] as Channel[] });
  useSavedStore.setState({ saved: [], savedIds: new Set(), loading: false, hasMore: false });

  const ui = (
    <MemoryRouter>
      <MessageItem
        message={options.agentMessage ? makeAgentMessage() : makeMessage()}
        mentionMap={new Map()}
        channels={[]}
        followedBy={options.followedBy}
        followsSystem={options.followsSystem}
      />
    </MemoryRouter>
  );
  const view = render(
    <ThemeProvider theme={options.theme ?? "elegant"} mode="light" syncDom={false}>{ui}</ThemeProvider>,
  );
  const row = view.container.querySelector<HTMLElement>(`#message-${messageId}`);
  assert.ok(row);
  return { ...view, row };
}

afterEach(cleanup);

test("the root carries the rhythm marker and the body collapses its bottom margin", async () => {
  const { row } = await renderMessage({ followedBy: "compact" });
  assert.equal(row.getAttribute("data-followed-by"), "compact");
  const body = row.querySelector<HTMLElement>("[data-message-selectable]");
  assert.ok(body, "body renders");
  assert.match(body.className, /group-data-\[followed-by\]\/message:mb-0/);
});

test('a "group"-followed row collapses the same way (card rows included via the recipe)', async () => {
  const { row } = await renderMessage({ followedBy: "group" });
  assert.equal(row.getAttribute("data-followed-by"), "group");
  const body = row.querySelector<HTMLElement>("[data-message-selectable]");
  assert.ok(body);
  assert.match(body.className, /group-data-\[followed-by\]\/message:mb-0/);
});

test("a row after a system note carries the follows-system marker", async () => {
  const { row } = await renderMessage({ followsSystem: true });
  assert.equal(row.getAttribute("data-follows-system"), "true");
});

test("the list's last row carries no marker and keeps its bottom margin", async () => {
  const { row } = await renderMessage();
  assert.equal(row.getAttribute("data-followed-by"), null);
  const body = row.querySelector<HTMLElement>("[data-message-selectable]");
  assert.ok(body);
  assert.doesNotMatch(body.className, /group-data-\[followed-by\]\/message:mb-0/);
});

test("the font preference scales the name and the name-line notes", async () => {
  const { useAppearanceStore } = await import("../src/store/appearanceStore");
  useAppearanceStore.setState({ messageBodyFontSize: "sm" });
  const smallView = await renderMessage({ agentMessage: true });
  const smallName = smallView.row.querySelector<HTMLElement>('[data-testid^="message-sender-mention-"], [data-testid^="message-sender-"]');
  assert.ok(smallName);
  assert.match(smallName.className, /(?:^| )text-\[12px\](?: |$)/, "sm name reads 12");
  const smallModel = smallView.row.querySelector<HTMLElement>('[data-testid^="message-sender-model-"]');
  assert.ok(smallModel);
  assert.match(smallModel.className, /(?:^| )text-\[11px\](?: |$)/, "sm notes read 11");
  cleanup();

  useAppearanceStore.setState({ messageBodyFontSize: "lg" });
  const largeView = await renderMessage({ agentMessage: true });
  const largeName = largeView.row.querySelector<HTMLElement>('[data-testid^="message-sender-mention-"], [data-testid^="message-sender-"]');
  assert.ok(largeName);
  assert.match(largeName.className, /(?:^| )text-\[16px\](?: |$)/, "lg name reads 16");
  const largeModel = largeView.row.querySelector<HTMLElement>('[data-testid^="message-sender-model-"]');
  assert.ok(largeModel);
  assert.match(largeModel.className, /(?:^| )text-\[14px\](?: |$)/, "lg notes read 14");
  useAppearanceStore.setState({ messageBodyFontSize: "md" });
});

test("the large font tier raises the avatar size via the row variable", async () => {
  const { useAppearanceStore } = await import("../src/store/appearanceStore");
  useAppearanceStore.setState({ messageBodyFontSize: "lg" });
  const { row } = await renderMessage();
  assert.match(row.className, /\[--mi-avatar:2\.125rem\]/);
  useAppearanceStore.setState({ messageBodyFontSize: "md" });
});

test("the model label keeps the recipe's tight leading (no stray text-xs)", async () => {
  const { row } = await renderMessage({ agentMessage: true });
  const model = row.querySelector<HTMLElement>('[data-testid^="message-sender-model-"]');
  assert.ok(model, "model label renders for an agent message");
  // The stray `text-xs` used to displace the recipe's `leading-none` in the
  // merge and made agent header rows 2px taller than human ones. The tier
  // size class has the same displacing effect, so the tight leading is now
  // re-asserted elegant-scoped right after the size.
  assert.match(model.className, /(?:^| )in-data-\[theme=elegant\]:leading-none(?: |$)/);
  assert.match(model.className, /(?:^| )text-\[12px\](?: |$)/);
});
