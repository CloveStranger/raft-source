import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import { ComputerRow } from "../src/components/layout/Sidebar";
import MachineDetailPanel from "../src/components/machine/MachineDetailPanel";
import { en } from "../src/i18n/messages/en";
import { useAgentStore } from "../src/store/agentStore";
import { useMachineStore } from "../src/store/machineStore";
import type { Machine, MachineUpgradeRequest } from "../src/store/machineStore";
import {
  REMOTE_COMPUTER_UPGRADE_V2_FLAG_KEY,
  resetServerFeatureFlagsForTests,
  setServerFeatureFlagForTests,
} from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { COMPUTER_UPGRADE_REQUEST_DEADLINE_MS, computerUpgradeInFlight } from "../src/utils/computerUpgradeInFlight";
import { renderWithIntl } from "./helpers/intl";

// Replays xxchan's 10-12 recording (xxdev3, 1.0.45 → 1.0.47): click Upgrade,
// the Computer goes offline for its restart (02:43:06) and reconnects on the
// new version 9 s later (02:43:15). The detail page and the sidebar row must
// say "upgrading" through the restart, never "offline", and then show the new
// version. The refresh after the click here returns the row WITHOUT the
// pending request: the page must not depend on a later read carrying it.

const initialAgentState = useAgentStore.getState();
const initialMachineState = useMachineStore.getState();
const initialServerState = useServerStore.getState();
const originalPost = api.post;

afterEach(() => {
  cleanup();
  api.post = originalPost;
  resetServerFeatureFlagsForTests();
  useAgentStore.setState(initialAgentState, true);
  useMachineStore.setState(initialMachineState, true);
  useServerStore.setState(initialServerState, true);
});

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
  createdAt: "2026-07-13T00:00:00.000Z",
};

