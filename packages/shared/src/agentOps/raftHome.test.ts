import assert from "node:assert/strict";

import { defaultRaftHomeDirname, defaultRaftHomesConflict, isDefaultRaftHomeDirname } from "./raftHome";

const existing = (...paths: string[]) => (relativePath: string) => paths.includes(relativePath);

test("a machine whose ~/.slock holds Raft state keeps it; a new machine gets ~/.raft", () => {
  assert.equal(defaultRaftHomeDirname(existing()), ".raft");
  for (const entry of ["agents", "computer", "machines", "profiles", "agent-state"]) {
    assert.equal(defaultRaftHomeDirname(existing(".slock", `.slock/${entry}`)), ".slock", entry);
  }
  // Both in use: ~/.slock wins (agent workspaces and the server's stored
  // workspace paths are under it).
  assert.equal(defaultRaftHomeDirname(existing(".slock", ".slock/agents", ".raft", ".raft/agents")), ".slock");
});

test("a ~/.slock holding only a notice file does not pull a machine off ~/.raft", () => {
  // Old npm shims create ~/.slock just for `.cli-rename-notice`.
  assert.equal(defaultRaftHomeDirname(existing(".slock", ".slock/.cli-rename-notice", ".raft", ".raft/agents")), ".raft");
  assert.equal(defaultRaftHomeDirname(existing(".slock", ".slock/.cli-rename-notice")), ".raft");
});

test("both default directory names are recognised", () => {
  assert.equal(isDefaultRaftHomeDirname(".raft"), true);
  assert.equal(isDefaultRaftHomeDirname(".slock"), true);
  assert.equal(isDefaultRaftHomeDirname(".slock-runtime"), false);
});

test("both default homes holding Raft state is reported as a conflict; one home alone never is", () => {
  assert.equal(defaultRaftHomesConflict(existing(".slock", ".slock/agents", ".raft", ".raft/computer")), true);
  assert.equal(defaultRaftHomesConflict(existing(".slock", ".slock/agents")), false);
  assert.equal(defaultRaftHomesConflict(existing(".raft", ".raft/agents")), false);
  assert.equal(defaultRaftHomesConflict(existing(".slock", ".slock/.cli-rename-notice", ".raft", ".raft/agents")), false);
  assert.equal(defaultRaftHomesConflict(existing()), false);
});
