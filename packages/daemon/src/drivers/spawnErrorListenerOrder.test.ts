import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeDriver } from "./claude";
import { ChildProcessRuntimeSession } from "./runtimeSession";
import type { SpawnContext } from "./types";

// Task #365. A child that fails to spawn (EACCES, ENOENT) reports it with an
// `error` queued on `process.nextTick`. RuntimeSession attaches its listener
// only after `await driver.spawn()` resumes, so whether that `error` has a
// listener depends on Node scheduling and on the caller's context, not on
// any one source shape. These tests pin the minimal counterexamples on the
// running Node and the real claude driver → RuntimeSession path. Attaching
// the error listener at creation time is a separate interface change.

test("task #365: node scheduling counterexamples — a spawn error can arrive before RuntimeSession listens", () => {
  const script = `
    const { spawn } = require("node:child_process");
    const C = "raft-task-365-command-that-does-not-exist";
    const shapes = {
      awaitThenSpawn: async () => { await Promise.resolve(); return spawn(C); },
      spawnInMacrotask: async () => spawn(C),
      spawnThenAwaitMicrotask: async () => { await Promise.resolve(); const p = spawn(C); await Promise.resolve(); return p; },
      spawnThenAwaitMacrotask: async () => { await Promise.resolve(); const p = spawn(C); await new Promise((r) => setImmediate(r)); return p; },
    };
    const name = process.argv[1];
    process.on("uncaughtException", (e) => { process.stdout.write("uncaught:" + e.code); process.exit(0); });
    setTimeout(async () => {
      const child = await shapes[name]();
      child.on("error", (e) => { process.stdout.write("caught:" + e.code); process.exit(0); });
    }, 0);
  `;
  const run = (shape: string) =>
    spawnSync(process.execPath, ["-e", script, shape], { encoding: "utf8" }).stdout;
  const on = `node ${process.version}`;
  assert.equal(run("awaitThenSpawn"), "caught:ENOENT", on);
  assert.equal(run("spawnThenAwaitMicrotask"), "caught:ENOENT", on);
  assert.equal(run("spawnInMacrotask"), "uncaught:ENOENT", on);
  assert.equal(run("spawnThenAwaitMacrotask"), "uncaught:ENOENT", on);
});

test.skipIf(process.platform === "win32")(
  "task #365: real claude driver → RuntimeSession surfaces a non-executable CLI as a spawn error, not an uncaught exception",
  async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-claude-eacces-"));
    try {
      // The incident: the auto-updater left the claude binary non-executable.
      const command = path.join(tmp, "claude");
      writeFileSync(command, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
      const ctx: SpawnContext = {
        agentId: "agent-1",
        launchId: "launch-1",
        config: {
          name: "hao",
          displayName: "Hao",
          description: "runtime tester",
          model: "sonnet",
          runtime: "claude",
          reasoningEffort: null,
          envVars: null,
          sessionId: null,
          serverUrl: "https://api.slock.ai",
          authToken: null,
          runtimeConfig: {
            version: 1,
            runtime: "claude",
            provider: { kind: "default" },
            model: { kind: "preset", id: "sonnet" },
            mode: { kind: "default" },
            command,
          },
        } as any,
        standingPrompt: "standing prompt",
        prompt: "hello",
        workingDirectory: tmp,
        slockHome: path.join(tmp, "home"),
        slockCliPath: "/fake/slock-cli.js",
        daemonApiKey: "daemon-key",
      };
      const session = new ChildProcessRuntimeSession(new ClaudeDriver(), ctx);
      const seen: string[] = [];
      const closed = new Promise<void>((resolve) => session.on("close", () => resolve()));
      session.on("error", (err) => {
        const errno = err as NodeJS.ErrnoException;
        seen.push(`error:${errno.code}:${errno.syscall}`);
      });
      session.on("exit", (info) => seen.push(`exit:${info.reason}`));

      const started = await session.start({ text: "hello" });
      assert.equal(started.ok, true);
      await closed;
      assert.deepEqual(seen, [`error:EACCES:spawn ${command}`, "exit:error"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },
);