function computer(overrides: Partial<Machine> = {}): Machine {
  return {
    id: "computer-1",
    name: "xxdev3",
    description: null,
    status: "online",
    statusVersion: 1,
    apiKeyPrefix: null,
    runtimes: [],
    hostname: "xxdev3",
    os: "linux x64",
    daemonVersion: null,
    isComputer: true,
    computerAttachedByCurrentUser: true,
    computerVersion: "1.0.45",
    computerUpgradeAvailable: true,
    remoteUpgradeSupported: true,
    computerBroadcastPolicy: {
      eligibility: "eligible",
      targetVersion: "1.0.47",
      targetRole: null,
      migrationClass: "seamless",
      policyRevision: "policy-1",
      reasonCode: "eligible",
    },
    upgradeRequest: null,
    lastHeartbeat: "2026-10-12T02:42:00.000Z",
    createdAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

const pending: MachineUpgradeRequest = {
  id: "request-1",
  targetVersion: "1.0.47",
  requestedAt: "2026-10-12T02:42:10.000Z",
  state: "pending",
  observedVersion: null,
  reason: null,
  resolvedAt: null,
};

function Live() {
  const machine = useMachineStore((s) => s.machines[0]!);
  return (
    <MemoryRouter initialEntries={["/s/acme/settings/computers/computer-1"]}>
      <ComputerRow machineId={machine.id} selected={false} onSelect={() => {}} />
      <MachineDetailPanel machine={machine} hideHeader deploymentEnv="production" />
    </MemoryRouter>
  );
}

function render() {
  useServerStore.setState({ current: server, members: [] });
  useAgentStore.setState({ agents: [] });
  useMachineStore.setState({
    machines: [computer()],
    computerOperationProgress: {},
    latestComputerVersion: "1.0.47",
    // The refresh after the click lands without the pending row.
    loadMachines: async () => {
      useMachineStore.setState((s) => ({ machines: s.machines.map((m) => ({ ...m, upgradeRequest: null })) }));
    },
  });
  setServerFeatureFlagForTests("server-1", REMOTE_COMPUTER_UPGRADE_V2_FLAG_KEY, true);
  api.post = (async () => ({ data: { upgradeRequest: pending } })) as unknown as typeof api.post;
  return renderWithIntl(<Live />);
}

const rowText = () => screen.getByTestId("computer-list-item-computer-1").textContent ?? "";
const reconnectingCopy = en["machine.detail.upgradeStatus.reconnecting"].replace("{version}", "1.0.47");

test("web upgrade replay: upgrading through the restart on both surfaces, then the new version", async () => {
  render();
  const upgrade = within(screen.getByTestId("computer-upgrade-actions"))
    .getByRole("button", { name: en["machine.detail.upgradeToVersion"].replace("{version}", "1.0.47") });
  await act(async () => {
    fireEvent.click(upgrade);
  });
  await waitFor(() => assert.ok(useMachineStore.getState().computerUpgradeAccepted["computer-1"]));

  // 02:43:06 — offline for the restart.
  act(() => {
    useMachineStore.getState().applyMachineStatusEvent("computer-1", "offline", 2);
  });
  assert.equal(screen.getByTestId("computer-upgrade-reconnecting").textContent?.includes(reconnectingCopy), true);
  assert.ok(screen.queryByTestId("computer-recovery-card") === null, "no offline recovery card mid-restart");
  assert.equal(screen.getByTestId("machine-connection-status").textContent, en["machine.detail.upgradeV2.inProgress"]);
  assert.ok(screen.getByTestId("computer-upgrade-reconnecting-computer-1"), "the sidebar row says upgrading too");
  assert.equal(rowText().includes(en["machine.runLabel.computerOffline"]), false, "the sidebar row never says offline");
  assert.match(screen.getByTestId("computer-status-dot-computer-1").className, /bg-brutal-cyan/);

  // 02:43:15 — back online, ready reports 1.0.47.
  act(() => {
    useMachineStore.getState().applyMachineStatusEvent("computer-1", "online", 3);
    useMachineStore.getState().updateMachineCapabilities("computer-1", [], "xxdev3", "linux x64", undefined, "1.0.47");
  });
  assert.ok(screen.queryByTestId("computer-upgrade-reconnecting") === null);
  assert.ok(screen.queryByTestId("computer-upgrade-reconnecting-computer-1") === null);
  assert.equal(screen.getByTestId("machine-connection-status").textContent, en["machine.detail.connected"]);
  assert.equal(rowText().includes("computer v1.0.47"), true);
  assert.ok(
    within(screen.getByTestId("computer-service-actions")).queryByText(en["machine.detail.upgradeV2.inProgress"]) === null,
    "the upgrade is over once the machine is online at the target",
  );
});

test("offline with no upgrade in flight still shows the offline card and label", () => {
  render();
  act(() => {
    useMachineStore.getState().applyMachineStatusEvent("computer-1", "offline", 2);
  });
  assert.ok(screen.getByTestId("computer-recovery-card"));
  assert.ok(screen.queryByTestId("computer-upgrade-reconnecting") === null);
  assert.equal(rowText().includes(en["machine.runLabel.computerOffline"]), true);
});

test("computerUpgradeInFlight: the accepted request holds until the server settles it, the target is online, or the deadline", () => {
  const accepted = { request: pending, acceptedAtMs: 1_000 };
  const offline = { status: "offline", computerVersion: null, upgradeRequest: null };
  assert.equal(computerUpgradeInFlight(offline, accepted, 2_000), pending, "a read without the pending row is not an outcome");
  assert.equal(computerUpgradeInFlight({ ...offline, status: "online", computerVersion: "1.0.45" }, accepted, 2_000), pending,
    "back online on the old version: still in flight (the server decides failure)");
  assert.equal(computerUpgradeInFlight({ ...offline, status: "online", computerVersion: "1.0.47" }, accepted, 2_000), null);
  assert.equal(computerUpgradeInFlight(offline, accepted, 1_000 + COMPUTER_UPGRADE_REQUEST_DEADLINE_MS), null);
  const settled = { ...pending, state: "failed" as const, reason: "download checksum mismatch", resolvedAt: "2026-10-12T02:44:00.000Z" };
  assert.equal(computerUpgradeInFlight({ ...offline, upgradeRequest: settled }, accepted, 2_000), null, "the server settled this request");
  const earlierAttempt = { ...settled, id: "request-0", requestedAt: "2026-10-12T02:00:00.000Z" };
  assert.equal(computerUpgradeInFlight({ ...offline, upgradeRequest: earlierAttempt }, accepted, 2_000), pending,
    "an earlier attempt's verdict says nothing about this one");
  assert.equal(computerUpgradeInFlight({ ...offline, upgradeRequest: pending }, null, 2_000), pending, "the server's pending row");
});
