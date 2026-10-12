import assert from "node:assert/strict";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import "./helpers/domSetup";
import { TestIntlProvider } from "./helpers/intl";
import AgentDetailPanel from "../src/components/agent/AgentDetailPanel";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";

// Runtime-error sentinel render-path tooth (@Wug 2026-08-04): the AgentDetail
// banner must show the classified catalog copy for a KNOWN runtime error under
// zh, and the generic fallback for an UNKNOWN one — never the raw English.

const noop = () => {};

function seedStores(agent: Record<string, unknown>) {
  useAuthStore.setState({ user: { id: "user-1", name: "Owner" } } as never);
  useServerStore.setState({
    current: { id: "server-1", slug: "playwright-server", name: "Playwright Server", role: "owner" },
    members: [],
  } as never);
  useMachineStore.setState({ machines: [] } as never);
  useChannelStore.setState({ openDM: noop } as never);
  useAgentStore.setState({
    agents: [agent],
    activityLogs: {},
  } as never);
}

function renderAgentZh(agent: Record<string, unknown>) {
  seedStores(agent);
  return render(
    <MemoryRouter>
      <TestIntlProvider locale="zh-cn">
        <AgentDetailPanel agent={agent as never} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  useAgentStore.setState({ agents: [], activityLogs: {} } as never);
  useServerStore.setState({ current: null, members: [] } as never);
  useAuthStore.setState({ user: null } as never);
});

test("XX1138 mounted model failure shows the localized model name", async () => {
  const agent = { id: "agent-sf-render", name: "sf", runtime: "codex", status: "inactive", createdBy: "user-1" };
  useAgentStore.setState({agentActivities: {[agent.id]: {
    activity: "offline", detailKind: "runtime_unavailable", activityDetail: "Synthetic failure detail",
    spawnFailure: {reason: "model_not_found", model: "missing-model-test"},
  }}} as never);
  renderAgentZh(agent);
  assert.ok(await screen.findByText('该运行时没有可用的模型「missing-model-test」：可能已改名或下架，或它的服务商在这台电脑上没有可用的 API 密钥——请在 Agent 设置里换模型或修正密钥'));
});

test("known runtime error renders the classified zh in the agent banner", async () => {
  const agent = {
    id: "agent-1",
    name: "witty",
    runtime: "claude",
    status: "active",
    lastRuntimeError: { message: "Claude Code is not logged in on this machine. Please log in locally, then retry." },
  };
  renderAgentZh(agent);

  assert.ok(await screen.findByText("该运行时未在此计算机上登录"));
  assert.equal(screen.queryByText(/is not logged in/), null);
});

test("unknown runtime error stays verbatim for the creator — never mistranslated", async () => {
  // @Wug boundary: unknown errors are NOT substring-translated. For the
  // creator view the raw text stays (verbatim, per the boundary); it must
  // never be wrongly classified into a known-kind zh message.
  const agent = {
    id: "agent-2",
    name: "mystery",
    runtime: "claude",
    status: "active",
    lastRuntimeError: { message: "The daemon lost its connection to the workspace broker." },
  };
  renderAgentZh(agent);

  assert.ok(await screen.findByText(/workspace broker/), "unknown error stays verbatim for the creator");
  assert.equal(screen.queryByText("该运行时未在此计算机上登录"), null, "no wrong classification");
  assert.equal(screen.queryByText("该运行时未安装在此计算机上"), null);
});

test("typed runtime error surfaces the authoritative daemon class/reason/fingerprint (#688d)", async () => {
  const agent = {
    id: "agent-3",
    name: "typed",
    runtime: "claude",
    status: "active",
    lastRuntimeError: {
      message: "Authentication failed: not logged in on this machine.",
      errorClass: "AuthError",
      errorReason: "auth_failed",
      fingerprint: "abcd1234567890ef",
      reasonProvenance: "daemon_fallback",
    },
  };
  renderAgentZh(agent);

  // Authoritative typed auth class/reason drives the catalog copy (auth_failed → authFailed label).
  assert.ok(await screen.findByText("运行时身份验证失败"), "typed auth class maps to catalog copy");
  // The typed class/reason/fingerprint ride in the diagnostic payload (copy/debug surface),
  // not the banner text — wait for the label, then confirm no wrong untyped classification.
  assert.equal(screen.queryByText("该运行时未在此计算机上登录"), null, "typed auth must not fall to the untyped notLoggedIn label");
});

