import { useEffect, useMemo, useState } from "react";
import { clearClockTimeout, currentTimeMs, setClockTimeout } from "@botiverse/raft-shared";
import { useMachineStore } from "../store/machineStore";
import type { Machine, MachineUpgradeRequest } from "../store/machineStore";
import { computerUpgradeInFlight } from "../utils/computerUpgradeInFlight";

/** How long an offline Computer with an upgrade in flight reads as "restarting
 *  for the upgrade". The installer downloads while the Computer is still
 *  online; the offline part is just stop → start, so a longer silence is not
 *  "still upgrading", and the server's own deadline (sized for slow downloads)
 *  is too long to keep saying so. */
export const UPGRADE_RECONNECT_GRACE_MS = 3 * 60 * 1000;

export interface ComputerUpgradeReconnect {
  /** The upgrade request in flight (server pending row, or the one this tab
   *  saw accepted); see computerUpgradeInFlight. */
  inFlight: MachineUpgradeRequest | null;
  /** Offline inside the grace: the upgrade's restart, not an outage. */
  reconnecting: boolean;
  /** Offline past the grace with the upgrade still in flight. */
  overdue: boolean;
}

/**
 * One answer to "is this Computer restarting for an upgrade" for every surface
 * that shows its connection (detail page, sidebar row), so they cannot
 * disagree.
 */
export function useComputerUpgradeReconnect(
  machine: Pick<Machine, "id" | "isComputer" | "status" | "computerVersion" | "upgradeRequest" | "lastHeartbeat">,
): ComputerUpgradeReconnect {
  // oxlint-disable-next-line react-doctor/no-event-handler -- per-machine hot-slice selector (docs/frontend/render-cost-contract.md).
  const accepted = useMachineStore((s) => s.computerUpgradeAccepted[machine.id] ?? null);
  // oxlint-disable-next-line react-doctor/no-event-handler -- per-machine hot-slice selector (docs/frontend/render-cost-contract.md).
  const offlineObservedAtMs = useMachineStore((s) => s.computerOfflineObservedAt[machine.id] ?? null);
  const inFlight = computerUpgradeInFlight(machine, accepted, currentTimeMs());
  const waitingOffline = machine.isComputer === true && machine.status !== "online" && inFlight !== null;
  const requestedAt = inFlight?.requestedAt ?? null;
  // Offline since: the row carries no disconnect time, so prefer the moment
  // this tab saw the live online→offline event; otherwise (loaded already
  // offline) the row's lastHeartbeat, the last pong before the disconnect.
  // Never earlier than the request itself.
  const offlineSinceMs = useMemo(() => {
    if (!waitingOffline || requestedAt === null) return null;
    const requestedMs = Date.parse(requestedAt);
    const heartbeatMs = machine.lastHeartbeat ? Date.parse(machine.lastHeartbeat) : Number.NaN;
    const anchorMs = offlineObservedAtMs ?? heartbeatMs;
    return Math.max(
      Number.isFinite(requestedMs) ? requestedMs : 0,
      Number.isFinite(anchorMs) ? anchorMs : 0,
    );
  }, [machine.lastHeartbeat, offlineObservedAtMs, requestedAt, waitingOffline]);
  // The anchor whose grace has run out; re-rendered by a timer, not by the
  // next socket event.
  const [graceElapsedFor, setGraceElapsedFor] = useState<number | null>(null);
  useEffect(() => {
    if (offlineSinceMs === null) return;
    const remainingMs = offlineSinceMs + UPGRADE_RECONNECT_GRACE_MS - currentTimeMs();
    const t = setClockTimeout(() => setGraceElapsedFor(offlineSinceMs), Math.max(0, remainingMs));
    return () => clearClockTimeout(t);
  }, [offlineSinceMs]);
  const graceElapsed = offlineSinceMs !== null && graceElapsedFor === offlineSinceMs;
  return {
    inFlight,
    reconnecting: waitingOffline && !graceElapsed,
    overdue: waitingOffline && graceElapsed,
  };
}
