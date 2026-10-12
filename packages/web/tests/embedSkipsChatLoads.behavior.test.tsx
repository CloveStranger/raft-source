import "./helpers/domSetup";
import assert from "node:assert/strict";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import api from "../src/api/client";
import { __setEmbedModeForTests } from "../src/embed";
import type { EmbedMode } from "../src/embed";
import SettingsPanel from "../src/components/settings/SettingsPanel";
import { useFeedbackUnread } from "../src/feedback/useFeedbackUnread";
import { useAgentStore } from "../src/store/agentStore";
import { useAnnouncementStore } from "../src/store/announcementStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { createMainLayoutRealtimeBridgeDriver } from "../src/store/socketBridge";
import type { MainLayoutSocketBridgeSocket } from "../src/store/socketBridge";
import { useTranslationStore } from "../src/store/translationStore";
import { TestIntlProvider } from "./helpers/intl";

/**
 * The host-shell gates outside the boot path: focus recovery, the server
 * store's sidebar-order and unread-summary loads, the feedback unread poll, and
 * the settings panel asking for the channel list itself. Each case runs the
 * real callsite in a host-shell embed and in the full app.
 */

const HOST_SHELL: EmbedMode = { embedded: true, shell: "host" };
const FULL_APP: EmbedMode = { embedded: false, shell: "web" };
const SERVER = { id: "s1", slug: "s1", name: "S1", role: "owner" } as unknown as Server;

const originalGet = api.get;
const originalPost = api.post;
let restoreEmbed: (() => void) | null = null;

function enter(mode: EmbedMode) {
  restoreEmbed = __setEmbedModeForTests(mode);
}

/** Records every GET path and answers with an empty payload. */
function recordGets() {
  const paths: string[] = [];
  api.get = (async (url: string) => {
    paths.push(url);
    if (url === "/servers") return { data: [SERVER] };
    const isList = /\/(members|agents|machines|channels|dm|invites|join-links|unread-summary)$/.test(url);
    return { data: isList ? [] : {} };
  }) as typeof api.get;
  api.post = (async () => ({ data: {} })) as typeof api.post;
  return paths;
}

