import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listLegacyRaftStatePaths, resolveDefaultRaftHome, resolveRaftHome, resolveRaftHomePath } from "./raftHome";

function withTempHome(run: (home: string) => void): void {
  const home = path.join(os.tmpdir(), `raft-home-default-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
  try {
    run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("resolveRaftHome defaults to ~/.raft on a machine without ~/.slock", () => {
  withTempHome((home) => {
    assert.equal(resolveRaftHome({}, home), path.resolve(home, ".raft"));
  });
});

test("resolveRaftHome keeps an existing ~/.slock that holds Raft state, even when ~/.raft exists too", () => {
  withTempHome((home) => {
    mkdirSync(path.join(home, ".slock", "agents"), { recursive: true });
    assert.equal(resolveRaftHome({}, home), path.resolve(home, ".slock"));
    mkdirSync(path.join(home, ".raft", "agents"), { recursive: true });
    assert.equal(resolveRaftHome({}, home), path.resolve(home, ".slock"));
  });
});

test("resolveRaftHome is not pulled to a ~/.slock that only holds a notice file", () => {
  withTempHome((home) => {
    mkdirSync(path.join(home, ".raft", "agents"), { recursive: true });
    mkdirSync(path.join(home, ".slock"));
    writeFileSync(path.join(home, ".slock", ".cli-rename-notice"), "");
    assert.equal(resolveRaftHome({}, home), path.resolve(home, ".raft"));
  });
});

test("resolveDefaultRaftHome resolves the default root independently of SLOCK_HOME", () => {
  withTempHome((home) => {
    assert.equal(resolveDefaultRaftHome(home), path.resolve(home, ".raft"));
  });
});

test("resolveRaftHome normalizes SLOCK_HOME to an absolute path", () => {
  assert.equal(resolveRaftHome({ SLOCK_HOME: "relative-slock-root" }, "/Users/alice"), path.resolve("relative-slock-root"));
});

test("resolveRaftHome accepts RAFT_HOME as a fallback", () => {
  assert.equal(resolveRaftHome({ RAFT_HOME: "relative-raft-root" }, "/Users/alice"), path.resolve("relative-raft-root"));
});

test("resolveRaftHome prefers RAFT_HOME over SLOCK_HOME when both are set", () => {
  assert.equal(
    resolveRaftHome({ SLOCK_HOME: "/tmp/slock-loses", RAFT_HOME: "/tmp/raft-wins" }, "/Users/alice"),
    path.resolve("/tmp/raft-wins"),
  );
});

test("resolveRaftHomePath derives child paths from the resolved state root", () => {
  assert.equal(
    resolveRaftHomePath("agents", "/tmp/slock-a"),
    path.join("/tmp/slock-a", "agents"),
  );
});

test("listLegacyRaftStatePaths reports existing default-root state when SLOCK_HOME is custom", () => {
  const home = path.join(os.tmpdir(), `slock-home-test-${process.pid}-${Date.now()}`);
  const customRoot = path.join(home, "custom");
  try {
    mkdirSync(path.join(home, ".slock", "agents"), { recursive: true });
    mkdirSync(path.join(home, ".slock", "machines"), { recursive: true });

    const paths = listLegacyRaftStatePaths(customRoot, home);
    assert.deepEqual(paths.map((entry) => entry.path).sort(), [
      path.join(home, ".slock", "agents"),
      path.join(home, ".slock", "machines"),
    ].sort());
    assert.deepEqual(paths.map((entry) => entry.destination).sort(), [
      path.join(customRoot, "agents"),
      path.join(customRoot, "machines"),
    ].sort());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("listLegacyRaftStatePaths is empty for default SLOCK_HOME", () => {
  const home = path.join(os.tmpdir(), `slock-home-default-test-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(path.join(home, ".slock", "agents"), { recursive: true });
    assert.deepEqual(listLegacyRaftStatePaths(path.join(home, ".slock"), home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Every process must resolve the Raft home through the shared rule
// (@botiverse/raft-shared raftHome.ts), or a new machine ends up with state in
// both ~/.raft and ~/.slock. This catches a default home spelled out by hand:
// `.slock`/`.raft` joined straight onto the user's home directory. Directories
// named `.slock` INSIDE an agent workspace are a different thing and allowed.
test("no package hard-codes the default Raft home directory", () => {
  const packagesDir = path.resolve(new URL(".", import.meta.url).pathname, "..", "..");
  const roots = ["daemon/src", "computer/src", "cli/src", "raft-sdk/src"];
  const homeJoin = /(?:homedir\(\)|homeDir|\bhome\b|HOME)\s*(?:\?\?[^,]*)?,\s*["'`]\.(?:slock|raft)["'`/]/;
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (/\.(?:ts|mts|mjs)$/.test(entry.name) && !/\.test\.|testkit/.test(entry.name)) {
        readFileSync(full, "utf8").split("\n").forEach((line, index) => {
          if (homeJoin.test(line)) offenders.push(`${path.relative(packagesDir, full)}:${index + 1}: ${line.trim()}`);
        });
      }
    }
  };
  for (const root of roots) walk(path.join(packagesDir, root));
  assert.deepEqual(offenders, [], "resolve the Raft home through resolveRaftHome / defaultRaftHomeDirname instead");
});
