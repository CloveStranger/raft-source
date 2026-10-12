import assert from "node:assert/strict";
import type { AgentStartNotSpawnedReason } from "@botiverse/raft-shared";
import {
  TERMINAL_FAILURE_BACKOFF_MS,
  TERMINAL_FAILURE_PROBE_LEASE_MS,
  TERMINAL_SPAWN_ERROR_RETRY_JITTER_MAX_MS,
  applyTerminalFailureFrame,
  applyTerminalManualStop,
  applyTerminalOutboxFrame,
  applyTerminalProcessSpawned,
  applyTerminalStartRejectedBeforeSpawn,
  applyTurnCompletedFrame,
  claimTerminalStart,
  evaluateTerminalWakeGate,
  freshTerminalFailureBreakerState,
  isSpawnErrorRetryDue,
  rollbackTerminalClaim,
  spawnErrorBackoffMs,
  spawnErrorRetryJitterMs,
  terminalBlockView,
  terminalBreakerTtlSeconds,
  type TerminalClaimInput,
  type TerminalFailureBreakerState,
} from "./terminalFailureBreaker";

// task #365: a start the daemon proved never created a process
// (`not_spawned: spawn_error`) counts in its own bounded backoff inside the
// RFC 071 record, and a wake refused meanwhile is kept as demand for the
// retry sweep. Pure transitions only; wiring lives in the orchestrator tests.

const MIN = 60_000;
const H = 60 * MIN;
const D1 = "daemon-1";
let clientSeq = 0;
const nextSeq = () => (clientSeq += 1);

function claimInput(launchId: string, nowMs: number, extra: Partial<TerminalClaimInput> = {}): TerminalClaimInput {
  return { launchId, nowMs, resumedSessionId: "S", daemonInstanceId: D1, capability: true, control: "automatic", ...extra };
}

function claim(state: TerminalFailureBreakerState, launchId: string, nowMs: number, extra: Partial<TerminalClaimInput> = {}) {
  const result = claimTerminalStart(state, claimInput(launchId, nowMs, extra));
  if (!result.ok) throw new Error(`claim ${launchId} refused: ${result.reason}`);
  return result;
}

function notSpawned(state: TerminalFailureBreakerState, launchId: string, nowMs: number, reason: AgentStartNotSpawnedReason | null = "spawn_error") {
  return applyTerminalStartRejectedBeforeSpawn(state, { launchId, daemonInstanceId: D1, reason, nowMs, unreadCeilings: {} });
}

const gate = (state: TerminalFailureBreakerState, nowMs: number, wakeDemand = false) =>
  evaluateTerminalWakeGate(state, { nowMs, capability: true, wakeMessage: null, wakeDemand });

const e2 = (launchId: string) => ({ launchId, sessionId: "S", daemonInstanceId: D1, clientSeq: nextSeq(), catchupBatchId: null });

test("task #365: spawn_error backoff is 5 min × 2^(n-1) capped at 6 h, with no cap on attempts", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 20, 1_000].map(spawnErrorBackoffMs), [
    5 * MIN, 10 * MIN, 20 * MIN, 40 * MIN, 80 * MIN, 160 * MIN, 320 * MIN, 6 * H, 6 * H, 6 * H, 6 * H,
  ]);

  let state = claim(freshTerminalFailureBreakerState(), "L1", 0).state;
  let now = 0;
  for (let n = 1; n <= 12; n += 1) {
    const launchId = `L${n}`;
    const applied = notSpawned(state, launchId, now);
    assert.equal(applied.spawnErrorCounted, true, `attempt ${n} counts`);
    state = applied.state;
    assert.equal(state.state, "open");
    assert.equal(state.spawnError?.count, n);
    assert.equal(state.blockedUntilMs, now + spawnErrorBackoffMs(n));
    assert.equal(state.lastFailure?.kind, "spawn_error");
    assert.equal(state.currentLaunch?.terminal, "e1", "terminal, in a value an older replica can read");
    assert.deepEqual(state.unexited, [], "the pending entry left: no process exists");
    // RFC 071's own evidence is untouched.
    assert.equal(state.totalCount, 0);
    assert.equal(state.backoffStep, 0);
    assert.equal(state.sameFingerprint, null);
    assert.equal(state.needsManual, null);

    assert.equal(gate(state, state.blockedUntilMs! - 1).decision, "terminal_failure_paused");
    now = state.blockedUntilMs!;
    const probe = claim(state, `L${n + 1}`, now);
    assert.equal(probe.token.isProbe, true, "after the backoff exactly one probe");
    state = probe.state;
    assert.equal(state.state, "half_open");
  }
});