test("unknown-type runtime error stays verbatim even with typed fields present if reason is unmapped (#688d)", async () => {
  const agent = {
    id: "agent-4",
    name: "typed-unknown",
    runtime: "claude",
    status: "active",
    lastRuntimeError: {
      message: "The daemon lost its connection to the workspace broker.",
      errorClass: "ProviderConnectionError",
      errorReason: "provider_connection_error",
      fingerprint: "ffff000011112222",
      reasonProvenance: "daemon_fallback",
    },
  };
  renderAgentZh(agent);

  assert.ok(await screen.findByText(/workspace broker/), "unknown typed error stays verbatim");
  assert.equal(screen.queryByText("该运行时未在此计算机上登录"), null, "no wrong classification");
});

// task #735 — the "not installed" banner arm splits on the start failure's
// typed lookup reason. Only a confirmed miss (not_on_path) keeps the install
// copy; everything else — including an old daemon with no reason field —
// is unresolved and must never read as "install it".

const NOT_INSTALLED_MESSAGE = "Codex CLI is not installed on this computer.";
const INSTALL_COPY_ZH = "该运行时未安装在此计算机上";
const TIMEOUT_COPY_ZH = "检查此 Computer 上的 Codex CLI 超时。请重试，或查看此 Computer 的状态。";
const PERMISSION_COPY_ZH = "无法检查此 Computer 上的 Codex CLI：权限被拒绝。请检查那台机器的权限后重试。";
const NEUTRAL_COPY_ZH = "无法确认此 Computer 上是否有 Codex CLI。请重试，或查看此 Computer 的状态。";

function renderLookupFailureZh(id: string, spawnFailure?: { reason: string; lookupReason?: string }) {
  const agent = {
    id,
    name: id,
    runtime: "codex",
    status: "active",
    createdBy: "user-1",
    lastRuntimeError: { message: NOT_INSTALLED_MESSAGE },
  };
  if (spawnFailure) {
    useAgentStore.setState({
      agentActivities: {
        [id]: {
          activity: "offline",
          detailKind: "runtime_unavailable",
          activityDetail: "Runtime executable not found. Ensure the required CLI is installed and available on PATH.",
          spawnFailure,
        },
      },
    } as never);
  }
  return renderAgentZh(agent);
}

test("task #735: a confirmed launch miss (not_on_path) keeps the install copy", async () => {
  renderLookupFailureZh("agent-lr-confirmed", { reason: "runtime_not_found", lookupReason: "not_on_path" });
  assert.ok(await screen.findByText(INSTALL_COPY_ZH));
  assert.ok(screen.queryByText(NEUTRAL_COPY_ZH) === null);
});

test("task #735: a timed-out launch lookup (lookup_timed_out) gets the timeout arm", async () => {
  renderLookupFailureZh("agent-lr-timeout", { reason: "runtime_not_found", lookupReason: "lookup_timed_out" });
  assert.ok(await screen.findByText(TIMEOUT_COPY_ZH));
  assert.ok(screen.queryByText(INSTALL_COPY_ZH) === null, "a timed-out lookup is not evidence of a missing runtime");
});

test("task #735: a denied launch lookup (lookup_permission_denied) gets the permission arm", async () => {
  renderLookupFailureZh("agent-lr-denied", { reason: "runtime_not_found", lookupReason: "lookup_permission_denied" });
  assert.ok(await screen.findByText(PERMISSION_COPY_ZH));
  assert.ok(screen.queryByText(INSTALL_COPY_ZH) === null);
});

test("task #735: an unresolved launch lookup (lookup_failed) gets the neutral arm", async () => {
  renderLookupFailureZh("agent-lr-failed", { reason: "runtime_not_found", lookupReason: "lookup_failed" });
  assert.ok(await screen.findByText(NEUTRAL_COPY_ZH));
  assert.ok(screen.queryByText(INSTALL_COPY_ZH) === null);
});

test("task #735: old-daemon compat — runtime_not_found with no lookupReason is the neutral arm", async () => {
  renderLookupFailureZh("agent-lr-old-daemon", { reason: "runtime_not_found" });
  assert.ok(await screen.findByText(NEUTRAL_COPY_ZH));
  assert.ok(screen.queryByText(INSTALL_COPY_ZH) === null, "no reason field means unresolved, never install guidance");
});

test("task #735: a not-installed text match with no typed carrier at all is also unresolved", async () => {
  renderLookupFailureZh("agent-lr-untyped");
  assert.ok(await screen.findByText(NEUTRAL_COPY_ZH));
  assert.ok(screen.queryByText(INSTALL_COPY_ZH) === null);
});
