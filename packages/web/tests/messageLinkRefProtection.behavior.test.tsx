import assert from "node:assert/strict";
import { MemoryRouter } from "react-router-dom";
import { cleanup, render as rtlRender, screen } from "@testing-library/react";
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

async function setupStores(channels: Channel[]) {
  const stores = await loadMessageModules();
  const { useAgentStore, useAuthStore, useChannelStore, useMessageStore, useServerStore } = stores;
  useAuthStore.setState({ user: makeUser(), accessToken: "token", refreshToken: "refresh", loading: false, initialized: true } as never);
  useServerStore.setState({ current: makeServer(), members: [makeHuman()] } as never);
  useAgentStore.setState({ agents: [makeAgent()], agentActivities: {} } as never);
  useChannelStore.setState({ channels, dmChannels: [] as Channel[] } as never);
  useMessageStore.setState({ drafts: {}, channelMessages: {}, currentChannelId: "channel-all", messages: [] } as never);
  return stores;
}

async function renderMessage(content: string, mentionMap = new Map<string, MentionEntry>()) {
  const channels = [makeChannel("all")];
  const { MessageItem } = await setupStores(channels);
  const view = render(
    <MemoryRouter>
      <MessageItem message={makeMessage(content)} mentionMap={mentionMap} channels={channels} hideThreadActions />
    </MemoryRouter>,
  );
  const body = view.container.querySelector<HTMLElement>("[data-message-id='message-1']");
  assert.ok(body, "message body rendered");
  return { ...view, body };
}

function messageReferenceTexts(body: HTMLElement): string[] {
  return Array.from(body.querySelectorAll<HTMLElement>('[data-slot="message-reference"]'))
    .map((element) => element.textContent?.trim() ?? "")
    .filter(Boolean);
}

function mentionTriggerTexts(body: HTMLElement): string[] {
  return Array.from(body.querySelectorAll<HTMLAnchorElement>('a[data-slot="preview-card-trigger"]'))
    .map((element) => element.textContent?.trim() ?? "")
    .filter(Boolean);
}

afterEach(async () => {
  cleanup();
  const { useAgentStore, useAuthStore, useChannelStore, useMessageStore, useServerStore } = await loadMessageModules();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMessageStore.setState(useMessageStore.getInitialState(), true);
});

test("markdown links keep URL fragments that look like channel refs inside the href", async () => {
  const url = "https://mail.google.com/mail/u/1/#all/1a107c4e61aec24a";
  const { body } = await renderMessage(`[Gmail原线程](${url})`);

  const link = screen.getByRole("link", { name: "Gmail原线程" }) as HTMLAnchorElement;
  assert.equal(link.getAttribute("href"), url);
  assert.equal(link.getAttribute("target"), "_blank");
  assert.deepEqual(messageReferenceTexts(body), []);
  assert.deepEqual(mentionTriggerTexts(body), []);
});

test("bare URLs keep fragment channel refs as part of the external link", async () => {
  const url = "https://mail.google.com/mail/u/1/#all/1a107c4e61aec24a";
  const { body } = await renderMessage(`Gmail原线程 ${url} then #all`);

  const link = body.querySelector<HTMLAnchorElement>(`a[href="${url}"]`);
  assert.ok(link, "bare URL renders as one external link");
  assert.equal(link.textContent, url);
  assert.deepEqual(messageReferenceTexts(body), ["#all"]);
});

test("bare URLs keep @ handles as URL text instead of message mentions", async () => {
  const url = "https://medium.com/@writer/story";
  const mentionMap = new Map<string, MentionEntry>([
    ["writer", { displayName: "Writer", type: "user", id: "human-writer" }],
  ]);
  const { body } = await renderMessage(`article ${url}`, mentionMap);

  const link = body.querySelector<HTMLAnchorElement>(`a[href="${url}"]`);
  assert.ok(link, "URL with @handle renders as one external link");
  assert.equal(link.textContent, url);
  assert.deepEqual(mentionTriggerTexts(body), []);

  cleanup();
  const rerendered = await renderMessage(`article ${url} and @writer`, mentionMap);
  assert.ok(rerendered.body.querySelector<HTMLAnchorElement>(`a[href="${url}"]`));
  assert.deepEqual(mentionTriggerTexts(rerendered.body), ["@Writer"]);
});
