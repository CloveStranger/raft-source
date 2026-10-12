import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeDriver } from "./claude";
import type { SpawnContext } from "./types";

// task #365: `SpawnContext.assertLaunchCurrent` is called by the driver after
// its last await and right before the runtime exists, so a launch whose
// server connection changed during the driver's own preparation gets no
// process.

function claudeContext(tmp: string, command: string, assertLaunchCurrent: () => void): SpawnContext {
  return {
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
    assertLaunchCurrent,
  };
}

test.skipIf(process.platform === "win32")(
  "task #365: the real claude driver creates no child when the launch turns stale during its async preparation",
  async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "slock-launch-current-"));
    try {
      const marker = path.join(tmp, "ran");
      const command = path.join(tmp, "claude");
      // Read the prompt line the driver writes before exiting: a child that
      // exits first turns that write into an EPIPE on an unlistened stdin.
      writeFileSync(command, `#!/bin/sh\nread -r _prompt\ntouch ${JSON.stringify(marker)}\nexit 0\n`, { mode: 0o755 });
      let stale = false;
      const refused = new Error("launch claimed against an earlier connection");
      const ctx = claudeContext(tmp, command, () => { if (stale) throw refused; });

      // Positive control: while current, the same driver and command run.
      const control = await new ClaudeDriver().spawn(ctx);
      await new Promise<void>((resolve) => control.process.on("close", () => resolve()));
      assert.equal(existsSync(marker), true, "the command runs when the launch is current");
      rmSync(marker);

      // The connection changes after spawn() began, while it awaits its preparation.
      const pending = new ClaudeDriver().spawn(ctx);
      stale = true;
      await assert.rejects(pending, (err) => err === refused);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(existsSync(marker), false, "no child was created");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },
);

test("task #365: inventory — every runtime driver's spawn / native session start calls assertLaunchCurrent", () => {
  // An inventory of entries, not the guarantee: the dynamic tests above and in
  // core.test.ts check the behaviour. A new driver without the call fails here.
  const dir = new URL("./", import.meta.url);
  const childDrivers = ["antigravity.deprecated.ts", "claude.ts", "codex.ts", "copilot.ts", "cursor.ts", "gemini.ts", "grok.ts", "kimi.ts", "opencode.ts"];
  const nativeDrivers = ["kimi-sdk.ts", "pi.ts"];
  const withSpawn = readdirSync(dir).filter((name) =>
    name.endsWith(".ts") && !name.endsWith(".test.ts") && /\n  async spawn\(/.test(readFileSync(new URL(name, dir), "utf8")));
  assert.deepEqual(withSpawn.sort(), [...childDrivers, ...nativeDrivers].sort(), "driver list changed: classify the new driver");
  for (const name of childDrivers) {
    const text = readFileSync(new URL(name, dir), "utf8");
    const body = text.slice(text.indexOf("\n  async spawn("));
    const check = body.indexOf("ctx.assertLaunchCurrent?.()");
    const child = body.search(/\n\s+(?:const proc = |proc = )spawnRuntimeChild\(/);
    // task #366: the child is created through spawnRuntimeChild, which listens
    // for its error/exit/close and stdin errors before spawn() returns.
    assert.ok(child > 0, `${name}: the runtime child is created with spawnRuntimeChild`);
    assert.ok(check > 0 && child > check, `${name}: assertLaunchCurrent right before the child`);
    assert.doesNotMatch(body.slice(check, child), /\bawait\b/, `${name}: no await between the check and the child`);
  }
  // Native sessions: checked inside the factory, after its last await and
  // right before the SDK session is created or resumed (dynamic tests in
  // pi.test.ts / kimi-sdk.test.ts).
  const nativeBoundaries: Record<string, string[]> = {
    "pi.ts": ["createAgentSessionFromServices({"],
    "kimi-sdk.ts": ["harness.resumeSession(", "harness.createSession("],
  };
  for (const name of nativeDrivers) {
    const text = readFileSync(new URL(name, dir), "utf8");
    const check = text.search(/\n\s+ctx\.assertLaunchCurrent\?\.\(\)/);
    assert.ok(check > 0, `${name}: assertLaunchCurrent in the session factory`);
    // The first SDK create/resume call after the check (a fresh create after a
    // failed resume follows the resume itself).
    const first = Math.min(...nativeBoundaries[name]!.map((b) => text.indexOf(b, check)).filter((i) => i > check));
    assert.ok(Number.isFinite(first), `${name}: an SDK create/resume after the check`);
    const between = text.slice(check, first);
    const lastLine = between.lastIndexOf("\n");
    assert.doesNotMatch(between.slice(0, lastLine), /\bawait\b/, `${name}: no await between the check and the SDK session`);
  }
  // Waits hidden in the call chain, not visible as an `await` in the factory:
  // pi creates its session through withProcessEnvPatch, which waits for a
  // process-wide lock first, so the check must sit inside that callback
  // (dynamic: pi.test.ts "waits for the env-patch lock").
  const pi = readFileSync(new URL("pi.ts", dir), "utf8");
  const lockCallback = pi.indexOf("withProcessEnvPatch(sessionCreateEnvPatch, () => {");
  const piCheck = pi.indexOf("ctx.assertLaunchCurrent?.()", lockCallback);
  const piCreate = pi.indexOf("createAgentSessionFromServices({", lockCallback);
  assert.ok(lockCallback > 0 && piCheck > lockCallback && piCreate > piCheck, "pi.ts: the check runs inside the env-patch lock, right before the SDK session");
});
