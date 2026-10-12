// Sender descriptions are shown once per model context (passive resource
// "sender", policy "once"; PR #7583 rfcs/072-progressive-ax.md).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, test } from "vitest";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import type { CliIo } from "../../core/io";
import { claimObservation, releaseObservation } from "../../state/agentLedger";
import { messageReadCommand } from "./read";
import { elideSeenSenders } from "./_senderElision";

const AGENT = "agent-sender-once";
const ENV_KEYS = ["SLOCK_CLI_STATE_DIR", "SLOCK_CLI_CONSUMED_SEQ_STATE_DIR", "SLOCK_CLI_DRAFT_STATE_DIR", "SLOCK_CLI_TRANSPORT_DIR", "RAFT_HOME"] as const;
let prior: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let root = "";
let transportDir = "";

beforeEach(() => {
  prior = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cli-sender-once-"));
  transportDir = path.join(root, "transport");
  fs.mkdirSync(transportDir, { recursive: true, mode: 0o700 });
  for (const key of ["SLOCK_CLI_STATE_DIR", "SLOCK_CLI_CONSUMED_SEQ_STATE_DIR", "SLOCK_CLI_DRAFT_STATE_DIR"] as const) {
    process.env[key] = path.join(root, "state");
  }
  process.env.RAFT_HOME = root;
  delete process.env.SLOCK_CLI_TRANSPORT_DIR;
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (prior[key] === undefined) delete process.env[key];
    else process.env[key] = prior[key];
  }
});

function context(contextId: string | null, opts: { passiveAx?: boolean; compactionReported?: boolean } = {}): void {
  if (contextId === null) {
    delete process.env.SLOCK_CLI_TRANSPORT_DIR;
    return;
  }
  process.env.SLOCK_CLI_TRANSPORT_DIR = transportDir;
  fs.writeFileSync(
    path.join(transportDir, "context-generation"),
    JSON.stringify({
      contextId,
      reason: "spawn",
      compactionReported: opts.compactionReported ?? true,
      runtime: "claude",
      writtenAt: "t",
      passiveAx: opts.passiveAx ?? true,
    }),
    { mode: 0o600 },
  );
}

const maggie = (seq: number, description = "Writer. Long profile description.") => ({
  seq,
  id: `0000000${seq}-0000-0000-0000-000000000000`,
  createdAt: "2026-10-08T00:00:00.000Z",
  senderType: "agent",
  senderName: "Maggie",
  senderDescription: description,
  content: `message ${seq}`,
});
const human = (seq: number) => ({ ...maggie(seq), senderType: "human", senderName: "cindyz", senderDescription: "Founder" });

function handles(messages: Array<{ senderName?: string; senderDescription?: string | null }>): string[] {
  return messages.map((m) => (m.senderDescription ? `${m.senderName} — ${m.senderDescription}` : `${m.senderName}`));
}

const agentContext: AgentContext = {
  agentId: AGENT,
  serverUrl: "https://slock.example",
  serverId: "server-1",
  token: "secret-token",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
};

async function read(messages: unknown[]): Promise<string> {
  const stdout: string[] = [];
  const io: CliIo = {
    stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
    stderr: { write: () => true },
  };
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: { messages, has_more: false, has_older: false, has_newer: false },
      }),
    }) as never,
  });
  await messageReadCommand.handler(ctx, { target: "#room" });
  return stdout.join("");
}

test("gate off, no signal, or a runtime without compaction reports: every description is shown", () => {
  for (const setup of [
    () => context(null),
    () => context("ctx-A", { passiveAx: false }),
    () => context("ctx-A", { compactionReported: false }),
  ]) {
    setup();
    const first = elideSeenSenders([maggie(1), maggie(2)], AGENT);
    const second = elideSeenSenders([maggie(3)], AGENT);
    assert.deepEqual(handles([...first.messages, ...second.messages]), [
      "Maggie — Writer. Long profile description.",
      "Maggie — Writer. Long profile description.",
      "Maggie — Writer. Long profile description.",
    ]);
  }
});

