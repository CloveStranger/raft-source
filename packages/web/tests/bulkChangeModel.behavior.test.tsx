import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import api from "../src/api/client";
import BulkChangeModelDialog from "../src/components/machine/BulkChangeModelDialog";
import MachineDetailPanel from "../src/components/machine/MachineDetailPanel";
import { runtimeAccountUsageClient } from "../src/utils/runtimeAccountUsageClient";
import { useAgentStore } from "../src/store/agentStore";
import { useBulkChangeModelReceiptStore } from "../src/store/bulkChangeModelReceiptStore";
import { useMachineStore } from "../src/store/machineStore";
import type { Machine } from "../src/store/machineStore";
import {
  BULK_CHANGE_MODEL_WEB_FLAG_KEY,
  resetServerFeatureFlagsForTests,
  setServerFeatureFlagForTests,
} from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { renderWithIntl } from "./helpers/intl";

// task #1287 (designs task #1285): bulk "Change model" on the Computer page.
const initialAgentState = useAgentStore.getState();
const initialMachineState = useMachineStore.getState();
const initialServerState = useServerStore.getState();
const initialReceiptState = useBulkChangeModelReceiptStore.getState();
const originalGet = api.get;
const originalPost = api.post;
const originalPatch = api.patch;

const server: Server = {
  id: "server-1",
  name: "Acme",
  avatarUrl: null,
  slug: "acme",
  ownerId: "user-1",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "free",
  planDowngradedAt: null,
  role: "owner",
  createdAt: "2026-09-01T00:00:00.000Z",
};

const machine: Machine = {
  id: "computer-1",
  name: "Model Mac",
  description: null,
  status: "online",
  statusVersion: 1,
  apiKeyPrefix: null,
  runtimes: ["claude", "codex"],
  hostname: "model-mac.local",
  os: "darwin",
  daemonVersion: "1.0.0",
  isComputer: true,
  computerAttachedByCurrentUser: true,
  computerVersion: "1.0.0",
  computerUpgradeAvailable: false,
  lastHeartbeat: null,
  createdAt: "2026-09-01T00:00:00.000Z",
};

function seedAgents() {
  const base = { status: "inactive", machineId: "computer-1", runtime: "claude", reasoningEffort: null, runtimeConfig: null, envVars: null, avatarUrl: null };
  useAgentStore.setState({
    agents: [
      { ...base, id: "ada", name: "ada", displayName: "Ada", model: "sonnet" },
      { ...base, id: "bolt", name: "bolt", displayName: "Bolt", model: "haiku" },
    ],
  } as never);
}

function renderMachine() {
  useServerStore.setState({ current: server, members: [] });
  useMachineStore.setState({ computerOperationProgress: {} });
  seedAgents();
  return renderWithIntl(
    <MemoryRouter initialEntries={[`/s/acme/settings/computers/${machine.id}`]}>
      <MachineDetailPanel machine={machine} hideHeader />
    </MemoryRouter>,
  );
}

function selectBothAgents() {
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  fireEvent.click(screen.getByRole("button", { name: "Select Ada" }));
  fireEvent.click(screen.getByRole("button", { name: "Select Bolt" }));
}

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  api.patch = originalPatch;
  resetServerFeatureFlagsForTests();
  useAgentStore.setState(initialAgentState, true);
  useMachineStore.setState(initialMachineState, true);
  useServerStore.setState(initialServerState, true);
  useBulkChangeModelReceiptStore.setState(initialReceiptState, true);
  runtimeAccountUsageClient.clear();
});

test("the Change model button is not rendered while the flag is off", () => {
  renderMachine();
  selectBothAgents();
  assert.ok(screen.queryByTestId("bulk-change-model-button") === null);
});

