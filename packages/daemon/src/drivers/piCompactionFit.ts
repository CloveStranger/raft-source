import {
  convertToLlm,
  serializeConversation,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

/**
 * Keeps a Pi compaction request inside the model's input limit.
 *
 * Pi summarizes everything older than `keepRecentTokens` in ONE request and
 * never splits it. Once that history no longer fits the model, compaction can
 * never succeed, and the session is stuck: every later turn overflows and
 * every compaction fails again (task #10; one agent failed 759 times in a
 * week). Summarizing in several requests would mean calling the model from
 * here, outside Pi's own request path (its auth resolution and the
 * session-local credentials and proxy Raft installs), so this does not. It
 * trims what Pi is about to summarize instead and lets Pi's own compaction run:
 *
 * - a single message larger than half the budget has its text cut in the
 *   middle, with a marker saying how much was cut;
 * - if it still does not fit, the oldest messages are dropped and replaced by
 *   one note saying how many were left out. The previous compaction's summary
 *   is kept, so what is lost is the oldest stretch since that compaction.
 *
 * It changes nothing when the request already fits. The budget is the smaller
 * of the configured context window and, for overflow recovery, 80% of the
 * context that was just rejected (a gateway's real limit can be lower than
 * what is configured), minus Pi's output budget and the summary prompt, with a
 * safety factor. Tokens are estimated from the text Pi will send, counting CJK
 * characters as one token each.
 */

type CompactionPreparationLike = {
  messagesToSummarize: unknown[];
  turnPrefixMessages: unknown[];
  tokensBefore: number;
  previousSummary?: string;
  settings: { reserveTokens: number };
};

type ModelLike = { contextWindow?: number; maxTokens?: number } | undefined;

export type PiCompactionFitTrigger = "threshold" | "overflow" | "manual";

export interface PiCompactionFit {
  trigger: PiCompactionFitTrigger;
  budgetTokens: number;
  tokensBefore: number;
  tokensAfter: number;
  droppedMessages: number;
  droppedTokens: number;
  truncatedMessages: number;
  truncatedChars: number;
}

/** Share of the effective window the summary request may use; covers estimate error. */
const SAFETY_FACTOR = 0.85;
/** Share of a rejected (overflowed) context taken as the real limit for this request. */
const OVERFLOW_WINDOW_FACTOR = 0.8;
/** Pi's summarization system prompt and instructions, with room to spare. */
const SUMMARY_PROMPT_TOKENS = 2_000;
/** Below this there is no useful room to summarize anything; leave it to Pi. */
const MIN_BUDGET_TOKENS = 2_000;
/** Non-CJK characters per token. Lower than the usual 4 so code is not underestimated. */
const CHARS_PER_TOKEN = 3.5;
/** Strings up to this long are never cut. */
const MIN_CUT_CHARS = 256;

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/gu;

/** Conservative token estimate: one token per CJK character, CHARS_PER_TOKEN characters per token otherwise. */
export function estimatePromptTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK)?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / CHARS_PER_TOKEN);
}

/** The text Pi will send for one message when summarizing (same serializer Pi uses). */
function summaryText(message: unknown): string {
  try {
    return serializeConversation(convertToLlm([message as never]));
  } catch {
    return "";
  }
}

export function piCompactionFitBudget(
  preparation: Pick<CompactionPreparationLike, "tokensBefore" | "previousSummary" | "settings">,
  model: ModelLike,
  trigger: PiCompactionFitTrigger,
): number | null {
  const configured = typeof model?.contextWindow === "number" && model.contextWindow > 0 ? model.contextWindow : null;
  const rejected = trigger === "overflow" && preparation.tokensBefore > 0
    ? Math.floor(preparation.tokensBefore * OVERFLOW_WINDOW_FACTOR)
    : null;
  const window = configured === null ? rejected : rejected === null ? configured : Math.min(configured, rejected);
  if (window === null) return null;
  const reserve = Math.max(0, preparation.settings?.reserveTokens ?? 0);
  // Pi's summary output cap (generateSummaryWithUsage).
  const output = Math.min(Math.floor(0.8 * reserve), typeof model?.maxTokens === "number" && model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY);
  const budget = Math.floor(window * SAFETY_FACTOR) - output - SUMMARY_PROMPT_TOKENS - estimatePromptTokens(preparation.previousSummary ?? "");
  return budget >= MIN_BUDGET_TOKENS ? budget : null;
}