test("first message from each sender in a context keeps the description, later ones show the name only", () => {
  context("ctx-A");
  const batch = elideSeenSenders([maggie(1), human(2), maggie(3), human(4)], AGENT);
  assert.deepEqual(handles(batch.messages), ["Maggie — Writer. Long profile description.", "cindyz — Founder", "Maggie", "cindyz"]);
  const later = elideSeenSenders([maggie(5)], AGENT);
  assert.deepEqual(handles(later.messages), ["Maggie"]);
});

test("a new context, a changed description, or a same-name sender of another kind shows it again", () => {
  context("ctx-A");
  elideSeenSenders([maggie(1)], AGENT);
  assert.deepEqual(handles(elideSeenSenders([maggie(2, "Shorter now.")], AGENT).messages), ["Maggie — Shorter now."]);
  assert.deepEqual(handles(elideSeenSenders([{ ...maggie(3), senderType: "human" }], AGENT).messages), ["Maggie — Writer. Long profile description."]);
  context("ctx-B");
  assert.deepEqual(handles(elideSeenSenders([maggie(4, "Shorter now.")], AGENT).messages), ["Maggie — Shorter now."]);
});

test("settle: output that never reached stdout does not count as shown", async () => {
  context("ctx-A");
  const first = elideSeenSenders([maggie(1)], AGENT);
  const brokenPipe: CliIo = {
    stdout: { write: (_chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => { callback?.(new Error("EPIPE")); return false; } } as never,
    stderr: { write: () => true },
  };
  await first.settle(brokenPipe);
  assert.deepEqual(handles(elideSeenSenders([maggie(2)], AGENT).messages), ["Maggie — Writer. Long profile description."]);
});

test("claimObservation is one-shot per (rev, context): a concurrent second claimant loses", () => {
  context("ctx-A");
  assert.equal(claimObservation(AGENT, "sender", "agent:x", "r1", "ctx-A"), true);
  assert.equal(claimObservation(AGENT, "sender", "agent:x", "r1", "ctx-A"), false);
  assert.equal(claimObservation(AGENT, "sender", "agent:x", "r2", "ctx-A"), true);
  assert.equal(claimObservation(AGENT, "sender", "agent:x", "r2", "ctx-B"), true);
  // Release removes only the exact row it names.
  releaseObservation(AGENT, "sender", "agent:x", "r1", "ctx-B");
  assert.equal(claimObservation(AGENT, "sender", "agent:x", "r2", "ctx-B"), false);
  releaseObservation(AGENT, "sender", "agent:x", "r2", "ctx-B");
  assert.equal(claimObservation(AGENT, "sender", "agent:x", "r2", "ctx-B"), true);
});

test("message read: a second read in the same context prints @name only", async () => {
  context("ctx-A");
  const first = await read([maggie(1), maggie(2)]);
  assert.match(first, /\] @Maggie — Writer\. Long profile description\.: message 1/);
  assert.match(first, /\] @Maggie: message 2/);
  const second = await read([maggie(1)]);
  assert.match(second, /\] @Maggie: message 1/);
  context("ctx-B");
  const third = await read([maggie(1)]);
  assert.match(third, /\] @Maggie — Writer\. Long profile description\.: message 1/);
});

// task #266: a human web sender's time zone travels with the description and
// follows the same once-per-context rule.
// History reads carry the camelCase field (the server spreads the row).
const seoul = (seq: number, timezone: string | null = "Asia/Seoul") => ({ ...human(seq), senderTimezone: timezone });

test("time zone: shown with the first message from a sender, then name only; a zone change shows it again", async () => {
  context("ctx-A");
  const first = await read([seoul(1), seoul(2)]);
  assert.match(first, /\] @cindyz \(Asia\/Seoul\) — Founder: message 1/);
  assert.match(first, /\] @cindyz: message 2/);
  const travelled = await read([seoul(3, "America/New_York")]);
  assert.match(travelled, /\] @cindyz \(America\/New_York\) — Founder: message 3/);
});

test("time zone: with the gate off it is shown on every message", async () => {
  context("ctx-A", { passiveAx: false });
  const out = await read([seoul(1), seoul(2)]);
  assert.match(out, /\] @cindyz \(Asia\/Seoul\) — Founder: message 1/);
  assert.match(out, /\] @cindyz \(Asia\/Seoul\) — Founder: message 2/);
});