test("task #365: only spawn_error for the live current launch counts; every other reason just removes the pending entry", () => {
  const claimed = claim(freshTerminalFailureBreakerState(), "L1", 0).state;
  for (const reason of [
    "admission_full",
    "terminal_failure_outcome_storage_blocked",
    "terminal_failure_needs_manual",
    "stale_dispatch",
    "spawn_failed",
    "start_rejected",
    "cancelled",
    "deferred",
    null,
  ] as const) {
    const applied = notSpawned(claimed, "L1", 1_000, reason);
    assert.equal(applied.spawnErrorCounted, false, String(reason));
    assert.equal(applied.state.state, "closed", String(reason));
    assert.equal(applied.state.spawnError, null, String(reason));
    assert.equal(applied.state.currentLaunch?.terminal, null, String(reason));
    assert.deepEqual(applied.state.unexited, [], String(reason));
  }
  // Another launch's spawn_error (not current) counts nothing.
  const other = notSpawned(claimed, "L-old", 1_000);
  assert.equal(other.spawnErrorCounted, false);
  assert.equal(other.write, false);
  // A second report for the same launch counts once.
  const once = notSpawned(claimed, "L1", 1_000).state;
  const twice = notSpawned(once, "L1", 2_000);
  assert.equal(twice.spawnErrorCounted, false);
  assert.equal(twice.state.spawnError?.count, 1);
});

test("task #365: spawn_error never shortens a later block; a terminal-failure open stays as it was", () => {
  // Synthetic: open with a 24 h block while the current launch is still live.
  const live = claim(freshTerminalFailureBreakerState(), "L1", 0).state;
  const held: TerminalFailureBreakerState = { ...live, state: "open", blockedUntilMs: 24 * H, openedAtMs: 0, totalCount: 2, backoffStep: 2 };
  const applied = notSpawned(held, "L1", 1_000).state;
  assert.equal(applied.blockedUntilMs, 24 * H);
  assert.equal(applied.totalCount, 2);
  assert.equal(applied.backoffStep, 2);

  // Real: E1 threshold opens for 1 h; a late spawn_error of an older launch counts nothing.
  // (No pending entries: these claims record no daemon instance.)
  let state = claim(freshTerminalFailureBreakerState(), "A", 0, { daemonInstanceId: null }).state;
  for (const [launchId, fp] of [["A", "f"], ["B", "f"]] as const) {
    if (launchId === "B") state = claim(state, "B", 10, { daemonInstanceId: null }).state;
    state = applyTerminalFailureFrame(state, { launchId, sessionId: "S", daemonInstanceId: D1, clientSeq: nextSeq(), failureKind: "x", fingerprint: fp }, { nowMs: 20, unreadCeilings: {} }).state;
  }
  assert.equal(state.state, "open");
  assert.equal(state.blockedUntilMs, 20 + TERMINAL_FAILURE_BACKOFF_MS[0]!);
  const late = notSpawned(state, "A", 30);
  assert.equal(late.spawnErrorCounted, false);
  assert.equal(late.state.blockedUntilMs, 20 + TERMINAL_FAILURE_BACKOFF_MS[0]!);
  assert.equal(late.state.lastFailure?.kind, "x");
});

test("task #365: a process for the current launch resets the count; a process for another launch does not", () => {
  let state = claim(freshTerminalFailureBreakerState(), "L1", 0).state;
  state = notSpawned(state, "L1", 0).state;
  state = claim(state, "L2", 5 * MIN).state;
  state = notSpawned(state, "L2", 5 * MIN).state;
  assert.equal(state.spawnError?.count, 2);
  state = claim(state, "L3", 15 * MIN).state;

  const other = applyTerminalProcessSpawned(state, { launchId: "L-other", daemonInstanceId: D1, processInstanceId: "pi-other" }).state;
  assert.equal(other.spawnError?.count, 2);

  state = applyTerminalProcessSpawned(state, { launchId: "L3", daemonInstanceId: D1, processInstanceId: "pi-L3" }).state;
  assert.equal(state.spawnError, null);
  assert.equal(state.state, "half_open", "liveness is not recovery: the probe still needs its clean turn");
  // The next run starts over at 5 min.
  state = applyTurnCompletedFrame(state, e2("L3"), { nowMs: 16 * MIN, persistedSessionId: "S" }).state;
  assert.equal(state.state, "closed");
  state = claim(state, "L4", 20 * MIN).state;
  state = notSpawned(state, "L4", 20 * MIN).state;
  assert.equal(state.blockedUntilMs, 25 * MIN);
});

