import assert from "node:assert/strict";
import {
  AgentSession,
  SessionManager,
  convertToLlm,
  serializeConversation,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { ParsedEvent } from "./types";
import { createPiSdkEventMappingState, mapPiSdkEventToParsedEvents } from "./pi";
import {
  createPiCompactionFitExtension,
  estimatePromptTokens,
  fitMessagesToBudget,
  fitPiCompactionPreparation,
  piCompactionFitBudget,
  takePiCompactionFit,
} from "./piCompactionFit";

const user = (text: string, timestamp = 1) => ({ role: "user", content: text, timestamp });
const textOf = (messages: readonly unknown[]) => serializeConversation(convertToLlm(messages as never));

test("token estimate counts CJK characters one by one and other text at 3.5 characters per token", () => {
  assert.equal(estimatePromptTokens(""), 0);
  assert.equal(estimatePromptTokens("中文测试"), 4);
  assert.equal(estimatePromptTokens("abcdefg"), 2);
  assert.equal(estimatePromptTokens("中文abcdefg"), 4);
});

test("budget: the configured window, or 80% of a rejected context when that is smaller, minus output and prompt", () => {
  const preparation = { tokensBefore: 300_000, settings: { reserveTokens: 16_384 } };
  const model = { contextWindow: 1_000_000, maxTokens: 32_000 };
  const output = Math.floor(0.8 * 16_384);
  assert.equal(piCompactionFitBudget(preparation, model, "threshold"), Math.floor(1_000_000 * 0.85) - output - 2_000);
  // Overflow: the gateway rejected ~300k, so the real limit is below that.
  assert.equal(piCompactionFitBudget(preparation, model, "overflow"), Math.floor(240_000 * 0.85) - output - 2_000);
  // The previous summary is sent too.
  assert.equal(
    piCompactionFitBudget({ ...preparation, previousSummary: "x".repeat(3500) }, model, "threshold"),
    Math.floor(1_000_000 * 0.85) - output - 2_000 - 1_000,
  );
  assert.equal(piCompactionFitBudget(preparation, { contextWindow: 10_000, maxTokens: 32_000 }, "threshold"), null, "no useful room");
});

test("a list that fits is left alone", () => {
  const messages = [user("hello"), user("world")];
  const fit = fitMessagesToBudget(messages, 10_000);
  assert.equal(fit.dropped + fit.truncated, 0);
  assert.deepEqual(fit.messages, messages);
});

test("one oversized message is cut in the middle, with a marker, and the session's own message is untouched", () => {
  const big = user(`HEAD ${"a".repeat(40_000)} TAIL`);
  const original = JSON.stringify(big);
  const fit = fitMessagesToBudget([user("small"), big], 4_000);
  assert.equal(fit.truncated, 1);
  assert.equal(fit.dropped, 0);
  const text = textOf(fit.messages);
  assert.match(text, /HEAD/);
  assert.match(text, /TAIL/);
  assert.match(text, /characters cut by Raft to fit the context-compaction request/);
  assert.ok(fit.after <= 4_000, `after=${fit.after}`);
  assert.equal(JSON.stringify(big), original, "the session message object is not modified");
});

test("an oversized tool-call argument (a huge file write) is cut too", () => {
  const call = {
    role: "assistant",
    content: [{ type: "toolCall", id: "c1", name: "write", arguments: { path: "big.txt", content: `START ${"z".repeat(40_000)} END` } }],
    timestamp: 2,
  };
  const original = JSON.stringify(call);
  const fit = fitMessagesToBudget([user("small"), call], 4_000);
  assert.equal(fit.truncated, 1);
  assert.ok(fit.after <= 4_000, `after=${fit.after}`);
  const text = textOf(fit.messages);
  assert.match(text, /write\(path="big.txt", content="START/, text.slice(0, 300));
  assert.match(text, /characters cut by Raft/);
  assert.equal(JSON.stringify(call), original, "the session message object is not modified");
});

test("too many messages: the oldest are left out and one note says how many", () => {
  const messages = Array.from({ length: 20 }, (_, i) => user(`message-${i} ${"b".repeat(3_500)}`, i + 1));
  const fit = fitMessagesToBudget(messages, 5_000);
  assert.ok(fit.dropped > 0);
  assert.ok(fit.after <= 5_000, `after=${fit.after}`);
  const text = textOf(fit.messages);
  assert.match(text, new RegExp(`\\[Raft: ${fit.dropped} earlier messages \\(about \\d+ tokens\\) were left out of this summary`));
  assert.match(text, /message-19/, "the newest message is kept");
  assert.doesNotMatch(text, /message-0 /, "the oldest message is left out");
});

test("fitPiCompactionPreparation replaces the arrays, reports what it did, and returns null when nothing was needed", () => {
  const small = { messagesToSummarize: [user("a")], turnPrefixMessages: [], tokensBefore: 10, settings: { reserveTokens: 1_000 } };
  assert.equal(fitPiCompactionPreparation(small, { contextWindow: 100_000, maxTokens: 1_000 }, "threshold"), null);

  const messages = Array.from({ length: 30 }, (_, i) => user(`m${i} ${"c".repeat(3_500)}`, i + 1));
  const preparation = { messagesToSummarize: messages, turnPrefixMessages: [], tokensBefore: 40_000, settings: { reserveTokens: 1_000 } };
  const fit = fitPiCompactionPreparation(preparation, { contextWindow: 100_000, maxTokens: 1_000 }, "overflow");
  assert.ok(fit);
  assert.equal(fit.trigger, "overflow");
  assert.ok(fit.droppedMessages > 0);
  assert.notEqual(preparation.messagesToSummarize, messages, "a new array; the session's array is untouched");
  assert.equal(messages.length, 30);
});

// The installed Pi SDK's real auto-compaction, with the Raft extension wired
// through its extension runner and a summarizer that rejects requests over a
// limit, like a gateway whose real limit is below the configured window.
function fixture(limitTokens: number, withFit: boolean) {
  const manager = SessionManager.inMemory();
  for (let i = 0; i < 40; i++) manager.appendMessage({ role: "user", content: `turn-${i} ${"x".repeat(3_500)}`, timestamp: i + 1 });
  const sdkEvents: AgentSessionEvent[] = [];
  const parsed: ParsedEvent[] = [];
  const state = createPiSdkEventMappingState("task10-fit");
  const model = { id: "gpt-6.1-sol", provider: "gateway", contextWindow: 1_000_000, maxTokens: 8_192 };
  const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
  if (withFit) createPiCompactionFitExtension()({ on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers[name] = handler; } } as never);
  let summarizedTokens = 0;
  const session = {
    _overflowRecoveryAttempted: false,
    model, sessionManager: manager,
    settingsManager: { getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 2_000 }) },
    agent: { state: { messages: manager.buildSessionContext().messages }, hasQueuedMessages: () => false },
    _extensionRunner: {
      hasHandlers: (type: string) => Boolean(handlers[type]),
      emit: async (event: { type: string }) => handlers[event.type]?.(event, { sessionManager: manager, model }),
    },
    _entryIdsByMessage: new Map<unknown, string>(),
    _runDefaultCompaction: async (preparation: { messagesToSummarize: unknown[]; firstKeptEntryId: string; tokensBefore: number }) => {
      summarizedTokens = estimatePromptTokens(textOf(preparation.messagesToSummarize));
      if (summarizedTokens > limitTokens) throw new Error(`400: This model's maximum context length is ${limitTokens} tokens. However, you requested ${summarizedTokens} tokens.`);
      return { summary: "synthetic summary", firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore };
    },
    _emitSessionCompactFailed: async () => undefined,
    _resolveIdleWaitIfIdle: () => undefined,
    _emit: (event: AgentSessionEvent) => {
      sdkEvents.push(event);
      const fit = event.type === "compaction_end" ? takePiCompactionFit(manager) : undefined;
      parsed.push(...mapPiSdkEventToParsedEvents(event, state, {
        messageCount: 40, inputTextLength: 140_000, configuredContextLimit: model.contextWindow, ...(fit ? { fit } : {}),
      }));
    },
  };
  Object.setPrototypeOf(session, AgentSession.prototype);
  const run = (reason: string, retry: boolean) =>
    (AgentSession.prototype as unknown as { _runAutoCompaction(r: string, t: boolean): Promise<boolean> })._runAutoCompaction.call(session, reason, retry);
  return { run, sdkEvents, parsed, summarized: () => summarizedTokens };
}

