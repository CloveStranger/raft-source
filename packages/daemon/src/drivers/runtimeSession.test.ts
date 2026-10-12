import { asAxSurfaceText, type AxSurfaceText } from "@botiverse/raft-shared";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { guardRuntimeChild, spawnRuntimeChild } from "./runtimeChild";
import { logger } from "../logger";
import { ChildProcessRuntimeSession } from "./runtimeSession";
import type { ParsedEvent, RuntimeDriver, SpawnContext, SpawnResult } from "./types";

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: (_chunk: string) => true };
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid = 1234;

  kill(signal?: NodeJS.Signals) {
    this.signalCode = signal ?? "SIGTERM";
    this.emit("exit", null, this.signalCode);
    this.emit("close", null, this.signalCode);
    return true;
  }
}

class Utf8Driver implements RuntimeDriver {
  readonly id = "utf8-test";
  readonly lifecycle = { kind: "persistent", stdin: "direct", inFlightWake: "steer" } as const;
  readonly communication = { chat: "slock_cli", runtimeControl: "none" } as const;
  readonly session = { recovery: "fresh" } as const;
  readonly model = { detectedModelsVerifiedAs: "launchable" } as const;
  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "direct" as const;
  readonly spawned = new FakeChildProcess();

  spawn(_ctx: SpawnContext): SpawnResult | Promise<SpawnResult> {
    return { process: this.spawned as unknown as ChildProcess };
  }

  parseLine(line: string): ParsedEvent[] {
    const parsed = JSON.parse(line) as { text: string };
    return [{ kind: "text", text: parsed.text }];
  }

  encodeStdinMessage(text: string): string {
    return JSON.stringify({ text });
  }

  buildSystemPrompt(): AxSurfaceText {
    return asAxSurfaceText("");
  }
}

const spawnContext: SpawnContext = {
  agentId: "agent-1",
  config: {
    name: "agent",
    displayName: "Agent",
    description: "test",
    model: "model",
    runtime: "utf8-test",
    reasoningEffort: null,
    envVars: null,
    sessionId: null,
    serverUrl: "https://api.slock.ai",
    authToken: "sk_machine_test",
  } as any,
  standingPrompt: "",
  prompt: "",
  workingDirectory: "/tmp/agent",
  slockCliPath: "/tmp/slock",
  daemonApiKey: "token",
};

test("child-process runtime session decodes split UTF-8 stdout before line parsing", async () => {
  const driver = new Utf8Driver();
  const session = new ChildProcessRuntimeSession(driver, spawnContext);
  const events: ParsedEvent[] = [];
  session.on("runtime_event", (event) => events.push(event));
  await session.start({ text: "start" });

  const line = `${JSON.stringify({ text: "hello 你好" })}\n`;
  const bytes = Buffer.from(line, "utf8");
  const splitAt = bytes.indexOf(Buffer.from("你", "utf8")[0]) + 1;
  driver.spawned.stdout.emit("data", bytes.subarray(0, splitAt));
  driver.spawned.stdout.emit("data", bytes.subarray(splitAt));

  assert.deepEqual(events, [{ kind: "text", text: "hello 你好" }]);
});

test("child-process runtime session emits exit exactly once, including for a failed spawn that gets error and close but no exit", async () => {
  const exitsFor = async (drive: (child: FakeChildProcess) => void) => {
    const driver = new Utf8Driver();
    const session = new ChildProcessRuntimeSession(driver, spawnContext);
    const exits: Array<{ code: number | null; reason?: string }> = [];
    session.on("exit", (info) => exits.push({ code: info.code, reason: info.reason }));
    session.on("error", () => {});
    await session.start({ text: "start" });
    drive(driver.spawned);
    return exits;
  };
  // What Node does on EACCES / ENOENT.
  assert.deepEqual(await exitsFor((child) => {
    child.emit("error", Object.assign(new Error("spawn claude EACCES"), { code: "EACCES" }));
    child.emit("close", -13, null);
  }), [{ code: -13, reason: "error" }]);
  // A process that ran: exit then close.
  assert.deepEqual(await exitsFor((child) => {
    child.emit("exit", 1, null);
    child.emit("close", 1, null);
  }), [{ code: 1, reason: "runtime_exit" }]);
  // An error from a process that ran (its exit follows as usual).
  assert.deepEqual(await exitsFor((child) => {
    child.emit("error", new Error("kill EPERM"));
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  }), [{ code: 0, reason: "runtime_exit" }]);
});

// Task #366: real children, worst-case timing. The driver hands the child over
// only after it has already ended, so every event RuntimeSession must see
// happened before it listened.
class LateHandoverDriver extends Utf8Driver {
  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly afterSpawn: (child: ChildProcess) => Promise<void>,
  ) {
    super();
  }

  override async spawn(_ctx: SpawnContext): Promise<SpawnResult> {
    const child = spawnRuntimeChild(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
    await this.afterSpawn(child);
    return { process: child };
  }
}

const settleTicks = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

test.skipIf(process.platform === "win32")(
  "task #366: a spawn error raised before the session listens is replayed, not thrown",
  async () => {
    // spawnInMacrotask from spawnErrorListenerOrder.test.ts: the driver waits a
    // macrotask after creating the child, so the ENOENT fires with nobody else
    // listening.
    const driver = new LateHandoverDriver("raft-task-366-command-that-does-not-exist", [], settleTicks);
    const session = new ChildProcessRuntimeSession(driver, spawnContext);
    const seen: string[] = [];
    const closed = new Promise<void>((resolve) => session.on("close", () => resolve()));
    session.on("error", (err) => seen.push(`error:${(err as NodeJS.ErrnoException).code}`));
    session.on("exit", (info) => seen.push(`exit:${info.reason}`));

    const started = await session.start({ text: "hello" });
    assert.equal(started.ok, true);
    await closed;
    assert.deepEqual(seen, ["error:ENOENT", "exit:error"]);
  },
);