function truncateText(text: string, keepChars: number, note: (cut: number) => string): { text: string; cut: number } {
  if (text.length <= keepChars) return { text, cut: 0 };
  const head = Math.ceil(keepChars * 0.6);
  const tail = Math.max(0, keepChars - head);
  const cut = text.length - head - tail;
  return { text: `${text.slice(0, head)}${note(cut)}${tail > 0 ? text.slice(text.length - tail) : ""}`, cut };
}

const truncationNote = (cut: number) => `\n[... ${cut} characters cut by Raft to fit the context-compaction request ...]\n`;

/**
 * A copy of `message` whose text is cut to about `ratio` of its length. Only
 * what Pi summarizes is touched (user text, assistant text and thinking, and
 * the string arguments of assistant tool calls, which Pi serializes in full);
 * the session's own message objects are never modified.
 */
function truncateMessage(message: unknown, ratio: number): { message: unknown; cut: number } {
  if (!message || typeof message !== "object") return { message, cut: 0 };
  const source = message as { role?: unknown; content?: unknown };
  let cut = 0;
  const shrink = (text: string) => {
    // Short strings (a path, a name) carry little weight; cutting them only garbles them.
    if (text.length <= MIN_CUT_CHARS) return text;
    const result = truncateText(text, Math.max(MIN_CUT_CHARS, Math.floor(text.length * ratio)), truncationNote);
    cut += result.cut;
    return result.text;
  };
  if (typeof source.content === "string") {
    return { message: { ...source, content: shrink(source.content) }, cut };
  }
  if (!Array.isArray(source.content)) return { message, cut: 0 };
  const content = source.content.map((block: unknown) => {
    if (!block || typeof block !== "object") return block;
    const b = block as { type?: unknown; text?: unknown; thinking?: unknown };
    if (b.type === "text" && typeof b.text === "string") return { ...b, text: shrink(b.text) };
    if (b.type === "thinking" && typeof b.thinking === "string") return { ...b, thinking: shrink(b.thinking) };
    const call = block as { type?: unknown; arguments?: unknown };
    if (call.type === "toolCall" && call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)) {
      const args = Object.fromEntries(Object.entries(call.arguments as Record<string, unknown>).map(([key, value]) =>
        [key, typeof value === "string" ? shrink(value) : value]));
      return { ...call, arguments: args };
    }
    return block;
  });
  return { message: { ...source, content }, cut };
}

function omittedNote(count: number, tokens: number, timestamp: unknown): unknown {
  return {
    role: "user",
    content: [{
      type: "text",
      text: `[Raft: ${count} earlier message${count === 1 ? "" : "s"} (about ${tokens} tokens) were left out of this summary because they did not fit in one summarization request.]`,
    }],
    timestamp: typeof timestamp === "number" ? timestamp : Date.now(),
  };
}

type ListFit = { messages: unknown[]; before: number; after: number; dropped: number; droppedTokens: number; truncated: number; truncatedChars: number };

