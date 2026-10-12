// Rollback contract of `performServiceSelfRestart` (task #912).
//
// `spawnDetachedService` registers the replacement pid in `run/service.pid`
// as soon as it spawns the candidate. When the takeover fails (the candidate
// never proves exclusive IPC ownership — the Windows field case was a
// named-pipe bind failure), the incumbent kills the candidate and tries to
// re-own the endpoint. That restoration can itself fail (EADDRINUSE). The
// incumbent is still the live service either way, so the pidfile must name
// it again before `SELF_RELAUNCH_UNAVAILABLE` surfaces — otherwise
// `raft-computer stop` reads a dead pid, reports stale_pidfile_cleared, and
// leaves the service and its runners running.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writePidfileAt } from "./internal/process-primitives";
import { ServiceClientError } from "./lib/types";
import { servicePidPath } from "./paths";
import { performServiceSelfRestart } from "./serviceControl";

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "raft-service-control-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const REPLACEMENT_PID = 777_777;

function failingTakeoverDeps(home: string, restoreOwnership: () => Promise<void>) {
  let clock = 0;
  const killed: Array<[number, NodeJS.Signals]> = [];
  return {
    killed,
    deps: {
      // Mirrors the real spawner: the candidate pid lands in the pidfile.
      spawnDetachedServiceFn: async () => {
        await writePidfileAt(servicePidPath(home), REPLACEMENT_PID);
        return REPLACEMENT_PID;
      },
      // The candidate never attests (bind failure): no takeover proof.
      readReplacementAttestationFn: async () => null,
      listManagedServerIdsFn: async () => ["server-a"],
      readManagedMachineIdentitiesFn: async () => ({ "server-a": "machine-a" }),
      isProcessAliveFn: () => false,
      killProcess: (pid: number, signal: NodeJS.Signals) => {
        killed.push([pid, signal]);
      },
      releaseServiceOwnership: async () => {},
      restoreServiceOwnership: restoreOwnership,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += Math.max(1, ms);
      },
      takeoverTimeoutMs: 5,
      candidateShutdownTimeoutMs: 1,
      restoreOwnershipTimeoutMs: 5,
    },
  };
}

test("self-restart rollback: incumbent pid is restored even when ownership restoration fails", async () => {
  await withHome(async (home) => {
    const { deps, killed } = failingTakeoverDeps(home, async () => {
      throw new Error("listen EADDRINUSE: named pipe is busy");
    });
    await assert.rejects(
      () => performServiceSelfRestart(home, deps),
      (err: unknown) =>
        err instanceof ServiceClientError &&
        err.code === "SELF_RELAUNCH_UNAVAILABLE" &&
        err.message.includes("incumbent ownership restore failed: listen EADDRINUSE"),
    );
    // The candidate was told to go away…
    assert.deepEqual(killed[0], [REPLACEMENT_PID, "SIGTERM"]);
    // …and the pidfile names the live incumbent again, not the dead candidate.
    assert.equal((await readFile(servicePidPath(home), "utf8")).trim(), String(process.pid));
  });
});

test("self-restart rollback: incumbent pid is restored before ownership restoration runs", async () => {
  await withHome(async (home) => {
    let pidfileAtRestore: string | null = null;
    const { deps } = failingTakeoverDeps(home, async () => {
      pidfileAtRestore = (await readFile(servicePidPath(home), "utf8")).trim();
    });
    await assert.rejects(
      () => performServiceSelfRestart(home, deps),
      (err: unknown) => err instanceof ServiceClientError && err.code === "SELF_RELAUNCH_UNAVAILABLE",
    );
    assert.equal(pidfileAtRestore, String(process.pid));
    assert.equal((await readFile(servicePidPath(home), "utf8")).trim(), String(process.pid));
  });
});

test("self-restart rollback: a pidfile write failure is reported, not swallowed", async () => {
  await withHome(async (home) => {
    const { deps } = failingTakeoverDeps(home, async () => {});
    await assert.rejects(
      () => performServiceSelfRestart(home, { ...deps, writeIncumbentPidfile: async () => { throw new Error("EACCES: run/"); } }),
      (err: unknown) =>
        err instanceof ServiceClientError &&
        err.code === "SELF_RELAUNCH_UNAVAILABLE" &&
        err.message.includes("incumbent pidfile restore failed: EACCES: run/"),
    );
  });
});