test("task #365: a human start bypasses the backoff but keeps the evidence; an E2 clears it", () => {
  let state = claim(freshTerminalFailureBreakerState(), "L1", 0).state;
  state = notSpawned(state, "L1", 0).state;
  state = claim(state, "L2", 5 * MIN).state;
  state = notSpawned(state, "L2", 5 * MIN).state;
  assert.equal(gate(state, 6 * MIN).decision, "terminal_failure_paused");

  const human = claim(state, "H1", 6 * MIN, { control: "human_start" });
  assert.equal(human.state.state, "closed");
  assert.equal(human.state.spawnError?.count, 2, "the start proceeds; the evidence stays");
  assert.equal(human.state.lastFailure?.kind, "spawn_error");
  const again = notSpawned(human.state, "H1", 7 * MIN).state;
  assert.equal(again.spawnError?.count, 3);
  assert.equal(again.blockedUntilMs, 7 * MIN + 20 * MIN);

  const human2 = claim(again, "H2", 8 * MIN, { control: "human_start" }).state;
  const ran = applyTurnCompletedFrame(human2, e2("H2"), { nowMs: 9 * MIN, persistedSessionId: "S" }).state;
  assert.equal(ran.spawnError, null);
});

test("task #365: lease expiry never bypasses an unknown or still-running probe (no second start)", () => {
  let state = claim(freshTerminalFailureBreakerState(), "L1", 0).state;
  state = notSpawned(state, "L1", 0).state;
  // The probe's outcome never arrives (the daemon's 5 s wait timed out: unknown).
  state = claim(state, "P1", 5 * MIN).state;
  const afterLease = 5 * MIN + TERMINAL_FAILURE_PROBE_LEASE_MS + 30 * H;
  assert.equal(gate(state, afterLease).decision, "terminal_failure_needs_manual");
  assert.equal(claimTerminalStart(state, claimInput("P2", afterLease)).ok, false);
  assert.equal(isSpawnErrorRetryDue(state, { nowMs: afterLease, jitterMs: 0 }), false);
  // The late spawn_error settles the unknown attempt; then the next probe may go.
  const settled = notSpawned(state, "P1", afterLease).state;
  assert.deepEqual(settled.unexited, []);
  assert.equal(claimTerminalStart(settled, claimInput("P2", afterLease + 7 * H)).ok, true);

  // Same, but the probe's process exists and is still alive when the lease expires.
  let alive = claim(freshTerminalFailureBreakerState(), "L1", 0).state;
  alive = notSpawned(alive, "L1", 0).state;
  alive = claim(alive, "P1", 5 * MIN).state;
  alive = applyTerminalProcessSpawned(alive, { launchId: "P1", daemonInstanceId: D1, processInstanceId: "pi-P1" }).state;
  assert.equal(claimTerminalStart(alive, claimInput("P2", afterLease)).ok, false, "the old process may still run: no second start");
  assert.equal(gate(alive, afterLease).decision, "terminal_failure_needs_manual");
});

