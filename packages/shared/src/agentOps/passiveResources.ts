// Passive AX resource registry (RFC 072).
//
// A passive resource is something an agent could look at with an active
// command, and whose staleness the CLI can notice for it: the agent's local
// ledger records the version (`rev`) it last actually saw, and each command
// that touches the resource compares that against the current version. The
// registry is the only place a new resource type is declared; the CLI's
// engine dispatches on these fields and never on the type name.
//
// Admission rule: a thing is a resource only if a bounded, agent-specific
// version can be given for it. An unbounded, query-driven listing (for
// example the integration marketplace) is not one.
//
// "Seen" is bounded twice (RFC 072 §7), and both bounds are part of the
// contract:
// - it lasts one model context. The daemon issues a new opaque contextId at
//   every runtime spawn and every compaction start; anything recorded under
//   another contextId counts as not seen;
// - it means the CLI delivered the content into the context (stdout flushed),
//   NOT that the model read or learned it: runtimes truncate long tool output.
//   A hold guarantees the content landed in context before the action ran,
//   nothing more; it is not proof the agent has learned a rule.
//
// Policy, by the consequence of missing a change:
// - hold: the action waits until the current version has been delivered.
// - once: nothing waits; the full form is delivered the first time in a
//   context (or after the version moved) and a short form after that.
// A lighter tier (one hint line naming the active command when the version
// moved) lands with its first user, the channel description type.

import { formatHint, RAFT_HINTS } from "./hint";

export type PassiveResourcePolicy = "hold" | "once";

export interface PassiveResourceSpec {
  /** Where the current version comes from. */
  revSource: "server-seq" | "content-hash";
  /** Consequence tier of acting without having seen the current version. */
  policy: PassiveResourcePolicy;
  /** The active command that shows the resource; printed verbatim where it is pointed to. */
  activeCommand: (id: string) => string;
  /** What touches the resource. */
  touchedBy: readonly string[];
}

export const PASSIVE_RESOURCES = {
  // A conversation's messages. Version: the highest message seq the agent
  // has read in full. Enforced by the send freshness hold (server decides).
  thread: {
    revSource: "server-seq",
    policy: "hold",
    activeCommand: (id) => formatHint(RAFT_HINTS.messageRead({ target: id })),
    touchedBy: ["message send"],
  },
  // A consequential command's usage guidance (RFC 072 §7). Version: hash of
  // the text. The first run in a context delivers it instead of executing;
  // `--help` always prints it in full and also counts as delivery.
  "command.guidance": {
    revSource: "content-hash",
    policy: "hold",
    activeCommand: (id) => `raft ${id} --help`,
    touchedBy: ["the command itself", "--help"],
  },
  // Who sent a message: the sender's profile description and, for a human web
  // sender, the time zone the message was sent from, shown next to the name in
  // agent-facing message text. Version: hash of both.
  // The first message from a sender in a context carries it; later ones show
  // only `@name`. Id: `senderObservationId`.
  sender: {
    revSource: "content-hash",
    policy: "once",
    activeCommand: (id) => formatHint(RAFT_HINTS.userInfo({ name: id.slice(id.indexOf(":") + 1) })),
    touchedBy: ["daemon message delivery", "message read", "message check", "message resolve", "message send (missed messages)"],
  },
} as const satisfies Record<string, PassiveResourceSpec>;

export type PassiveResourceType = keyof typeof PASSIVE_RESOURCES;

// ---- sender (policy "once") ----

/**
 * Ledger id of a sender. Humans and agents may share a name, so the kind is
 * part of it. A rename is a new id, which only shows the description once more.
 */
export function senderObservationId(senderType: string | null | undefined, senderName: string): string {
  return `${senderType ?? "unknown"}:${senderName}`;
}

/** FNV-1a, 32-bit, over UTF-16 code units. */
function fnv1a32(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Version of what a sender's handle shows. Pure TS (no node:crypto: the SDK
 * and daemon share this). Two independent 32-bit hashes keep an accidental
 * collision, which would hide a changed description for one context, remote.
 */
export function senderRev(description: string | null | undefined, timezone?: string | null): string {
  // Without a zone the input is the description alone, so revs recorded
  // before zones existed stay valid.
  const text = timezone ? `${description ?? ""}\u0000tz=${timezone}` : (description ?? "");
  const a = fnv1a32(text, 0x811c9dc5).toString(16).padStart(8, "0");
  const b = fnv1a32(text, 0x050c5d1f).toString(16).padStart(8, "0");
  return `${a}${b}`;
}

/**
 * Claims the first full showing of `(sender, rev)` in the current context.
 * `true`: show it in full (and it is now recorded); `false`: already shown in
 * this context, show `@name` only. Any doubt (no ledger, an error) must answer
 * `true`: showing a description once too often is the safe direction.
 */
export type SenderClaim = (id: string, rev: string) => boolean;

export interface SenderElision<T> {
  messages: T[];
  /** What this call recorded, so a caller whose output then fails can release it. */
  claimed: Array<{ id: string; rev: string }>;
}

/**
 * Drops the sender details (description and time zone) from every message
 * whose sender was already shown in full in this context, oldest first, so
 * the first message from each sender in a batch keeps them. Messages are not
 * mutated.
 */
export function elideSeenSenderDescriptions<T>(
  messages: readonly T[],
  access: {
    get: (m: T) => {
      type: string | null | undefined;
      name: string | null | undefined;
      description: string | null | undefined;
      timezone?: string | null | undefined;
    };
    /** The same message with neither description nor time zone. */
    withoutDescription: (m: T) => T;
  },
  claim: SenderClaim,
): SenderElision<T> {
  const seen = new Set<string>();
  const claimed: Array<{ id: string; rev: string }> = [];
  const out = messages.map((m) => {
    const { type, name, description, timezone } = access.get(m);
    if (!name || (!description && !timezone)) return m;
    const id = senderObservationId(type, name);
    const rev = senderRev(description, timezone);
    const key = `${id}\u0000${rev}`;
    // Within one batch only the first message from a sender can be the first.
    if (seen.has(key)) return access.withoutDescription(m);
    seen.add(key);
    if (!claim(id, rev)) return access.withoutDescription(m);
    claimed.push({ id, rev });
    return m;
  });
  return { messages: out, claimed };
}
