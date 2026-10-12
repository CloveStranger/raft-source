import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describeRaftHomeConflict, findRaftHomeConflictFor, resolveRaftHome } from "./paths";

function withHomeDir(run: (homeDir: string) => void): void {
  const homeDir = mkdtempSync(path.join(tmpdir(), "raft-computer-home-"));
  try {
    run(homeDir);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
}

test("resolveRaftHome: a new machine defaults to ~/.raft", () => {
  withHomeDir((homeDir) => {
    assert.equal(resolveRaftHome({}, homeDir), path.resolve(homeDir, ".raft"));
  });
});

test("resolveRaftHome: keeps an existing ~/.slock with Computer state as the default home, even next to ~/.raft", () => {
  withHomeDir((homeDir) => {
    mkdirSync(path.join(homeDir, ".slock", "computer"), { recursive: true });
    mkdirSync(path.join(homeDir, ".raft", "computer"), { recursive: true });
    assert.equal(resolveRaftHome({}, homeDir), path.resolve(homeDir, ".slock"));
  });
});

test("resolveRaftHome: ignores empty SLOCK_HOME instead of treating it as the home", () => {
  withHomeDir((homeDir) => {
    mkdirSync(path.join(homeDir, ".slock", "computer"), { recursive: true });
    assert.equal(resolveRaftHome({ SLOCK_HOME: "" }, homeDir), path.resolve(homeDir, ".slock"));
    assert.equal(resolveRaftHome({ SLOCK_HOME: "   " }, homeDir), path.resolve(homeDir, ".slock"));
  });
});

test("resolveRaftHome: accepts RAFT_HOME as a Computer home alias", () => {
  assert.equal(resolveRaftHome({ RAFT_HOME: "~/raft-state" }, "/Users/alice"), path.resolve("/Users/alice/raft-state"));
});

test("resolveRaftHome: RAFT_HOME takes precedence over SLOCK_HOME", () => {
  assert.equal(
    resolveRaftHome({ SLOCK_HOME: "/tmp/slock-home", RAFT_HOME: "/tmp/raft-home" }, "/Users/alice"),
    path.resolve("/tmp/raft-home"),
  );
});

// task #915: a machine that ran from ~/.raft, where an older ~/.slock-only
// program later wrote state, would be moved to ~/.slock by the default rule
// and lose its agents' workspaces. The reverse order (an old ~/.slock machine
// that later got ~/.raft state) moves the other way under a ~/.raft-first rule.
// Neither order may be guessed: both homes holding state is a conflict.
test("findRaftHomeConflictFor: both default homes holding Raft state is a conflict, in either order", () => {
  withHomeDir((homeDir) => {
    mkdirSync(path.join(homeDir, ".raft", "agents", "a1"), { recursive: true });
    assert.equal(findRaftHomeConflictFor(path.join(homeDir, ".raft"), {}, homeDir), null);
    mkdirSync(path.join(homeDir, ".slock", "computer"), { recursive: true });
    const conflict = findRaftHomeConflictFor(resolveRaftHome({}, homeDir), {}, homeDir);
    assert.deepEqual(conflict?.homes, [
      { path: path.resolve(homeDir, ".slock"), agentCount: 0 },
      { path: path.resolve(homeDir, ".raft"), agentCount: 1 },
    ]);
  });
  withHomeDir((homeDir) => {
    mkdirSync(path.join(homeDir, ".slock", "agents", "a1"), { recursive: true });
    assert.equal(findRaftHomeConflictFor(path.join(homeDir, ".slock"), {}, homeDir), null);
    mkdirSync(path.join(homeDir, ".raft", "profiles"), { recursive: true });
    assert.notEqual(findRaftHomeConflictFor(path.join(homeDir, ".slock"), {}, homeDir), null);
  });
});

test("findRaftHomeConflictFor: an explicit RAFT_HOME / SLOCK_HOME, or a non-default home, is the owner's choice", () => {
  withHomeDir((homeDir) => {
    mkdirSync(path.join(homeDir, ".slock", "agents"), { recursive: true });
    mkdirSync(path.join(homeDir, ".raft", "agents"), { recursive: true });
    const raft = path.join(homeDir, ".raft");
    assert.equal(findRaftHomeConflictFor(raft, { RAFT_HOME: raft }, homeDir), null);
    assert.equal(findRaftHomeConflictFor(raft, { SLOCK_HOME: raft }, homeDir), null);
    assert.equal(findRaftHomeConflictFor(path.join(homeDir, "elsewhere"), {}, homeDir), null);
  });
});

test("findRaftHomeConflictFor: a ~/.slock holding only a notice file is not a conflict", () => {
  withHomeDir((homeDir) => {
    mkdirSync(path.join(homeDir, ".raft", "agents"), { recursive: true });
    mkdirSync(path.join(homeDir, ".slock"), { recursive: true });
    assert.equal(findRaftHomeConflictFor(path.join(homeDir, ".raft"), {}, homeDir), null);
  });
});

test("describeRaftHomeConflict names both homes, what they hold, and how to pick one", () => {
  const homeDir = "/Users/alice";
  const text = describeRaftHomeConflict({
    homes: [
      { path: "/Users/alice/.slock", agentCount: 1 },
      { path: "/Users/alice/.raft", agentCount: 3 },
    ],
  }, homeDir);
  assert.match(text, /~\/\.slock \(1 agent workspace\) and ~\/\.raft \(3 agent workspaces\)/);
  assert.match(text, /RAFT_HOME=~\/\.raft raft-computer start/);
});