afterEach(() => {
  cleanup();
  restoreEmbed?.();
  restoreEmbed = null;
  api.get = originalGet;
  api.post = originalPost;
  localStorage.clear();
  useServerStore.setState(useServerStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useTranslationStore.setState(useTranslationStore.getInitialState(), true);
  useAuthStore.setState({ user: null } as never);
});

class FakeSocket implements MainLayoutSocketBridgeSocket {
  connected = true;
  emit() { return undefined; }
  on() { return undefined; }
  off() { return undefined; }
  onAny() { return undefined; }
  offAny() { return undefined; }
  disconnect() { this.connected = false; }
  connect() { this.connected = true; }
}

/** Installs the real recovery bridge, fires a window focus, and counts loaders. */
function recoverOnFocus() {
  const calls = { unread: 0, markRead: 0, sidebarOrder: 0, announcements: 0, machines: 0, agents: 0 };
  const saved = {
    unread: useMessageStore.getState().loadUnreadCounts,
    markRead: useMessageStore.getState().markCurrentChannelRead,
    sidebarOrder: useServerStore.getState().loadSidebarOrder,
    announcements: useAnnouncementStore.getState().load,
    machines: useMachineStore.getState().loadMachines,
    agents: useAgentStore.getState().loadAgents,
    resetSeq: useAgentStore.getState().resetActivitySeq,
  };
  useMessageStore.setState({
    loadUnreadCounts: async () => { calls.unread += 1; },
    markCurrentChannelRead: () => { calls.markRead += 1; },
  } as never);
  useServerStore.setState({ loadSidebarOrder: async () => { calls.sidebarOrder += 1; } } as never);
  useAnnouncementStore.setState({ load: async () => { calls.announcements += 1; } } as never);
  useMachineStore.setState({ loadMachines: async () => { calls.machines += 1; } } as never);
  useAgentStore.setState({ loadAgents: async () => { calls.agents += 1; }, resetActivitySeq: () => undefined } as never);
  // Recovery only reloads for a visible, online page that has a stored session.
  localStorage.setItem("slock_access_token", "a");
  localStorage.setItem("slock_refresh_token", "r");
  const onLine = Object.getOwnPropertyDescriptor(navigator, "onLine");
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  const socket = new FakeSocket();
  const uninstall = createMainLayoutRealtimeBridgeDriver({
    getSocket: () => socket,
    reconnectSocket: () => undefined,
    ensureSocketConnected: () => undefined,
    isSocketConnected: () => true,
  }).install();
  try {
    window.dispatchEvent(new window.Event("focus"));
  } finally {
    uninstall();
    if (onLine) Object.defineProperty(navigator, "onLine", onLine);
    else delete (navigator as { onLine?: boolean }).onLine;
    useMessageStore.setState({ loadUnreadCounts: saved.unread, markCurrentChannelRead: saved.markRead } as never);
    useServerStore.setState({ loadSidebarOrder: saved.sidebarOrder } as never);
    useAnnouncementStore.setState({ load: saved.announcements } as never);
    useMachineStore.setState({ loadMachines: saved.machines } as never);
    useAgentStore.setState({ loadAgents: saved.agents, resetActivitySeq: saved.resetSeq } as never);
  }
  return calls;
}

test("focus recovery in a host-shell embed reloads computers and agents only", () => {
  enter(HOST_SHELL);
  assert.deepEqual(recoverOnFocus(), { unread: 0, markRead: 0, sidebarOrder: 0, announcements: 0, machines: 1, agents: 1 });
});

test("focus recovery in the full app still reloads the chat data", () => {
  enter(FULL_APP);
  assert.deepEqual(recoverOnFocus(), { unread: 1, markRead: 1, sidebarOrder: 1, announcements: 1, machines: 1, agents: 1 });
});

async function switchServerAndSummarise() {
  const paths = recordGets();
  useServerStore.setState({ servers: [SERVER] } as never);
  await act(async () => {
    useServerStore.getState().setCurrent(SERVER);
    await useServerStore.getState().loadServerUnreadSummary();
  });
  await waitFor(() => assert.ok(paths.includes("/servers/s1/members")));
  return paths;
}

test("a host-shell embed switches server without the sidebar order or the unread summary", async () => {
  enter(HOST_SHELL);
  const paths = await switchServerAndSummarise();
  assert.equal(paths.filter((p) => p === "/servers/s1/sidebar-order").length, 0);
  assert.equal(paths.filter((p) => p === "/servers/unread-summary").length, 0);
  assert.ok(paths.includes("/servers/s1/settings"), "server settings are still loaded");
});

test("the full app still loads the sidebar order and the unread summary on a server switch", async () => {
  enter(FULL_APP);
  const paths = await switchServerAndSummarise();
  assert.equal(paths.filter((p) => p === "/servers/s1/sidebar-order").length, 1);
  assert.equal(paths.filter((p) => p === "/servers/unread-summary").length, 1);
});

/** `loadServers` ends by refreshing the current server's members and sidebar order. */
async function reloadServerList() {
  const paths = recordGets();
  useServerStore.setState({ servers: [SERVER], current: SERVER } as never);
  await act(async () => {
    await useServerStore.getState().loadServers();
  });
  await waitFor(() => assert.ok(paths.includes("/servers/s1/members")));
  return paths.filter((p) => p === "/servers/s1/sidebar-order").length;
}

test("reloading the server list in a host-shell embed does not fetch the sidebar order", async () => {
  enter(HOST_SHELL);
  assert.equal(await reloadServerList(), 0);
});

test("reloading the server list in the full app still fetches the sidebar order", async () => {
  enter(FULL_APP);
  assert.equal(await reloadServerList(), 1);
});

async function feedbackPollCalls() {
  const paths = recordGets();
  useAuthStore.setState({ user: { id: "alice" } } as never);
  const hook = renderHook(() => useFeedbackUnread());
  await act(async () => { await Promise.resolve(); });
  hook.unmount();
  return paths.filter((p) => p === "/product-feedback/tickets").length;
}

test("a host-shell embed does not start the feedback unread poll", async () => {
  enter(HOST_SHELL);
  assert.equal(await feedbackPollCalls(), 0);
});

test("the full app still starts the feedback unread poll", async () => {
  enter(FULL_APP);
  assert.equal(await feedbackPollCalls(), 1);
});

/** Renders the real settings panel and counts channel-list loads. */
async function settingsChannelLoads() {
  recordGets();
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = ((query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as never;
  }
  useAuthStore.setState({ user: { id: "user-1", email: "u@example.com", name: "U", displayName: "U" }, initialized: true } as never);
  useServerStore.setState({ servers: [SERVER], current: SERVER, members: [], loading: false } as never);
  let loads = 0;
  useChannelStore.setState({ loadChannels: async () => { loads += 1; } } as never);
  render(
    <TestIntlProvider locale="en">
      <MemoryRouter>
        <SettingsPanel tab="administration" />
      </MemoryRouter>
    </TestIntlProvider>,
  );
  await act(async () => { await Promise.resolve(); });
  return loads;
}

test("the settings panel loads the channel list itself in a host-shell embed", async () => {
  enter(HOST_SHELL);
  assert.equal(await settingsChannelLoads(), 1);
});

test("the settings panel leaves the channel list to the chat boot in the full app", async () => {
  enter(FULL_APP);
  assert.equal(await settingsChannelLoads(), 0);
});
