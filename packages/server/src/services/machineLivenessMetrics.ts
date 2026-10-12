import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { machines } from "../db/schema";
import { machineHeartbeatAgeSeconds } from "../metrics";

// Seconds since each machine of one configured server last heartbeated
// (daemons.last_heartbeat). The daily team-machine inspection reads it to list
// machines offline for more than a few hours: the Maria machine was offline
// 10-03..10-08 and nobody noticed (#proj-sre:6e643496, task #273).
//
// Scoped to one server on purpose: the server cannot tell team machines from
// users' laptops, and users' machines going offline is normal. The inspection
// filters to its own list. Off unless MACHINE_LIVENESS_METRICS_SERVER_ID is set.

export interface MachineHeartbeatRow {
  id: string;
  lastHeartbeat: Date | null;
}

export type MachineHeartbeatLoader = (serverId: string) => Promise<MachineHeartbeatRow[]>;

const REPORT_INTERVAL_MS = 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let timer: ReturnType<typeof setInterval> | null = null;

export async function loadMachineHeartbeats(serverId: string): Promise<MachineHeartbeatRow[]> {
  return getDb()
    .select({ id: machines.id, lastHeartbeat: machines.lastHeartbeat })
    .from(machines)
    .where(eq(machines.serverId, serverId));
}

export function machineLivenessServerId(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.MACHINE_LIVENESS_METRICS_SERVER_ID?.trim();
  return raw && UUID_PATTERN.test(raw) ? raw : null;
}

/**
 * One report: replaces the gauge with the current rows, so a deleted machine
 * drops out. A machine that never heartbeated is left out rather than given
 * an invented age. A failed read clears the gauge too: a frozen age would make
 * an offline machine look freshly heartbeated, so no data is safer than old data.
 */
export async function reportMachineHeartbeatAges(
  serverId: string,
  load: MachineHeartbeatLoader = loadMachineHeartbeats,
  now: () => number = Date.now,
): Promise<void> {
  let rows: MachineHeartbeatRow[];
  try {
    rows = await load(serverId);
  } finally {
    machineHeartbeatAgeSeconds.reset();
  }
  const nowMs = now();
  for (const row of rows) {
    if (!row.lastHeartbeat) continue;
    const ageSeconds = Math.max(0, (nowMs - row.lastHeartbeat.getTime()) / 1000);
    machineHeartbeatAgeSeconds.set({ machine_id: row.id }, Math.round(ageSeconds));
  }
}

export function startMachineLivenessMetrics(env: NodeJS.ProcessEnv = process.env): void {
  if (timer) return;
  const serverId = machineLivenessServerId(env);
  if (!serverId) return;
  const report = () => {
    reportMachineHeartbeatAges(serverId).catch((error: unknown) => {
      console.warn("[machine-liveness] heartbeat age report failed:", error instanceof Error ? error.name : "unknown");
    });
  };
  report();
  timer = setInterval(report, REPORT_INTERVAL_MS);
  timer.unref?.();
}

export function stopMachineLivenessMetrics(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
