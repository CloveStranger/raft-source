import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import {
  INTENTIONAL_STOP_EXIT_CODES,
  RELAUNCH_EXIT_CODES,
  SUPERVISED_RELAUNCH_EXIT_CODE,
  UPGRADE_SAFE_KILL_MODES,
  clearSupervisorRecord,
  describeKillModeRequirement,
  detectSystemdSupervisor,
  externalSupervisorOptIn,
  inspectSupervisor,
  parseSystemdUnitFromCgroup,
  readSupervisorRecord,
  writeSupervisorRecord,
  type SystemctlRunner,
} from "./externalSupervisor";

const V2_USER = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/raft-computer.service\n";
const V2_SYSTEM = "0::/system.slice/raft-computer-ci.service\n";
const V1 = [
  "12:pids:/user.slice/user-1000.slice/session-3.scope",
  "1:name=systemd:/user.slice/user-1000.slice/user@1000.service/raft-computer.service",
  "0::/user.slice/user-1000.slice/user@1000.service/raft-computer.service",
].join("\n");

test("task #917: the owning unit and scope are read from the cgroup, v2 and v1", () => {
  assert.deepEqual(parseSystemdUnitFromCgroup(V2_USER), { unit: "raft-computer.service", scope: "user" });
  assert.deepEqual(parseSystemdUnitFromCgroup(V2_SYSTEM), { unit: "raft-computer-ci.service", scope: "system" });
  assert.deepEqual(parseSystemdUnitFromCgroup(V1), { unit: "raft-computer.service", scope: "user" });
  // A login session scope, a bare slice, or the per-user manager itself is not a service unit of ours.
  assert.equal(parseSystemdUnitFromCgroup("0::/user.slice/user-1000.slice/session-3.scope\n"), null);
  assert.equal(parseSystemdUnitFromCgroup("0::/user.slice/user-1000.slice/user@1000.service\n"), null);
  assert.equal(parseSystemdUnitFromCgroup("0::/\n"), null);
  assert.equal(parseSystemdUnitFromCgroup(""), null);
});

function fakeSystemctl(answers: Record<string, string | { code: number; stdout?: string } | null>): { runner: SystemctlRunner; calls: string[] } {
  const calls: string[] = [];
  const runner: SystemctlRunner = async (scope, args) => {
    const key = `${scope}:${args.join(" ")}`;
    calls.push(key);
    const answer = answers[key];
    if (answer === undefined) return { code: 1, stdout: "", stderr: `unexpected ${key}` };
    if (answer === null) return { code: null, stdout: "", stderr: "Failed to connect to bus" };
    if (typeof answer === "string") return { code: 0, stdout: `${answer}\n`, stderr: "" };
    return { code: answer.code, stdout: `${answer.stdout ?? ""}\n`, stderr: "" };
  };
  return { runner, calls };
}

test("task #917: detection needs Linux, INVOCATION_ID, a service cgroup and MainPID == us", async () => {
  const base = {
    platform: "linux" as const,
    env: { INVOCATION_ID: "abc" },
    pid: 4242,
    readCgroup: async () => V2_USER,
    now: () => new Date("2026-10-12T06:40:00Z"),
  };
  const match = fakeSystemctl({ "user:show -P MainPID raft-computer.service": "4242" });
  assert.deepEqual(await detectSystemdSupervisor({ ...base, systemctl: match.runner }), {
    kind: "systemd", scope: "user", unit: "raft-computer.service", invocationId: "abc", pid: 4242, recordedAt: "2026-10-12T06:40:00.000Z",
  });
  // Not us as the main process (a helper or a terminal under the unit).
  const other = fakeSystemctl({ "user:show -P MainPID raft-computer.service": "99" });
  assert.equal(await detectSystemdSupervisor({ ...base, systemctl: other.runner }), null);
  // No INVOCATION_ID: a terminal `start --foreground` keeps today's behaviour, and systemctl is never consulted.
  const untouched = fakeSystemctl({});
  assert.equal(await detectSystemdSupervisor({ ...base, env: {}, systemctl: untouched.runner }), null);
  assert.deepEqual(untouched.calls, []);
  assert.equal(await detectSystemdSupervisor({ ...base, platform: "darwin", systemctl: match.runner }), null);
  assert.equal(await detectSystemdSupervisor({ ...base, readCgroup: async () => { throw new Error("no procfs"); }, systemctl: match.runner }), null);
});