test("task #365: wake demand counts refusals; only an E2 of the claiming launch settles it, up to the seq it claimed", () => {
  let state = claim(freshTerminalFailureBreakerState(), "L1", 0).state;
  state = notSpawned(state, "L1", 0).state;
  state = gate(state, 1 * MIN, true).state;
  state = gate(state, 2 * MIN, true).state;
  assert.equal(gate(state, 2 * MIN).state.wakeDemand?.seq, 2, "a refusal without demand records none");
  assert.deepEqual(state.wakeDemand, { seq: 2, sinceMs: 1 * MIN, claimedSeq: null, claimedLaunchId: null });

  state = claim(state, "P1", 5 * MIN).state;
  assert.deepEqual(state.wakeDemand, { seq: 2, sinceMs: 1 * MIN, claimedSeq: 2, claimedLaunchId: "P1" });
  // A wake refused while the probe runs is newer demand.
  state = gate(state, 6 * MIN, true).state;
  assert.equal(state.wakeDemand?.seq, 3);
  // Liveness does not settle demand.
  state = applyTerminalProcessSpawned(state, { launchId: "P1", daemonInstanceId: D1, processInstanceId: "pi-P1" }).state;
  assert.equal(state.wakeDemand?.seq, 3);
  // An E2 of another launch does not settle it.
  assert.equal(applyTurnCompletedFrame(state, e2("X"), { nowMs: 7 * MIN, persistedSessionId: "S" }).state.wakeDemand?.seq, 3);
  // The claiming launch's E2 settles up to 2; seq 3 survives, unclaimed.
  state = applyTurnCompletedFrame(state, e2("P1"), { nowMs: 7 * MIN, persistedSessionId: "S" }).state;
  assert.deepEqual(state.wakeDemand, { seq: 3, sinceMs: 1 * MIN, claimedSeq: null, claimedLaunchId: null });
  state = claim(state, "L2", 8 * MIN).state;
  state = applyTurnCompletedFrame(state, e2("L2"), { nowMs: 9 * MIN, persistedSessionId: "S" }).state;
  assert.equal(state.wakeDemand, null);
});

test("task #365: a manual stop cancels demand; a rolled-back claim leaves it unserved", () => {
  let state = claim(freshTerminalFailureBreakerState(), "L1", 0).state;
  state = notSpawned(state, "L1", 0).state;
  state = gate(state, 1 * MIN, true).state;
  const stoppedOpen = applyTerminalManualStop(state, { nowMs: 2 * MIN });
  assert.equal(stoppedOpen.write, true);
  assert.equal(stoppedOpen.state.wakeDemand, null);

  const probe = claim(state, "P1", 5 * MIN);
  const stoppedProbe = applyTerminalManualStop(probe.state, { nowMs: 6 * MIN }).state;
  assert.equal(stoppedProbe.wakeDemand, null);
  assert.equal(stoppedProbe.state, "open");

  const rolledBack = rollbackTerminalClaim(probe.state, probe.token, { nowMs: 6 * MIN, dispatchLeftReplica: false }).state;
  assert.deepEqual(rolledBack.wakeDemand, { seq: 1, sinceMs: 1 * MIN, claimedSeq: null, claimedLaunchId: null });
});

test("task #365: the retry sweep is due only for a spawn-error open with demand, after backoff plus the agent's fixed jitter", () => {
  let state = claim(freshTerminalFailureBreakerState(), "L1", 0).state;
  state = notSpawned(state, "L1", 0).state;
  const until = state.blockedUntilMs!;
  assert.equal(isSpawnErrorRetryDue(state, { nowMs: until + 10 * MIN, jitterMs: 0 }), false, "no demand: the next wake retries");
  state = gate(state, 1 * MIN, true).state;
  assert.equal(isSpawnErrorRetryDue(state, { nowMs: until - 1, jitterMs: 0 }), false);
  assert.equal(isSpawnErrorRetryDue(state, { nowMs: until + 999, jitterMs: 1_000 }), false, "jitter only adds delay");
  assert.equal(isSpawnErrorRetryDue(state, { nowMs: until + 1_000, jitterMs: 1_000 }), true);
  // Once a probe is claimed the record is half_open: not due again (one start).
  assert.equal(isSpawnErrorRetryDue(claim(state, "P1", until).state, { nowMs: until + 2 * H, jitterMs: 0 }), false);
  // A terminal-failure open is not this sweep's: it waits for the next wake, as RFC 071 says.
  const crash: TerminalFailureBreakerState = { ...state, lastFailure: { ...state.lastFailure!, kind: "compaction_failed" } };
  assert.equal(isSpawnErrorRetryDue(crash, { nowMs: until + 2 * H, jitterMs: 0 }), false);
  // A needs-manual block is never retried automatically.
  const manual: TerminalFailureBreakerState = { ...state, needsManual: { reason: "outcome_evidence_lost", sinceMs: 0, causeEntries: [] } };
  assert.equal(isSpawnErrorRetryDue(manual, { nowMs: until + 2 * H, jitterMs: 0 }), false);
  // A wake demand keeps the closed record from expiring.
  assert.equal(terminalBreakerTtlSeconds({ ...freshTerminalFailureBreakerState(), wakeDemand: state.wakeDemand }), 0);
});

