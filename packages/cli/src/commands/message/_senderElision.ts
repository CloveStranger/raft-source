// Sender details (profile description, and a human web sender's time zone)
// are shown once per model context (RFC 072 passive
// resource "sender", policy "once"): the first message from a sender in this
// context keeps `@name — description`, later ones show `@name` only. The
// daemon applies the same rule to live delivery through the same ledger rows.
import { elideSeenSenderDescriptions } from "@botiverse/raft-shared";

import { senderClaimForContext } from "../../ax/passiveEngine";
import type { CliIo } from "../../core/io";
import { flushText } from "../../core/renderer";

interface SenderFields {
  senderType?: unknown;
  sender_type?: unknown;
  senderName?: unknown;
  sender_name?: unknown;
  senderDescription?: unknown;
  sender_description?: unknown;
  senderTimezone?: unknown;
  sender_timezone?: unknown;
}

function text(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === "string") return value;
  return undefined;
}

export interface ElidedMessages<T> {
  messages: T[];
  /**
   * Call after writing the output: when it did not reach stdout, the
   * descriptions this call recorded count as not shown. Flushes only when
   * something was recorded.
   */
  settle: (io: CliIo) => Promise<void>;
}

export function elideSeenSenders<T extends object>(
  messages: readonly T[],
  agentId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ElidedMessages<T> {
  const ledger = senderClaimForContext(agentId, env);
  if (!ledger || messages.length === 0) return { messages: [...messages], settle: async () => {} };
  const { messages: out, claimed } = elideSeenSenderDescriptions(
    messages,
    {
      get: (message) => {
        const m = message as SenderFields;
        return {
          type: text(m.senderType, m.sender_type),
          name: text(m.senderName, m.sender_name),
          description: text(m.senderDescription, m.sender_description),
          timezone: text(m.senderTimezone, m.sender_timezone),
        };
      },
      withoutDescription: (m) => ({ ...m, senderDescription: null, sender_description: null, senderTimezone: null, sender_timezone: null }),
    },
    ledger.claim,
  );
  return {
    messages: out,
    settle: async (io) => {
      if (claimed.length > 0 && !(await flushText(io))) ledger.release(claimed);
    },
  };
}