/** Fits one list of messages (the history, or a split turn's prefix) into `budget` tokens. */
export function fitMessagesToBudget(messages: readonly unknown[], budget: number): ListFit {
  const sizes = messages.map((message) => estimatePromptTokens(summaryText(message)) + 1);
  const before = sizes.reduce((sum, size) => sum + size, 0);
  if (before <= budget) {
    return { messages: [...messages], before, after: before, dropped: 0, droppedTokens: 0, truncated: 0, truncatedChars: 0 };
  }
  // 1. No single message may take more than half the budget.
  const maxSingle = Math.floor(budget / 2);
  let truncated = 0;
  let truncatedChars = 0;
  const fitted = messages.map((message, index) => {
    if (sizes[index]! <= maxSingle) return message;
    const result = truncateMessage(message, (maxSingle / sizes[index]!) * 0.9);
    if (result.cut === 0) return message;
    truncated += 1;
    truncatedChars += result.cut;
    sizes[index] = estimatePromptTokens(summaryText(result.message)) + 1;
    return result.message;
  });
  // 2. Drop the oldest until the rest, plus a note about what was left out, fits.
  const noteTokens = 60;
  let total = sizes.reduce((sum, size) => sum + size, 0);
  let start = 0;
  let droppedTokens = 0;
  while (total + (start > 0 ? noteTokens : 0) > budget && start < fitted.length - 1) {
    total -= sizes[start]!;
    droppedTokens += sizes[start]!;
    start += 1;
  }
  // The newest message is always kept. If, even cut, it alone is over the
  // budget (content that cannot be cut, such as non-string tool arguments),
  // this request still cannot fit; Pi's compaction fails as before and the
  // failure cap stops further retries.
  const kept = fitted.slice(start);
  const result = start > 0
    ? [omittedNote(start, droppedTokens, (messages[start] as { timestamp?: unknown } | undefined)?.timestamp), ...kept]
    : kept;
  return {
    messages: result,
    before,
    after: total + (start > 0 ? noteTokens : 0),
    dropped: start,
    droppedTokens,
    truncated,
    truncatedChars,
  };
}

/**
 * Trims `preparation` in place (its message arrays are replaced, never the
 * session's message objects). Returns what was done, or null when the request
 * already fits or no usable budget exists.
 */
export function fitPiCompactionPreparation(
  preparation: CompactionPreparationLike,
  model: ModelLike,
  trigger: PiCompactionFitTrigger,
): PiCompactionFit | null {
  const budget = piCompactionFitBudget(preparation, model, trigger);
  if (budget === null) return null;
  // Pi sends the history and a split turn's prefix as two separate requests.
  const history = fitMessagesToBudget(preparation.messagesToSummarize, budget);
  const prefix = fitMessagesToBudget(preparation.turnPrefixMessages, budget);
  if (history.dropped + history.truncated + prefix.dropped + prefix.truncated === 0) return null;
  preparation.messagesToSummarize = history.messages;
  preparation.turnPrefixMessages = prefix.messages;
  return {
    trigger,
    budgetTokens: budget,
    tokensBefore: history.before + prefix.before,
    tokensAfter: history.after + prefix.after,
    droppedMessages: history.dropped + prefix.dropped,
    droppedTokens: history.droppedTokens + prefix.droppedTokens,
    truncatedMessages: history.truncated + prefix.truncated,
    truncatedChars: history.truncatedChars + prefix.truncatedChars,
  };
}

/** The last fit per session, read once by the compaction_end telemetry. Keyed by Pi's SessionManager. */
const lastFits = new WeakMap<object, PiCompactionFit>();

export function takePiCompactionFit(sessionManager: object | undefined): PiCompactionFit | undefined {
  if (!sessionManager) return undefined;
  const fit = lastFits.get(sessionManager);
  lastFits.delete(sessionManager);
  return fit;
}

/** Inline Pi extension: trims an oversized compaction request before Pi's own summarizer runs. */
export function createPiCompactionFitExtension(): ExtensionFactory {
  return (pi) => {
    pi.on("session_before_compact", (event, ctx) => {
      const sessionManager = ctx.sessionManager as object;
      lastFits.delete(sessionManager);
      const fit = fitPiCompactionPreparation(event.preparation as unknown as CompactionPreparationLike, ctx.model, event.reason);
      if (fit) lastFits.set(sessionManager, fit);
      return undefined;
    });
  };
}

/** Present only when Raft trimmed the request, so the share of lossy compactions is applied / all recovery events. */
export function piCompactionFitTelemetryAttrs(fit: PiCompactionFit | undefined): Record<string, string | number | boolean> {
  if (!fit) return {};
  return {
    compaction_fit_applied: true,
    compaction_fit_trigger: fit.trigger,
    compaction_fit_budget_tokens: fit.budgetTokens,
    compaction_fit_tokens_before: fit.tokensBefore,
    compaction_fit_tokens_after: fit.tokensAfter,
    compaction_fit_dropped_messages: fit.droppedMessages,
    compaction_fit_dropped_tokens: fit.droppedTokens,
    compaction_fit_truncated_messages: fit.truncatedMessages,
    compaction_fit_truncated_chars: fit.truncatedChars,
  };
}