test.skipIf(process.platform === "win32")(
  "task #366: a child that stops reading stdin turns the prompt write into a handled EPIPE, and its exit still reaches the session",
  async () => {
    // The child closes its stdin and then exits, like a runtime that dies
    // before reading its prompt. The driver's prompt write lands on a closed
    // pipe: a real EPIPE on stdin, raised while nobody but the guard listens.
    const driver = new LateHandoverDriver("sh", ["-c", "exec 0<&-; sleep 0.2; exit 3"], async (child) => {
      await settleTicks();
      child.stdin?.write("x".repeat(1 << 20));
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    });
    const session = new ChildProcessRuntimeSession(driver, spawnContext);
    const seen: string[] = [];
    session.on("error", (err) => seen.push(`error:${(err as NodeJS.ErrnoException).code}`));
    session.on("exit", (info) => seen.push(`exit:${info.code}:${info.reason}`));
    session.on("close", (info) => seen.push(`close:${info.code}`));

    const closed = new Promise<void>((resolve) => session.on("close", () => resolve()));
    const started = await session.start({ text: "hello" });
    assert.equal(started.ok, true);
    await closed;
    // exit (and usually close) happened before start() returned; replayed in order.
    assert.deepEqual(seen, ["exit:3:runtime_exit", "close:3"]);

    // A later stdin write to the dead child is handled the same way.
    assert.equal(session.send({ mode: "idle", text: "later" }).ok, false, "a closed session refuses sends");
  },
);

test.skipIf(process.platform === "win32")(
  "task #366: a stdin write to a live child that stopped reading is handled by the session, and the exit still ends it",
  async () => {
    const driver = new LateHandoverDriver("sh", ["-c", "exec 0<&-; sleep 0.4; exit 4"], async () => {});
    const session = new ChildProcessRuntimeSession(driver, spawnContext);
    const seen: string[] = [];
    session.on("error", (err) => seen.push(`error:${(err as NodeJS.ErrnoException).code}`));
    session.on("exit", (info) => seen.push(`exit:${info.code}:${info.reason}`));
    const closed = new Promise<void>((resolve) => session.on("close", () => resolve()));

    assert.equal((await session.start({ text: "hello" })).ok, true);
    await settleTicks();
    // The child is alive but its stdin is closed: the session's own stdin
    // listener takes this EPIPE.
    assert.equal(session.send({ mode: "idle", text: "x".repeat(1 << 20) }).ok, true);
    await closed;
    assert.deepEqual(seen, ["exit:4:runtime_exit"]);
  },
);

test.skipIf(process.platform === "win32")(
  "task #366: final output written before the child ended reaches the session before exit and close",
  async () => {
    // Huaihuai's counterexample: the child prints its last line and exits, and
    // the driver hands it over only after close.
    // stdout, then stderr (the pause makes their arrival order deterministic
    // across the two pipes), then exit.
    const driver = new LateHandoverDriver("sh", ["-c", "printf '{\"text\":\"final\"}\\n'; sleep 0.05; printf 'last words\\n' >&2; exit 0"], async (child) => {
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    });
    const session = new ChildProcessRuntimeSession(driver, spawnContext);
    const seen: string[] = [];
    session.on("runtime_event", (event) => seen.push(`event:${event.kind === "text" ? event.text : event.kind}`));
    session.on("stderr", (text) => seen.push(`stderr:${text}`));
    session.on("exit", (info) => seen.push(`exit:${info.code}`));
    const closed = new Promise<void>((resolve) => session.on("close", (info) => {
      seen.push(`close:${info.code}`);
      resolve();
    }));

    assert.equal((await session.start({ text: "hello" })).ok, true);
    await closed;
    assert.deepEqual(seen, ["event:final", "stderr:last words", "exit:0", "close:0"]);
  },
);

test("task #366: a session given an abandoned child fails it instead of replaying a partial run", async () => {
  vi.useFakeTimers();
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const child = new FakeChildProcess();
    guardRuntimeChild(child as unknown as ChildProcess);
    child.stdout.emit("data", Buffer.from(`${JSON.stringify({ text: "partial" })}\n`));
    // Abandoned: nobody took it over. The fake's kill() emits exit and close.
    vi.advanceTimersByTime(10_000);

    const driver = new Utf8Driver();
    (driver as unknown as { spawned: FakeChildProcess }).spawned = child;
    const session = new ChildProcessRuntimeSession(driver, spawnContext);
    const seen: string[] = [];
    session.on("runtime_event", (event) => seen.push(`event:${event.kind === "text" ? event.text : event.kind}`));
    session.on("error", (err) => seen.push(`error:${/abandoned/.test(err.message) ? "abandoned" : err.message}`));
    session.on("exit", (info) => seen.push(`exit:${info.signal}`));
    session.on("close", (info) => seen.push(`close:${info.signal}`));
    const started = await session.start({ text: "hello" });
    assert.equal(started.ok, false, "the start itself reports the failure");
    assert.match(started.ok ? "" : started.error ?? "", /abandoned/);
    assert.deepEqual(seen, ["error:abandoned", "exit:SIGTERM", "close:SIGTERM"], "no partial output, an explicit failure, then the end");
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});
