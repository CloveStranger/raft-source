import assert from "node:assert/strict";
import { test } from "vitest";

import {
  extractSlackUsergroupMentions,
  parseSlackAgentUsergroupMarker,
  renderSlackUsergroupMentions,
  slackAgentHandleCandidates,
  slackAgentUsergroupMarker,
} from "./slackMentionTokens";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";

test("Slack Agent handle candidates are deterministic and collision-ready", () => {
  assert.deepEqual(slackAgentHandleCandidates({
    name: "Build Bot",
    serverSlug: "Example Org",
    agentId: AGENT_ID,
  }), ["build-bot", "build-bot-example-org", "build-bot-22222222"]);
  const long = slackAgentHandleCandidates({
    name: "x".repeat(100),
    serverSlug: "other-org",
    agentId: AGENT_ID,
  });
  assert.equal(long.length, 3);
  assert.ok(long.every((handle) => handle.length <= 80));
  assert.ok(long[1]?.endsWith("-other-org"));
  assert.ok(long[2]?.endsWith("-22222222"));
});

test("Slack usergroup tokens preserve provider identity and never reject the message", () => {
  assert.deepEqual(
    extractSlackUsergroupMentions("hello <!subteam^S123ABC|@Build-Bot> and <!subteam^S456DEF>"),
    [
      { providerUsergroupId: "S123ABC", handle: "build-bot" },
      { providerUsergroupId: "S456DEF", handle: null },
    ],
  );
  // Ambiguous duplicate labels keep the first: the message must never be
  // dropped just because a usergroup token repeated with a different label.
  assert.deepEqual(
    extractSlackUsergroupMentions("<!subteam^S123ABC|@one> <!subteam^S123ABC|@two>"),
    [{ providerUsergroupId: "S123ABC", handle: "one" }],
  );
  // Mentions beyond the cap are ignored rather than rejecting the message.
  const capped = extractSlackUsergroupMentions(
    "<!subteam^S111AAA> <!subteam^S222BBB> <!subteam^S333CCC>",
    2,
  );
  assert.deepEqual(capped.map((mention) => mention.providerUsergroupId), ["S111AAA", "S222BBB"]);
});

test("managed Slack usergroup markers round-trip only exact Raft coordinates", () => {
  const marker = slackAgentUsergroupMarker(SERVER_ID, AGENT_ID);
  assert.equal(marker, `raft-agent:${SERVER_ID}:${AGENT_ID}`);
  assert.deepEqual(parseSlackAgentUsergroupMarker(marker), { serverId: SERVER_ID, agentId: AGENT_ID });
  assert.equal(parseSlackAgentUsergroupMarker(`${marker}:extra`), null);
  assert.equal(parseSlackAgentUsergroupMarker("ordinary-team"), null);
});

test("Slack usergroups render by exact provider id while plain @ text stays inert", () => {
  const content = "<!subteam^S123ABC|@wrong-handle> ping @alice; <!subteam^S999ZZZ|@unknown>";
  assert.equal(
    renderSlackUsergroupMentions(content, new Map([["S123ABC", "@build-bot"]])),
    "@build-bot ping @alice; @unknown",
  );
});

test("unrecognized Slack usergroups keep the author's label instead of '@Slack group'", () => {
  // A usergroup from another server's agent (or a plain Slack usergroup) is
  // not a Raft mention, but the display must keep the name the author wrote.
  const content = "<!subteam^S1OTHER|@Huarong> said hi; <!subteam^S2NOLABEL> too";
  assert.equal(
    renderSlackUsergroupMentions(content, new Map()),
    "@huarong said hi; @Slack group too",
  );
});
