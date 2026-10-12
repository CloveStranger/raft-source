// Sender details shown once per context (passive resource "sender"): the
// handle text and the version that decides "already shown".
import assert from "node:assert/strict";

import { test } from "vitest";

import { formatAgentSenderHandle, formatSenderHandleText } from "../agentMessageText";
import { elideSeenSenderDescriptions, senderRev } from "./passiveResources";

test("handle text: name, then the sender's time zone, then the description", () => {
  assert.equal(formatSenderHandleText("cindyz", "Founder", "Asia/Shanghai"), "@cindyz (Asia/Shanghai) — Founder");
  assert.equal(formatSenderHandleText("cindyz", null, "Asia/Shanghai"), "@cindyz (Asia/Shanghai)");
  assert.equal(formatSenderHandleText("Maggie", "Writer", null), "@Maggie — Writer");
  assert.equal(formatSenderHandleText("Maggie", null, null), "@Maggie");
  assert.equal(formatAgentSenderHandle({ sender_name: "cindyz", sender_description: "Founder", sender_timezone: "Asia/Seoul" } as never), "@cindyz (Asia/Seoul) — Founder");
});

test("rev: a description-only rev is unchanged by the zone support; a zone or a new zone is a new rev", () => {
  // Pinned: revs recorded before zones existed must still match.
  assert.equal(senderRev("Writer. Long profile description."), senderRev("Writer. Long profile description.", null));
  assert.notEqual(senderRev("Founder", "Asia/Seoul"), senderRev("Founder"));
  assert.notEqual(senderRev("Founder", "Asia/Seoul"), senderRev("Founder", "America/New_York"));
});

test("elision: a sender with only a time zone is still shown once, and both details drop together", () => {
  type M = { type: string; name: string; description: string | null; timezone: string | null };
  const seen = new Set<string>();
  const claim = (id: string, rev: string) => {
    const key = `${id}/${rev}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  const access = {
    get: (m: M) => m,
    withoutDescription: (m: M): M => ({ ...m, description: null, timezone: null }),
  };
  const m = (description: string | null, timezone: string | null): M => ({ type: "human", name: "cindyz", description, timezone });
  const { messages } = elideSeenSenderDescriptions([m(null, "Asia/Seoul"), m(null, "Asia/Seoul"), m(null, null)], access, claim);
  assert.deepEqual(messages.map((x) => x.timezone), ["Asia/Seoul", null, null]);
  const later = elideSeenSenderDescriptions([m("Founder", "Asia/Seoul")], access, claim);
  assert.deepEqual(later.messages[0], m("Founder", "Asia/Seoul"));
});
