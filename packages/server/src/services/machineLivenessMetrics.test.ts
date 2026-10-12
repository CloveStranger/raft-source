import assert from "node:assert/strict";
import { machineHeartbeatAgeSeconds } from "../metrics";
import {
  machineLivenessServerId,
  reportMachineHeartbeatAges,
  startMachineLivenessMetrics,
  stopMachineLivenessMetrics,
} from "./machineLivenessMetrics";

const SERVER_ID = "95f993fa-2a68-4797-b8ae-7beb7d984ada";

async function ages(): Promise<Record<string, number>> {
  const metric = await machineHeartbeatAgeSeconds.get();
  return Object.fromEntries(metric.values.map((value) => [String(value.labels.machine_id), value.value]));
}

afterEach(() => {
  stopMachineLivenessMetrics();
  machineHeartbeatAgeSeconds.reset();
});

test("reports seconds since each machine's last heartbeat for the configured server", async () => {
  const now = Date.parse("2026-10-08T08:00:00Z");
  let askedFor = "";
  await reportMachineHeartbeatAges(
    SERVER_ID,
    async (serverId) => {
      askedFor = serverId;
      return [
        { id: "maria", lastHeartbeat: new Date("2026-10-03T08:00:00Z") },
        { id: "koala-fife", lastHeartbeat: new Date("2026-10-08T07:59:30Z") },
      ];
    },
    () => now,
  );
  assert.equal(askedFor, SERVER_ID);
  assert.deepEqual(await ages(), { maria: 5 * 86_400, "koala-fife": 30 });
});

test("a machine that never heartbeated is left out, and a deleted machine drops out on the next report", async () => {
  const now = Date.parse("2026-10-08T08:00:00Z");
  await reportMachineHeartbeatAges(SERVER_ID, async () => [
    { id: "gone-later", lastHeartbeat: new Date("2026-10-08T07:00:00Z") },
    { id: "never", lastHeartbeat: null },
  ], () => now);
  assert.deepEqual(await ages(), { "gone-later": 3_600 });

  await reportMachineHeartbeatAges(SERVER_ID, async () => [], () => now);
  assert.deepEqual(await ages(), {});
});

test("only a valid server id enables the report", () => {
  assert.equal(machineLivenessServerId({ MACHINE_LIVENESS_METRICS_SERVER_ID: SERVER_ID }), SERVER_ID);
  assert.equal(machineLivenessServerId({ MACHINE_LIVENESS_METRICS_SERVER_ID: ` ${SERVER_ID} ` }), SERVER_ID);
  assert.equal(machineLivenessServerId({}), null);
  assert.equal(machineLivenessServerId({ MACHINE_LIVENESS_METRICS_SERVER_ID: "botiverse" }), null);
});

test("without a configured server the reporter does not start", async () => {
  startMachineLivenessMetrics({});
  assert.deepEqual(await ages(), {});
});

test("a failed read clears the gauge instead of freezing old ages", async () => {
  const now = Date.parse("2026-10-08T08:00:00Z");
  await reportMachineHeartbeatAges(SERVER_ID, async () => [
    { id: "maria", lastHeartbeat: new Date("2026-10-08T07:59:00Z") },
  ], () => now);
  assert.deepEqual(await ages(), { maria: 60 });

  await assert.rejects(reportMachineHeartbeatAges(SERVER_ID, async () => {
    throw new Error("connection terminated");
  }, () => now));
  assert.deepEqual(await ages(), {}, "a stale 60 s would hide a machine that went offline");
});
