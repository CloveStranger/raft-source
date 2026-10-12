import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import * as externalInstaller from "./externalInstaller";
import { readLastRemoteUpgradeReceipt } from "./externalInstaller";
import { runService } from "./service";
import { readSupervisorRecord, supervisorRecordPath, writeSupervisorRecord, type ExternalSupervisorRecord, type SystemctlRunner } from "./externalSupervisor";
import { ServiceClientError } from "./lib/types";

const RECORD: ExternalSupervisorRecord = { kind: "systemd", scope: "user", unit: "raft-computer.service", invocationId: "inv", pid: process.pid, recordedAt: "t" };

function systemctlAnswering(killMode: string): { runner: SystemctlRunner; calls: string[] } {
  const calls: string[] = [];
  const runner: SystemctlRunner = async (scope, args) => {
    calls.push(`${scope}:${args.join(" ")}`);
    if (args[0] === "show" && args[2] === "KillMode") return { code: 0, stdout: `${killMode}\n`, stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  return { runner, calls };
}

async function withServiceHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "raft-supervised-service-"));
  const oldRaft = process.env.RAFT_HOME;
  const oldSlock = process.env.SLOCK_HOME;
  const oldOptIn = process.env.RAFT_COMPUTER_EXTERNAL_SUPERVISOR;
  process.env.RAFT_HOME = home;
  process.env.SLOCK_HOME = home;
  delete process.env.RAFT_COMPUTER_EXTERNAL_SUPERVISOR;
  mkdirSync(join(home, "computer"), { recursive: true });
  writeFileSync(join(home, "computer", "channel"), "latest");
  try {
    return await fn(home);
  } finally {
    if (oldRaft === undefined) delete process.env.RAFT_HOME; else process.env.RAFT_HOME = oldRaft;
    if (oldSlock === undefined) delete process.env.SLOCK_HOME; else process.env.SLOCK_HOME = oldSlock;
    if (oldOptIn === undefined) delete process.env.RAFT_COMPUTER_EXTERNAL_SUPERVISOR; else process.env.RAFT_COMPUTER_EXTERNAL_SUPERVISOR = oldOptIn;
    rmSync(home, { recursive: true, force: true });
  }
}

const remote = (requestId: string, targetVersion?: string) =>
  ({ scope: "remote" as const, requestId, originServerId: "test-server", trigger: "web" as const, ...(targetVersion ? { targetVersion } : {}) });

test("task #917: under systemd with KillMode=control-group a remote upgrade is refused and settled as this request's failed receipt", async () => {
  await withServiceHome(async (home) => {
    const launch = vi.spyOn(externalInstaller, "launchInstallerDetached").mockResolvedValue(4321);
    const { runner, calls } = systemctlAnswering("control-group");
    try {
      let exercised = false;
      await runService({
        stopAfterMutationsReady: true,
        detectSystemdSupervisorFn: async () => RECORD,
        systemctl: runner,
        onMutationsReady: async (mutations) => {
          await assert.rejects(
            () => mutations.upgradeStart!(remote("req-1", "1.0.33")),
            (err: unknown) => err instanceof ServiceClientError && err.code === "UPGRADE_START_REJECTED" && /KillMode=process/.test(err.message),
          );
          exercised = true;
        },
      });
      assert.equal(exercised, true);
      assert.equal(launch.mock.calls.length, 0, "the installer is never launched behind a refusal");
      assert.deepEqual(calls, ["user:show -P KillMode raft-computer.service"]);
      assert.deepEqual(await readSupervisorRecord(home), RECORD, "the service records who supervises it");
      const receipt = await readLastRemoteUpgradeReceipt(home);
      assert.equal(receipt?.targetVersion, "1.0.33");
      assert.equal(receipt?.outcome, "failed");
      assert.match(receipt?.reason ?? "", /raft-computer\.service with KillMode=control-group/);
    } finally {
      launch.mockRestore();
    }
  });
});

test("task #917: under systemd with KillMode=process the upgrade proceeds through the installer as before", async () => {
  await withServiceHome(async () => {
    const launch = vi.spyOn(externalInstaller, "launchInstallerDetached").mockResolvedValue(4321);
    try {
      await runService({
        stopAfterMutationsReady: true,
        detectSystemdSupervisorFn: async () => RECORD,
        systemctl: systemctlAnswering("process").runner,
        onMutationsReady: async (mutations) => {
          assert.deepEqual(await mutations.upgradeStart!(remote("req-2", "1.0.34")), { status: "started", upgradeId: "req-2", targetVersion: "1.0.34" });
        },
      });
      assert.equal(launch.mock.calls.length, 1);
    } finally {
      launch.mockRestore();
    }
  });
});

test("task #917: a supervised restart exits for the supervisor instead of spawning a replacement", async () => {
  await withServiceHome(async () => {
    let signalled = 0;
    await runService({
      stopAfterMutationsReady: true,
      detectSystemdSupervisorFn: async () => RECORD,
      systemctl: systemctlAnswering("process").runner,
      signalSelfForRelaunch: () => { signalled += 1; },
      onMutationsReady: async (mutations) => {
        assert.deepEqual(await mutations.restartService(), { status: "accepted" });
        await new Promise((resolve) => setImmediate(resolve));
      },
    });
    assert.equal(signalled, 1, "the hand-off asks this process to shut down exactly once");
  });
});

test("task #917: the generic opt-in gets the exit hand-off for restart and a settled refusal for upgrade", async () => {
  await withServiceHome(async (home) => {
    process.env.RAFT_COMPUTER_EXTERNAL_SUPERVISOR = "1";
    const launch = vi.spyOn(externalInstaller, "launchInstallerDetached").mockResolvedValue(4321);
    let signalled = 0;
    try {
      await runService({
        stopAfterMutationsReady: true,
        detectSystemdSupervisorFn: async () => null,
        signalSelfForRelaunch: () => { signalled += 1; },
        onMutationsReady: async (mutations) => {
          await assert.rejects(
            () => mutations.upgradeStart!(remote("req-3", "1.0.35")),
            (err: unknown) => err instanceof ServiceClientError && err.code === "UPGRADE_START_REJECTED" && /RAFT_COMPUTER_EXTERNAL_SUPERVISOR/.test(err.message),
          );
          assert.deepEqual(await mutations.restartService(), { status: "accepted" });
          await new Promise((resolve) => setImmediate(resolve));
        },
      });
      assert.equal(launch.mock.calls.length, 0);
      assert.equal(signalled, 1);
      assert.equal(existsSync(supervisorRecordPath(home)), false, "no systemd record for a generic supervisor");
      assert.equal((await readLastRemoteUpgradeReceipt(home))?.outcome, "failed");
    } finally {
      launch.mockRestore();
    }
  });
});

test("task #917: an unsupervised service clears a stale supervisor record so a plain start is not captured by an old unit", async () => {
  await withServiceHome(async (home) => {
    await writeSupervisorRecord(home, RECORD);
    await runService({ stopAfterMutationsReady: true, detectSystemdSupervisorFn: async () => null, onMutationsReady: async () => undefined });
    assert.equal(await readSupervisorRecord(home), null);
  });
});
