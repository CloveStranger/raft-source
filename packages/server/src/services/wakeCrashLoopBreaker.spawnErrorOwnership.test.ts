import assert from "node:assert/strict";
import {
  applyWakeCrashLoopExit,
  applyWakeCrashLoopManualStop,
  applyWakeCrashLoopStart,
  applyWakeCrashLoopStartFailure,
  applyWakeCrashLoopStartFailureOwned,
  freshWakeCrashLoopEpisode,
  type WakeCrashLoopEpisodeState,
} from "./wakeCrashLoopBreaker";

// task #365: a start whose `not_spawned: spawn_error` the RFC 071 breaker
// counts is owned by it; the #9150 start-failure streak neither counts it
// again nor keeps a block only that start caused.

const T0 = 1_700_000_000_000;

function streakOf(failures: number): WakeCrashLoopEpisodeState {
  let state = freshWakeCrashLoopEpisode(1);
  for (let i = 1; i <= failures; i += 1) {
    state = applyWakeCrashLoopStart(state, { launchId: `F${i}`, nowMs: T0 + i, human: false });
    state = applyWakeCrashLoopStartFailure(state, { launchId: `F${i}`, reason: "runtime_spawn_failed", nowMs: T0 + i }).state;
  }
  return state;
}

function startL(state: WakeCrashLoopEpisodeState, launchId = "L"): WakeCrashLoopEpisodeState {
  return applyWakeCrashLoopStart(state, { launchId, nowMs: T0 + 100, human: false });
}

test("task #365 example 1: the activity counted L as the 5th failure and blocked; L's ownership withdraws exactly that and lifts the block", () => {
  const counted = applyWakeCrashLoopStartFailure(startL(streakOf(4)), { launchId: "L", reason: "runtime_spawn_failed", nowMs: T0 + 101 });
  assert.equal(counted.outcome, "blocked");
  assert.equal(counted.state.blockedByLaunchId, "L");
  const owned = applyWakeCrashLoopStartFailureOwned(counted.state, "L");
  assert.deepEqual([owned.withdrawn, owned.unblocked], [true, true]);
  assert.equal(owned.state.startFailureCount, 4);
  assert.equal(owned.state.blocked, false);
  assert.equal(owned.state.needsActionReason, null);
  assert.equal(owned.state.startFailureOwnedLaunchId, "L");
  // A late duplicate activity for L is not counted again.
  assert.equal(applyWakeCrashLoopStartFailure(owned.state, { launchId: "L", reason: "runtime_spawn_failed", nowMs: T0 + 102 }).outcome, "owned_by_terminal_breaker");
});

test("task #365 example 2: ownership first; the later activity for L is not counted", () => {
  const owned = applyWakeCrashLoopStartFailureOwned(startL(streakOf(4)), "L");
  assert.deepEqual([owned.withdrawn, owned.unblocked], [false, false]);
  const activity = applyWakeCrashLoopStartFailure(owned.state, { launchId: "L", reason: "runtime_spawn_failed", nowMs: T0 + 101 });
  assert.equal(activity.outcome, "owned_by_terminal_breaker");
  assert.equal(activity.state.startFailureCount, 4);
  assert.equal(activity.state.blocked, false);
});

test("task #365 example 3: a manual stop after L blocked is kept; L's later ownership changes nothing", () => {
  const counted = applyWakeCrashLoopStartFailure(startL(streakOf(4)), { launchId: "L", reason: "runtime_spawn_failed", nowMs: T0 + 101 }).state;
  const stopped = applyWakeCrashLoopManualStop(counted);
  const owned = applyWakeCrashLoopStartFailureOwned(stopped, "L");
  assert.equal(owned.changed, false);
  assert.deepEqual(owned.state, stopped);
});

test("task #365 example 4: an early-exit (crash) block is never lifted by a start's ownership", () => {
  let state = freshWakeCrashLoopEpisode(1);
  for (let i = 1; i <= 3; i += 1) {
    state = applyWakeCrashLoopStart(state, { launchId: `C${i}`, nowMs: T0 + i * 10, human: false });
    state = applyWakeCrashLoopExit(state, { kind: "agent_process_exited", launchId: `C${i}`, evidence: true } as never, T0 + i * 10 + 1).state;
  }
  assert.equal(state.blocked, true, "crash-loop blocked");
  assert.equal(state.blockedByLaunchId ?? null, null);
  // L is the last start (e.g. a start whose activity arrived while blocked: not counted).
  state = { ...state, lastStartLaunchId: "L" };
  const owned = applyWakeCrashLoopStartFailureOwned(state, "L");
  assert.equal(owned.unblocked, false);
  assert.equal(owned.state.blocked, true);
});

test("task #365: only L's own contribution is withdrawn: another start's failure, a stale launch, or a record from an older replica keep theirs", () => {
  // L is not the current start (a human start moved on): nothing changes.
  const moved = applyWakeCrashLoopStart(startL(streakOf(2)), { launchId: "H", nowMs: T0 + 200, human: true });
  assert.equal(applyWakeCrashLoopStartFailureOwned(moved, "L").changed, false);
  // L counted, but the record lost `blockedByLaunchId` (an older replica rewrote it): count withdrawn, block kept.
  const blocked = applyWakeCrashLoopStartFailure(startL(streakOf(4)), { launchId: "L", reason: "runtime_spawn_failed", nowMs: T0 + 101 }).state;
  const { blockedByLaunchId: _dropped, ...olderWriter } = blocked;
  const owned = applyWakeCrashLoopStartFailureOwned(olderWriter, "L");
  assert.equal(owned.withdrawn, true);
  assert.equal(owned.state.startFailureCount, 4);
  assert.equal(owned.state.blocked, true, "kept: only a person lifts it then");
  // A retry-once L scheduled is cleared with its contribution.
  const retry = applyWakeCrashLoopStartFailure(startL(streakOf(0)), { launchId: "L", reason: "model_not_found", nowMs: T0 + 101 }).state;
  assert.notEqual(retry.retryAfterMs ?? null, null);
  assert.equal(applyWakeCrashLoopStartFailureOwned(retry, "L").state.retryAfterMs, null);
});