test("task #365: retry jitter is a fixed per-agent value in [0, max): same on every replica and restart", () => {
  const ids = Array.from({ length: 200 }, (_, i) => `agent-${i}`);
  const values = ids.map(spawnErrorRetryJitterMs);
  assert.deepEqual(ids.map(spawnErrorRetryJitterMs), values);
  for (const value of values) assert.ok(value >= 0 && value < TERMINAL_SPAWN_ERROR_RETRY_JITTER_MAX_MS);
  assert.ok(new Set(values).size > 150, "spread across agents");
});

test("task #365: the pause view says spawn_error and when the next attempt is allowed", () => {
  let state = claim(freshTerminalFailureBreakerState(), "L1", 0).state;
  state = notSpawned(state, "L1", 1_000).state;
  assert.deepEqual(terminalBlockView(state, 2_000), { kind: "paused", blockedUntilMs: 1_000 + 5 * MIN, failureKind: "spawn_error" });
});

test("task #365: the outbox frame carries the reason; a replay is not counted twice", () => {
  const claimed = claim(freshTerminalFailureBreakerState(), "L1", 0).state;
  const frame = { kind: "start_not_spawned" as const, daemonInstanceId: D1, clientSeq: 7, launchId: "L1", reason: "spawn_error" as const };
  const input = { nowMs: 1_000, unreadCeilings: {}, persistedSessionId: null };
  const first = applyTerminalOutboxFrame(claimed, frame, input);
  assert.equal(first.outcome, "spawn_error_counted");
  assert.equal(first.state.spawnError?.count, 1);
  const replay = applyTerminalOutboxFrame(first.state, frame, { ...input, nowMs: 2_000 });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.state.spawnError?.count, 1);
  // A frame without a reason (an older daemon) only removes the pending entry.
  const old = applyTerminalOutboxFrame(claimed, { ...frame, reason: undefined }, input);
  assert.equal(old.outcome, "pending_removed");
  assert.equal(old.state.spawnError, null);
});

test("task #365: an admitted wake is demand too: a single reminder whose start never spawns is re-served after the backoff", () => {
  // One reminder, the gate passes, the claim records the wake as demand it serves.
  const fresh = freshTerminalFailureBreakerState();
  assert.equal(gate(fresh, 0, true).decision, "pass");
  let state = claim(fresh, "L1", 0, { wakeDemand: true }).state;
  assert.deepEqual(state.wakeDemand, { seq: 1, sinceMs: 0, claimedSeq: 1, claimedLaunchId: "L1" });
  // The CLI is not executable. No further message arrives.
  state = notSpawned(state, "L1", 0).state;
  assert.equal(state.wakeDemand?.seq, 1, "the never-run launch did not serve it");
  assert.equal(isSpawnErrorRetryDue(state, { nowMs: 5 * MIN - 1, jitterMs: 0 }), false);
  assert.equal(isSpawnErrorRetryDue(state, { nowMs: 5 * MIN, jitterMs: 0 }), true);
  // The sweep's start (no new demand) claims it; only that launch's E2 settles it.
  state = claim(state, "P1", 5 * MIN).state;
  assert.deepEqual(state.wakeDemand, { seq: 1, sinceMs: 0, claimedSeq: 1, claimedLaunchId: "P1" });
  state = applyTerminalProcessSpawned(state, { launchId: "P1", daemonInstanceId: D1, processInstanceId: "pi-P1" }).state;
  assert.equal(state.wakeDemand?.seq, 1);
  state = applyTurnCompletedFrame(state, e2("P1"), { nowMs: 6 * MIN, persistedSessionId: "S" }).state;
  assert.equal(state.wakeDemand, null);
});