test("a save that fails after the config landed becomes restart_pending, and Try again only restarts that agent", async () => {
  setServerFeatureFlagForTests("server-1", BULK_CHANGE_MODEL_WEB_FLAG_KEY, true);
  const patches: Array<{ url: string; body: Record<string, unknown> }> = [];
  const posts: Array<{ url: string; body: unknown }> = [];
  let boltSaved: Record<string, unknown> | null = null;

  api.get = (async (url: string) => {
    if (url === "/agents/bolt") {
      // Fresh read: the server stored Bolt's new config before the request failed.
      return { data: { id: "bolt", runtime: "claude", model: boltSaved?.model, reasoningEffort: boltSaved?.reasoningEffort ?? null } };
    }
    // Runtime model discovery fails: the dialog falls back to the bundled list.
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.patch = (async (url: string, body: Record<string, unknown>) => {
    patches.push({ url, body });
    if (url === "/agents/bolt") {
      boltSaved = body;
      throw new Error("restart failed after save");
    }
    return { data: { id: url.split("/").pop(), ...body } };
  }) as typeof api.patch;
  api.post = (async (url: string, body: unknown) => {
    posts.push({ url, body });
    return { data: { evaluations: [] } };
  }) as typeof api.post;

  renderMachine();
  selectBothAgents();
  fireEvent.click(screen.getByTestId("bulk-change-model-button"));

  const dialog = await screen.findByTestId("bulk-change-model-dialog");
  const next = within(dialog).getByTestId("bulk-model-next");
  await waitFor(() => assert.equal((next as HTMLButtonElement).disabled, false));
  fireEvent.click(next);

  // Review: one row per agent, Claude -> Claude so only the model is shown, no restart line.
  await within(dialog).findByTestId("bulk-model-review-list");
  assert.equal(within(dialog).getByTestId("bulk-model-row-ada").getAttribute("data-row-kind"), "change");
  assert.equal(within(dialog).getByTestId("bulk-model-row-bolt").getAttribute("data-row-kind"), "change");
  assert.ok(within(dialog).queryByTestId("bulk-model-restart-line") === null);
  fireEvent.click(within(dialog).getByTestId("bulk-model-apply"));

  const banner = await screen.findByTestId("bulk-model-partial-banner");
  assert.match(banner.textContent ?? "", /1 of 2 changes didn't finish\./);
  assert.equal(patches.length, 2);
  for (const patch of patches) {
    assert.equal(patch.body.runtime, "claude");
    assert.equal(patch.body.model, "opus");
    assert.equal("restartMode" in patch.body, false, "stopped agents are saved, not restarted");
  }
  // 5c exits select mode.
  assert.ok(screen.getByRole("button", { name: "Select" }));

  fireEvent.click(screen.getByTestId("bulk-model-try-again"));
  const retryDialog = await screen.findByTestId("bulk-change-model-dialog");
  const retryNext = within(retryDialog).getByTestId("bulk-model-next");
  await waitFor(() => assert.equal((retryNext as HTMLButtonElement).disabled, false));
  fireEvent.click(retryNext);
  await within(retryDialog).findByTestId("bulk-model-review-list");
  // Only the unfinished agent comes back, and it owes a restart, not a no-op.
  assert.ok(within(retryDialog).queryByTestId("bulk-model-row-ada") === null);
  assert.equal(within(retryDialog).getByTestId("bulk-model-row-bolt").getAttribute("data-row-kind"), "restartOnly");
  assert.ok(within(retryDialog).getByTestId("bulk-model-restart-line"));
  fireEvent.click(within(retryDialog).getByTestId("bulk-model-apply"));

  await screen.findByTestId("bulk-model-success-banner");
  const resets = posts.filter((p) => p.url === "/agents/bolt/reset");
  assert.deepEqual(resets.map((p) => p.body), [{ mode: "restart" }]);
  assert.equal(patches.length, 2, "the retry must not resend the config");
  assert.ok(screen.queryByTestId("bulk-model-partial-banner") === null);
});

for (const canViewUsage of [true, false]) {
  test(`runtime usage in the runtime list is read only when the viewer may see usage (${canViewUsage ? "allowed" : "not allowed"})`, async () => {
    useServerStore.setState({ current: server, members: [] });
    seedAgents();
    const usageReads: string[] = [];
    api.get = (async (url: string) => {
      if (url.includes("/runtime-account-usage/")) {
        usageReads.push(url);
        return {
          data: {
            state: "fresh",
            snapshot: {
              protocolVersion: 2, provider: url.endsWith("/codex") ? "codex" : "claude",
              collectedAt: "2026-10-11T10:00:00.000Z", staleAfter: "2099-01-01T00:00:00.000Z", collectorVersion: "t",
              accounts: [{ accountKey: "k", health: "ok", planLabel: "Max", windows: [{ id: "5h", label: "5-hour", status: "ok", usedRatio: 0.42 }] }],
            },
          },
        };
      }
      throw new Error(`unexpected GET ${url}`);
    }) as typeof api.get;
    const agents = useAgentStore.getState().agents;
    renderWithIntl(
      <BulkChangeModelDialog
        machine={machine}
        agents={agents}
        isRunning={() => false}
        canViewUsage={canViewUsage}
        onClose={() => {}}
        onOpenAgent={() => {}}
        onFinished={() => {}}
      />,
    );
    await screen.findByTestId("bulk-change-model-dialog");
    if (canViewUsage) {
      await waitFor(() => assert.equal(usageReads.length, 2));
      assert.ok(usageReads.some((u) => u.endsWith("/runtime-account-usage/claude")));
      assert.ok(usageReads.some((u) => u.endsWith("/runtime-account-usage/codex")));
    } else {
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(usageReads.length, 0);
    }
  });
}
