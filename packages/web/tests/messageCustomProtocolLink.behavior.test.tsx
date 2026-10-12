import assert from "node:assert/strict";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import type { MentionEntry } from "../src/components/message/MessageItem";
import type { Agent } from "../src/store/agentStore";
import type { User } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import type { Message } from "../src/store/messageStore";
import type { Server, ServerMember } from "../src/store/serverStore";

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
}

Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });

const OBSIDIAN_URL = "obsidian://open?vault=Main";
const originalWindowOpen = window.open;
const openedUrls: string[] = [];

function makeUser(): User {
  return {
    id: "user-current", email: "current@example.com", gravatarHash: "", name: "current-user",
    displayName: "Current User", description: null, avatarUrl: null, emailVerified: true,
    preferredLanguage: null, preferredTimezone: null, autoTranslationEnabled: false,
    preferredTimeFormat: null, preferredMessageBodyFontSize: null, referralSource: null,
    referralSourceOther: null, referralSourceSkippedAt: null,
  };
}

function makeServer(): Server {
  return {
    id: "server-1", name: "Server", avatarUrl: null, slug: "server", ownerId: "user-current",
    onboardingAgentId: null, hideHumansFromMembers: false, plan: "free", planDowngradedAt: null,
    role: "owner", createdAt: "2026-10-07T00:00:00.000Z",
  };
}

function makeHuman(): ServerMember {
  return {
    userId: "human-writer", email: "writer@example.com", gravatarHash: "", name: "writer",
    displayName: "Writer", description: null, avatarUrl: null, role: "member",
    joinedAt: "2026-10-07T00:00:00.000Z",
  };
}

function makeAgent(): Agent {
  return {
    id: "agent-1", name: "agent", displayName: "Agent", avatarUrl: null,
    description: null, status: "idle", model: "gpt-5", runtime: "codex", serverRole: "member",
    runtimeConfig: null, lastRuntimeError: null, reasoningEffort: null, executionMode: "cloud",
    envVars: null, machineId: null, runtimeProfile: null, creatorType: null, creatorId: null,
    creator: null, createdAgents: [], deletedAt: null, createdAt: "2026-10-07T00:00:00.000Z",
  };
}

function makeChannel(name: string): Channel {
  return {
    id: `channel-${name}`, serverId: "server-1", name, type: "regular",
    description: null, archived: false, archivedAt: null, archivedBy: null, isDefault: false,
    createdAt: "2026-10-07T00:00:00.000Z",
  };
}

function makeMessage(content: string): Message {
  return {
    id: "message-1", channelId: "channel-all", senderType: "agent", senderId: "agent-1",
    senderName: "Agent", messageType: "chat", content,
    createdAt: "2026-10-07T00:00:00.000Z",
  } as Message;
}

async function loadMessageModules() {
  const [
    { default: MessageItem },
    { useAgentStore },
    { useAuthStore },
    { useChannelStore },
    { useMessageStore },
    { useServerStore },
  ] = await Promise.all([
    import("../src/components/message/MessageItem"),
    import("../src/store/agentStore"),
    import("../src/store/authStore"),
    import("../src/store/channelStore"),
    import("../src/store/messageStore"),
    import("../src/store/serverStore"),
  ]);
  return { MessageItem, useAgentStore, useAuthStore, useChannelStore, useMessageStore, useServerStore };
}

async function renderMessage(content: string, mentionMap = new Map<string, MentionEntry>()) {
  const channels = [makeChannel("all")];
  const { MessageItem, useAgentStore, useAuthStore, useChannelStore, useMessageStore, useServerStore } = await loadMessageModules();
  useAuthStore.setState({ user: makeUser(), accessToken: "token", refreshToken: "refresh", loading: false, initialized: true } as never);
  useServerStore.setState({ current: makeServer(), members: [makeHuman()] } as never);
  useAgentStore.setState({ agents: [makeAgent()], agentActivities: {} } as never);
  useChannelStore.setState({ channels, dmChannels: [] as Channel[] } as never);
  useMessageStore.setState({ drafts: {}, channelMessages: {}, currentChannelId: "channel-all", messages: [] } as never);
  const view = render(
    <MemoryRouter>
      <MessageItem message={makeMessage(content)} mentionMap={mentionMap} channels={channels} hideThreadActions />
    </MemoryRouter>,
  );
  const body = view.container.querySelector<HTMLElement>("[data-message-id='message-1']");
  assert.ok(body, "message body rendered");
  return { ...view, body };
}

beforeEach(() => {
  openedUrls.length = 0;
  window.open = ((url?: string | URL) => {
    openedUrls.push(String(url));
    return null;
  }) as typeof window.open;
});

afterEach(async () => {
  window.open = originalWindowOpen;
  cleanup();
  const { useAgentStore, useAuthStore, useChannelStore, useMessageStore, useServerStore } = await loadMessageModules();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMessageStore.setState(useMessageStore.getInitialState(), true);
});

test("clicking an obsidian:// message link asks for confirmation before opening", async () => {
  await renderMessage(`[Open note](${OBSIDIAN_URL})`);

  const link = screen.getByRole("link", { name: "Open note" }) as HTMLAnchorElement;
  assert.equal(link.getAttribute("href"), OBSIDIAN_URL);
  fireEvent.click(link);

  // The confirmation dialog names the target and no navigation has happened.
  assert.deepEqual(openedUrls, []);
  assert.ok(await screen.findByText("Open external link?"), "confirmation dialog shown");
  assert.ok(screen.getByText(OBSIDIAN_URL), "dialog shows the link target");

  fireEvent.click(screen.getByRole("button", { name: "Open link" }));
  assert.deepEqual(openedUrls, [OBSIDIAN_URL]);
  await waitFor(() => assert.ok(!screen.queryByText("Open external link?")));
});

test("canceling the custom-protocol confirmation does not open the link", async () => {
  await renderMessage(`[Open note](${OBSIDIAN_URL})`);

  fireEvent.click(screen.getByRole("link", { name: "Open note" }));
  assert.ok(await screen.findByText("Open external link?"), "confirmation dialog shown");

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  assert.deepEqual(openedUrls, []);
  await waitFor(() => assert.ok(!screen.queryByText("Open external link?")));
});

test("ordinary https links do not trigger the custom-protocol confirmation", async () => {
  await renderMessage("[Slock](https://slock.ai)");

  fireEvent.click(screen.getByRole("link", { name: "Slock" }));
  assert.ok(!screen.queryByText("Open external link?"));
});