test("task #365: no demand is invented: a human start, a start without a wake, or any not_spawned alone records none", () => {
  const fresh = freshTerminalFailureBreakerState();
  assert.equal(claim(fresh, "H1", 0, { control: "human_start", wakeDemand: true }).state.wakeDemand, null);
  const plain = claim(fresh, "L1", 0).state;
  assert.equal(plain.wakeDemand, null);
  const failed = notSpawned(plain, "L1", 0).state;
  assert.equal(failed.wakeDemand, null);
  assert.equal(isSpawnErrorRetryDue(failed, { nowMs: 7 * H, jitterMs: 0 }), false, "nothing to re-serve: the next wake retries");
});

test("task #365: a probe of a breaker RFC 071 failures opened takes the RFC 071 next step on spawn_error, never less", () => {
  // Two same-fingerprint E1s open at step 0 (1 h); the probe after it never spawns.
  let state = claim(freshTerminalFailureBreakerState(), "A", 0, { daemonInstanceId: null }).state;
  state = applyTerminalFailureFrame(state, { launchId: "A", sessionId: "S", daemonInstanceId: D1, clientSeq: nextSeq(), failureKind: "x", fingerprint: "f" }, { nowMs: 0, unreadCeilings: {} }).state;
  state = claim(state, "B", 1, { daemonInstanceId: null }).state;
  state = applyTerminalFailureFrame(state, { launchId: "B", sessionId: "S", daemonInstanceId: D1, clientSeq: nextSeq(), failureKind: "x", fingerprint: "f" }, { nowMs: 1, unreadCeilings: {} }).state;
  assert.equal(state.state, "open");
  const probeAt = state.blockedUntilMs!;
  state = claim(state, "P", probeAt).state;
  assert.equal(state.state, "half_open");
  const failed = notSpawned(state, "P", probeAt + 1_000).state;
  assert.equal(failed.state, "open");
  assert.equal(failed.backoffStep, 1, "steps up like any failed probe");
  assert.equal(failed.blockedUntilMs, probeAt + 1_000 + TERMINAL_FAILURE_BACKOFF_MS[1]!);
  assert.equal(failed.totalCount, 2, "RFC 071 counts untouched");
  // Not this sweep's to retry: RFC 071 retries on the next wake.
  const withDemand = gate(failed, probeAt + 2_000, true).state;
  assert.equal(isSpawnErrorRetryDue(withDemand, { nowMs: probeAt + 48 * H, jitterMs: 0 }), false);
});

test("task #365: a probe the daemon never started (stale_dispatch, admission_full, ...) ends without a step and without waiting for its lease", () => {
  let state = claim(freshTerminalFailureBreakerState(), "L1", 0, { wakeDemand: true }).state;
  state = notSpawned(state, "L1", 0).state;
  const until = state.blockedUntilMs!;
  for (const reason of ["stale_dispatch", "admission_full", "terminal_failure_outcome_storage_blocked"] as const) {
    const probe = claim(state, "P1", until).state;
    const released = notSpawned(probe, "P1", until + 1_000, reason).state;
    assert.equal(released.state, "open", reason);
    assert.equal(released.backoffStep, 0, reason);
    assert.equal(released.blockedUntilMs, until, `${reason}: the backoff already passed; nothing longer`);
    assert.equal(released.currentLaunch, null, reason);
    assert.deepEqual(released.unexited, [], reason);
    assert.equal(released.spawnError?.count, 1, `${reason}: not counted`);
    // Only stale_dispatch leaves the demand unserved for a re-serve; other reasons wait for the next wake.
    assert.equal(released.wakeDemand?.claimedLaunchId, reason === "stale_dispatch" ? null : "P1", reason);
  }
});

test("task #365: no demand is recorded where the machine cannot report outcomes (nothing could ever settle it)", () => {
  const claimed = claim(freshTerminalFailureBreakerState(), "L1", 0, { wakeDemand: true, capability: false });
  assert.equal(claimed.state.wakeDemand, null);
});

test("task #365: a refused wake records no demand where the machine cannot report outcomes", () => {
  // A protected record on a machine without outcome reporting refuses (needs manual).
  const protectedState = notSpawned(claim(freshTerminalFailureBreakerState(), "L1", 0).state, "L1", 0).state;
  const refused = evaluateTerminalWakeGate(protectedState, { nowMs: 1_000, capability: false, wakeMessage: null, wakeDemand: true });
  assert.equal(refused.decision, "terminal_failure_needs_manual");
  assert.equal(refused.state.wakeDemand, null);
});
