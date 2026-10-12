import assert from "node:assert/strict";

import { buildRunnerChildEnv, PARENT_LOCK_HELD_ENV_VAR } from "./runnerChildEnv";

// task #915: a service running from ~/.raft while ~/.slock also holds state
// must hand its own home to the daemon (and through it to agents and tools
// such as Stamp/Hands that read only SLOCK_HOME); re-running the default rule
// below the service would land on ~/.slock.
test("buildRunnerChildEnv pins the service's home as both RAFT_HOME and SLOCK_HOME", () => {
  const env = buildRunnerChildEnv(
    { PATH: "/usr/bin", SLOCK_HOME: "/Users/alice/.slock", [PARENT_LOCK_HELD_ENV_VAR]: "1" },
    "/Users/alice/.raft",
  );
  assert.equal(env.RAFT_HOME, "/Users/alice/.raft");
  assert.equal(env.SLOCK_HOME, "/Users/alice/.raft");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env[PARENT_LOCK_HELD_ENV_VAR], undefined);
});

test("buildRunnerChildEnv without a home leaves the inherited home untouched", () => {
  const env = buildRunnerChildEnv({ SLOCK_HOME: "/x" });
  assert.equal(env.SLOCK_HOME, "/x");
  assert.equal(env.RAFT_HOME, undefined);
});