test("without the fit, a history above the gateway's real limit can never be compacted", async () => {
  const f = fixture(20_000, false);
  assert.equal(await f.run("overflow", true), false);
  assert.equal(f.parsed.find((e) => e.kind === "error")?.compaction?.failureReason, "input_too_large");
});

test("with the fit, overflow recovery succeeds below the rejected size and the telemetry says what was left out", async () => {
  // The session overflowed at ~35k tokens; the gateway's real limit is 20k.
  const f = fixture(20_000, true);
  // tokensBefore comes from Pi's own estimate; make the overflow trigger see it as rejected.
  assert.equal(await f.run("overflow", true), true);
  assert.ok(f.summarized() <= 20_000, `summarized=${f.summarized()}`);
  assert.ok(f.parsed.some((e) => e.kind === "compaction_finished"));
  const recovery = f.parsed.find((e) => e.kind === "telemetry" && e.name === "recovery");
  assert.ok(recovery && recovery.kind === "telemetry");
  assert.equal(recovery.attrs.compaction_fit_applied, true);
  assert.equal(recovery.attrs.compaction_fit_trigger, "overflow");
  assert.ok(Number(recovery.attrs.compaction_fit_dropped_messages) > 0);
});

test("with the fit, a compaction that already fits is not touched", async () => {
  const f = fixture(1_000_000, true);
  assert.equal(await f.run("threshold", false), false, "threshold compaction does not retry");
  const recovery = f.parsed.find((e) => e.kind === "telemetry" && e.name === "recovery");
  assert.ok(recovery && recovery.kind === "telemetry");
  assert.equal(recovery.attrs.compaction_fit_applied, undefined);
  assert.ok(f.parsed.some((e) => e.kind === "compaction_finished"));
});