test("task #917: the generic opt-in is explicit", () => {
  assert.equal(externalSupervisorOptIn({}), false);
  assert.equal(externalSupervisorOptIn({ RAFT_COMPUTER_EXTERNAL_SUPERVISOR: "1" }), true);
  assert.equal(externalSupervisorOptIn({ RAFT_COMPUTER_EXTERNAL_SUPERVISOR: "true" }), true);
  assert.equal(externalSupervisorOptIn({ RAFT_COMPUTER_EXTERNAL_SUPERVISOR: "0" }), false);
});

test("task #917: the record round-trips and malformed records read as absent", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "raft-supervisor-record-"));
  try {
    assert.equal(await readSupervisorRecord(home), null);
    const record = { kind: "systemd" as const, scope: "system" as const, unit: "raft-computer-ci.service", invocationId: "x", pid: 7, recordedAt: "t" };
    await writeSupervisorRecord(home, record);
    assert.deepEqual(await readSupervisorRecord(home), record);
    const file = path.join(home, "computer", "run", "supervisor.json");
    assert.equal(JSON.parse(await readFile(file, "utf8")).unit, "raft-computer-ci.service");
    await clearSupervisorRecord(home);
    assert.equal(await readSupervisorRecord(home), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("task #917: inspection reports loaded/enabled/active/MainPID/KillMode, a missing unit, and an unreachable manager", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "raft-supervisor-inspect-"));
  try {
    assert.equal(await inspectSupervisor(home, { systemctl: fakeSystemctl({}).runner }), null, "no record ⇒ nothing to inspect");
    await writeSupervisorRecord(home, { kind: "systemd", scope: "user", unit: "raft-computer.service", invocationId: "x", pid: 7, recordedAt: "t" });
    const live = fakeSystemctl({
      "user:show -P LoadState raft-computer.service": "loaded",
      "user:is-enabled raft-computer.service": "enabled",
      "user:show -P ActiveState raft-computer.service": "active",
      "user:show -P MainPID raft-computer.service": "7",
      "user:show -P KillMode raft-computer.service": "process",
    });
    assert.deepEqual(await inspectSupervisor(home, { systemctl: live.runner }), {
      record: { kind: "systemd", scope: "user", unit: "raft-computer.service", invocationId: "x", pid: 7, recordedAt: "t" },
      unitLoaded: true, enabledState: "enabled", activeState: "active", mainPid: 7, killMode: "process", reachable: true,
    });
    // Unit file removed: the record is stale and nothing else is asked.
    const gone = fakeSystemctl({ "user:show -P LoadState raft-computer.service": "not-found" });
    const stale = await inspectSupervisor(home, { systemctl: gone.runner });
    assert.equal(stale?.unitLoaded, false);
    assert.equal(stale?.reachable, true);
    assert.equal(gone.calls.length, 1);
    // No session bus (ssh without a login session): reachable=false, never a guess.
    const bus = fakeSystemctl({ "user:show -P LoadState raft-computer.service": null });
    const unreachable = await inspectSupervisor(home, { systemctl: bus.runner });
    assert.equal(unreachable?.reachable, false);
    assert.equal(unreachable?.unitLoaded, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("task #917: the KillMode requirement names the unit and the exact line to change", () => {
  assert.deepEqual([...UPGRADE_SAFE_KILL_MODES], ["process", "mixed"]);
  const text = describeKillModeRequirement("raft-computer.service", "control-group");
  assert.match(text, /raft-computer\.service with KillMode=control-group/);
  assert.match(text, /KillMode=process/);
  assert.match(text, /daemon-reload/);
});

test("task #917: exit codes form two closed classes and the relaunch code is not a stop code", () => {
  assert.deepEqual([...INTENTIONAL_STOP_EXIT_CODES], [77, 78]);
  assert.deepEqual([...RELAUNCH_EXIT_CODES], [SUPERVISED_RELAUNCH_EXIT_CODE, 1]);
  assert.equal(SUPERVISED_RELAUNCH_EXIT_CODE, 75);
  for (const code of INTENTIONAL_STOP_EXIT_CODES) assert.ok(!RELAUNCH_EXIT_CODES.includes(code));
});

// --- Contract: every non-zero exit in the service belongs to exactly one class ---
//
// The unit template writes `RestartPreventExitStatus=` from INTENTIONAL_STOP_EXIT_CODES
// and relies on `Restart=always` for everything else. A new terminal path that
// is in neither list would either loop forever (a stop that is restarted) or
// never come back (a crash listed as intentional). The test reads the service
// sources, resolves the named constants, and refuses an unclassified code.
test("task #917: every non-zero service exit code is classified as stop or relaunch", async () => {
  const files = ["./service.ts", "./lib/serviceShutdown.ts", "./serviceControl.ts", "./externalSupervisor.ts"];
  const named: Record<string, number> = {
    EX_CONFIG_EXIT_CODE: 78,
    COMPUTER_MACHINE_UNLINKED_EXIT_CODE: 77,
    SUPERVISED_RELAUNCH_EXIT_CODE,
  };
  const seen = new Map<string, string[]>();
  for (const file of files) {
    const src = await readFile(fileURLToPath(new URL(file, import.meta.url)), "utf8");
    // `process.exit(X)` and the shutdown seam's `exit(X)`; the `exitCode = 0`
    // default and `exit(exitCode)` are covered by the supervised path below.
    for (const match of src.matchAll(/(?:process\.)?exit\(\s*([A-Za-z_][A-Za-z0-9_]*|\d+)\s*\)/gu)) {
      const token = match[1]!;
      if (token === "exitCode" || token === "code") continue; // variable: classified where it is assigned
      const value = /^\d+$/u.test(token) ? Number(token) : named[token];
      assert.ok(value !== undefined, `${file}: exit(${token}) uses an unknown constant; add it to the named map and to a class`);
      if (value === 0) continue;
      const stop = INTENTIONAL_STOP_EXIT_CODES.includes(value);
      const relaunch = RELAUNCH_EXIT_CODES.includes(value);
      assert.ok(stop !== relaunch, `${file}: exit code ${value} (${token}) must be in exactly one of INTENTIONAL_STOP_EXIT_CODES / RELAUNCH_EXIT_CODES`);
      seen.set(`${file}:${token}`, [stop ? "stop" : "relaunch"]);
    }
  }
  // The two known intentional stops and the supervised hand-off are present and classified.
  assert.deepEqual(seen.get("./service.ts:EX_CONFIG_EXIT_CODE"), ["stop"]);
  assert.deepEqual(seen.get("./service.ts:COMPUTER_MACHINE_UNLINKED_EXIT_CODE"), ["stop"]);
  // The relaunch code is assigned into `supervisedExitCode` and flows through
  // shutdownService's `exitCode`; pin that it is the relaunch class.
  assert.ok(RELAUNCH_EXIT_CODES.includes(SUPERVISED_RELAUNCH_EXIT_CODE));
  const serviceSrc = await readFile(fileURLToPath(new URL("./service.ts", import.meta.url)), "utf8");
  assert.match(serviceSrc, /supervisedExitCode = SUPERVISED_RELAUNCH_EXIT_CODE/);
});
