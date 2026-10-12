import assert from "node:assert/strict";
import { act } from "react";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import MessageInput from "../src/components/message/MessageInput";
import { useAuthStore } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import { useChannelStore } from "../src/store/channelStore";
import type { MessageMention, SendMessageResult } from "../src/store/messageStore";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";

// kabi-desktop task #133 (typing lag): a React-CONTROLLED <textarea> also
// rewrites its text child (`defaultValue`) on every keystroke. That DOM
// structure change makes Chrome re-evaluate every non-subject `:has()` rule
// against the whole page — measured ~58ms of style recalc per key in a
// 300-message channel, vs ~0.06ms for a `.value` write. The composer keeps
// `content` as the source of truth but writes the DOM value imperatively, so
// typing must never touch the textarea's child nodes.

const CHANNEL_ID = "channel-uncontrolled-composer";
const originalApiGet = api.get;

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
}
Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });

function setupStores(draft?: string) {
  const sent: string[] = [];
  const sendMessage = async (_channelId: string, content: string, _a: string[] = [], _t?: boolean, _o?: string, _r?: string, _m?: MessageMention[]): Promise<SendMessageResult> => {
    sent.push(content);
    return { messageId: `message-${sent.length}`, pendingMentionActions: [], unresolvedMentionHandles: [] };
  };
  api.get = (async () => ({ data: { agents: [], humans: [] } })) as typeof api.get;
  useAuthStore.setState({ user: { id: "user-1", email: "u@example.com", name: "u", displayName: "U" }, accessToken: "t", refreshToken: "r", loading: false, initialized: true } as never);
  useServerStore.setState({ current: { id: "server-1", name: "Server", slug: "server", role: "owner", plan: "free" }, members: [] } as never);
  useChannelStore.setState({
    channels: [{ id: CHANNEL_ID, serverId: "server-1", name: "general", type: "regular", description: null, archived: false, archivedAt: null, archivedBy: null, isDefault: false, createdAt: "2026-07-09T00:00:00.000Z" }],
    dmChannels: [] as Channel[],
  } as never);
  useMessageStore.setState({
    drafts: draft === undefined ? {} : { [CHANNEL_ID]: draft },
    channelMessages: { [CHANNEL_ID]: [] },
    currentChannelId: CHANNEL_ID,
    messages: [],
    sendMessage,
  } as never);
  return sent;
}

function renderComposer() {
  render(
    <MemoryRouter>
      <MessageInput channelId={CHANNEL_ID} channelName="#general" />
    </MemoryRouter>,
  );
  return screen.getByPlaceholderText("Message #general") as HTMLTextAreaElement;
}

afterEach(() => {
  cleanup();
  api.get = originalApiGet;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMessageStore.setState(useMessageStore.getInitialState(), true);
});

test("typing never rewrites the composer textarea's child nodes (no per-key structure change)", async () => {
  setupStores();
  const textarea = renderComposer();
  const records: MutationRecord[] = [];
  const observer = new MutationObserver((list) => records.push(...list));
  observer.observe(textarea, { childList: true, characterData: true, subtree: true });

  let typed = "";
  for (const ch of "hello world") {
    typed += ch;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: typed } });
    });
  }
  await act(async () => {});
  observer.disconnect();

  assert.equal(textarea.value, "hello world");
  assert.equal(records.length, 0, `typing mutated the textarea's children ${records.length} times (controlled-textarea defaultValue sync?)`);
  assert.equal(textarea.childNodes.length, 0, "the textarea carries no text child");
});

test("a saved draft is shown on mount, and sending clears the field", async () => {
  const sent = setupStores("draft body");
  const textarea = renderComposer();
  assert.equal(textarea.value, "draft body");

  await act(async () => {
    fireEvent.change(textarea, { target: { value: "draft body!" } });
  });
  const form = textarea.closest("form");
  assert.ok(form);
  await act(async () => {
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });
  await waitFor(() => assert.deepEqual(sent, ["draft body!"]));
  await waitFor(() => assert.equal(textarea.value, ""));
});
