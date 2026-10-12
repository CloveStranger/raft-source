// RFC 074 §2 personal assistant (v0): the owner-only link and the two
// assistant-only reads. The assistant always calls with its own credential;
// these tests pin who may create the link, that every read re-checks it, that
// DMs (and threads under DMs) never come back, and that reading changes none
// of the owner's state.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { channelAgents, featureFlags, threadFollows } from "../db/schema";
import { addMember, removeMember } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createFeatureFlag, IDENTITY_BORROWING_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { addAgent, addHuman, canAgentPostToChannel, createChannel, findOrCreateAgentDM, findOrCreateDM, findOrCreateUserDM, getSystemAllChannel, getOrCreateThread, removeAgent } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { createServer, headers, seedUser } from "./channels.api.fixtures";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function enableBorrowing(enabled = true) {
  const [existing] = await getDb().select().from(featureFlags).where(eq(featureFlags.key, IDENTITY_BORROWING_FEATURE_FLAG_KEY));
  if (existing) {
    await getDb().update(featureFlags).set({ defaultEnabled: enabled }).where(eq(featureFlags.key, IDENTITY_BORROWING_FEATURE_FLAG_KEY));
    return;
  }
  await createFeatureFlag({ key: IDENTITY_BORROWING_FEATURE_FLAG_KEY, randomizationUnit: "server", enabled: true, defaultEnabled: enabled });
}

async function seedFixture() {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`assistant-owner-${suffix}@slock.test`, `assistant-owner-${suffix}`);
  const peer = await seedUser(`assistant-peer-${suffix}@slock.test`, `assistant-peer-${suffix}`);
  const server = await createServer("Assistant Server", `assistant-${suffix}`, owner.id);
  await addMember(server.id, peer.id);

  const room = await createChannel(server.id, `room-${suffix}`);
  await addHuman(room.id, owner.id);
  await addHuman(room.id, peer.id);
  const roomMessage = await createMessage(room.id, "user", peer.id, "room activity");
  const roomThread = await getOrCreateThread(roomMessage.id, peer.id, "user");
  await createMessage(roomThread.id, "user", peer.id, "room thread reply");
  await getDb().insert(threadFollows).values({
    threadChannelId: roomThread.id,
    followerType: "user",
    followerId: owner.id,
    parentMessageId: roomMessage.id,
    reason: "manual",
  });

  // A private channel the owner is NOT in: never visible to the assistant.
  const secret = await createChannel(server.id, `secret-${suffix}`, undefined, "private");
  await addHuman(secret.id, peer.id);
  await createMessage(secret.id, "user", peer.id, "private chatter");

  const dm = await findOrCreateUserDM(server.id, owner.id, peer.id);
  assert.ok(dm);
  const dmMessage = await createMessage(dm.id, "user", peer.id, "dm activity");
  const dmThread = await getOrCreateThread(dmMessage.id, peer.id, "user");
  await createMessage(dmThread.id, "user", peer.id, "dm thread reply");
  await getDb().insert(threadFollows).values({
    threadChannelId: dmThread.id,
    followerType: "user",
    followerId: owner.id,
    parentMessageId: dmMessage.id,
    reason: "manual",
  });

  const assistant = await createAgent(server.id, `assistant-${suffix}`, { runtime: "codex", creatorType: "user", creatorId: owner.id });
  const credential = await mintAgentCredential({ agentId: assistant.id, scopes: ["read"], name: "assistant-test", createdByUserId: null });
  return { owner, peer, server, room, roomThread, secret, dm, dmThread, assistant, apiKey: credential.apiKey };
}

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

async function agentGet(baseUrl: string, apiKey: string, path: string) {
  const res = await fetch(`${baseUrl}/internal/agent-api${path}`, { headers: { Authorization: `Bearer ${apiKey}` } });
  return { status: res.status, body: await res.json() as Record<string, any> };
}

async function setAssistant(baseUrl: string, f: Fixture, method: "PUT" | "DELETE", asEmail = f.owner.email, agentId = f.assistant.id) {
  const token = await tokenForHuman(asEmail);
  const res = await fetch(`${baseUrl}/api/agents/${agentId}/assistant-owner`, { method, headers: headers(token, f.server.id) });
  return { status: res.status, body: await res.json() as Record<string, any> };
}

async function ownerUnread(baseUrl: string, f: Fixture): Promise<Record<string, number>> {
  const token = await tokenForHuman(f.owner.email);
  const res = await fetch(`${baseUrl}/api/channels/inbox?filter=unread&limit=100`, { headers: headers(token, f.server.id) });
  assert.equal(res.status, 200);
  const body = await res.json() as { items: Array<{ kind: string; channelId?: string; threadChannelId?: string; unreadCount: number }> };
  return Object.fromEntries(body.items.map((item) => [item.kind === "thread" ? item.threadChannelId! : item.channelId!, item.unreadCount]));
}

test("only the owner can link an agent they created, and only while the flag is on", async ({ app }) => {
  const f = await seedFixture();

  const flagOff = await setAssistant(app.baseUrl, f, "PUT");
  assert.equal(flagOff.status, 403);
  assert.equal(flagOff.body.code, "assistant_not_enabled");

  await enableBorrowing();
  // The peer did not create the agent: no lending your reading to someone else's agent, and no admin grants.
  const notCreator = await setAssistant(app.baseUrl, f, "PUT", f.peer.email);
  assert.equal(notCreator.status, 403);
  assert.equal(notCreator.body.code, "assistant_requires_creator");

  const linked = await setAssistant(app.baseUrl, f, "PUT");
  assert.equal(linked.status, 200);
  assert.deepEqual(linked.body.assistantOf, { userId: f.owner.id });
  assert.equal((await setAssistant(app.baseUrl, f, "PUT")).status, 200, "setting it again is a no-op");

  const second = await createAgent(f.server.id, `second-${randomUUID().slice(0, 8)}`, { runtime: "codex", creatorType: "user", creatorId: f.owner.id });
  const conflict = await setAssistant(app.baseUrl, f, "PUT", f.owner.email, second.id);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "assistant_already_set");

  const peerClear = await setAssistant(app.baseUrl, f, "DELETE", f.peer.email);
  assert.equal(peerClear.status, 403);

  // An agent credential is not a human session.
  const viaAgent = await fetch(`${app.baseUrl}/api/agents/${f.assistant.id}/assistant-owner`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${f.apiKey}`, "X-Server-Id": f.server.id },
  });
  assert.equal(viaAgent.status, 401);

  const whoami = await agentGet(app.baseUrl, f.apiKey, "/context");
  assert.equal(whoami.status, 200);
  assert.deepEqual(whoami.body.agent.assistantOf, { userId: f.owner.id });

  const cleared = await setAssistant(app.baseUrl, f, "DELETE");
  assert.equal(cleared.status, 200);
  assert.equal((await agentGet(app.baseUrl, f.apiKey, "/context")).body.agent.assistantOf, null);
});

test("the owner inbox lists what the owner sees, minus DMs, and reads nothing", async ({ app }) => {
  const f = await seedFixture();
  await enableBorrowing();
  assert.equal((await setAssistant(app.baseUrl, f, "PUT")).status, 200);
  const before = await ownerUnread(app.baseUrl, f);
  assert.ok(before[f.dm.id] && before[f.dmThread.id], "fixture: the owner has unread DM activity");

  const inbox = await agentGet(app.baseUrl, f.apiKey, "/assistant/owner-inbox?filter=unread&limit=50");
  assert.equal(inbox.status, 200);
  assert.deepEqual(inbox.body.owner, { userId: f.owner.id });
  const ids = (inbox.body.items as Array<{ channelId: string; kind: string }>).map((item) => item.channelId);
  assert.ok(ids.includes(f.room.id));
  assert.ok(ids.includes(f.roomThread.id));
  assert.ok(!ids.includes(f.dm.id), "a DM never comes back");
  assert.ok(!ids.includes(f.dmThread.id), "a thread under a DM never comes back");
  assert.ok(!ids.includes(f.secret.id), "a channel the owner cannot see never comes back");
  const thread = (inbox.body.items as Array<Record<string, unknown>>).find((item) => item.channelId === f.roomThread.id);
  assert.equal(thread?.kind, "thread");
  assert.equal(thread?.parentChannelId, f.room.id);

  assert.deepEqual(await ownerUnread(app.baseUrl, f), before, "listing changes none of the owner's read state");
});

test("owner messages reads what the owner can see and refuses DMs with the neutral 404", async ({ app }) => {
  const f = await seedFixture();
  await enableBorrowing();
  assert.equal((await setAssistant(app.baseUrl, f, "PUT")).status, 200);
  const before = await ownerUnread(app.baseUrl, f);

  const room = await agentGet(app.baseUrl, f.apiKey, `/assistant/owner-messages?channelId=${f.room.id}`);
  assert.equal(room.status, 200);
  assert.deepEqual((room.body.messages as Array<{ content: string }>).map((m) => m.content), ["room activity"]);
  const thread = await agentGet(app.baseUrl, f.apiKey, `/assistant/owner-messages?channelId=${f.roomThread.id}`);
  assert.equal(thread.status, 200);
  assert.deepEqual((thread.body.messages as Array<{ content: string }>).map((m) => m.content), ["room thread reply"]);

  for (const channelId of [f.dm.id, f.dmThread.id, f.secret.id, randomUUID()]) {
    const refused = await agentGet(app.baseUrl, f.apiKey, `/assistant/owner-messages?channelId=${channelId}`);
    assert.equal(refused.status, 404, channelId);
    assert.deepEqual(refused.body, { error: "Channel not found or not visible", code: "channel_not_found" });
  }

  assert.deepEqual(await ownerUnread(app.baseUrl, f), before, "reading changes none of the owner's read state");
});

test("every read re-checks the link, the owner's membership, and the flag", async ({ app }) => {
  const f = await seedFixture();
  const expectRefused = async (label: string) => {
    for (const path of ["/assistant/owner-inbox", `/assistant/owner-messages?channelId=${f.room.id}`]) {
      const res = await agentGet(app.baseUrl, f.apiKey, path);
      assert.equal(res.status, 403, `${label}: ${path}`);
      assert.equal(res.body.code, "assistant_not_enabled", `${label}: ${path}`);
    }
  };

  await enableBorrowing();
  await expectRefused("not an assistant");
  assert.equal((await setAssistant(app.baseUrl, f, "PUT")).status, 200);
  assert.equal((await agentGet(app.baseUrl, f.apiKey, "/assistant/owner-inbox")).status, 200);

  await enableBorrowing(false);
  await expectRefused("flag off");
  await enableBorrowing(true);
  assert.equal((await agentGet(app.baseUrl, f.apiKey, "/assistant/owner-inbox")).status, 200);

  assert.equal((await setAssistant(app.baseUrl, f, "DELETE")).status, 200);
  await expectRefused("link cleared");
  assert.equal((await setAssistant(app.baseUrl, f, "PUT")).status, 200);

  // The owner leaves the server (here: the peer's server, so removal is allowed).
  const suffix = randomUUID().slice(0, 8);
  const host = await seedUser(`assistant-host-${suffix}@slock.test`, `assistant-host-${suffix}`);
  const hosted = await createServer("Hosted", `assistant-hosted-${suffix}`, host.id);
  await addMember(hosted.id, f.owner.id);
  const hostedAssistant = await createAgent(hosted.id, `hosted-${suffix}`, { runtime: "codex", creatorType: "user", creatorId: f.owner.id });
  const hostedKey = (await mintAgentCredential({ agentId: hostedAssistant.id, scopes: ["read"], name: "hosted", createdByUserId: null })).apiKey;
  const ownerToken = await tokenForHuman(f.owner.email);
  const link = await fetch(`${app.baseUrl}/api/agents/${hostedAssistant.id}/assistant-owner`, { method: "PUT", headers: headers(ownerToken, hosted.id) });
  assert.equal(link.status, 200);
  assert.equal((await agentGet(app.baseUrl, hostedKey, "/assistant/owner-inbox")).status, 200);
  await removeMember(hosted.id, f.owner.id);
  const afterRemoval = await agentGet(app.baseUrl, hostedKey, "/assistant/owner-inbox");
  assert.equal(afterRemoval.status, 403);
  assert.equal(afterRemoval.body.code, "assistant_not_enabled");
});

async function agentSend(baseUrl: string, apiKey: string, target: string) {
  const res = await fetch(`${baseUrl}/internal/agent-api/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ target, content: `to ${target}` }),
  });
  return { status: res.status, body: await res.text() };
}

test("an assistant is only in its DM with its owner: link, add, DM and send are all held to it", async ({ app }) => {
  const f = await seedFixture();
  await enableBorrowing();

  // Linking refuses an agent that is still in another channel.
  await addAgent(f.room.id, f.assistant.id);
  const busy = await setAssistant(app.baseUrl, f, "PUT");
  assert.equal(busy.status, 409);
  assert.equal(busy.body.code, "assistant_has_channels");
  await removeAgent(f.room.id, f.assistant.id);
  assert.equal((await setAssistant(app.baseUrl, f, "PUT")).status, 200);

  // Nobody can add it to a channel afterwards.
  const ownerToken = await tokenForHuman(f.owner.email);
  const add = await fetch(`${app.baseUrl}/api/channels/${f.room.id}/members`, {
    method: "POST",
    headers: headers(ownerToken, f.server.id),
    body: JSON.stringify({ agentId: f.assistant.id }),
  });
  assert.equal(add.status, 403);
  assert.equal((await add.json() as { code?: string }).code, "assistant_channel_forbidden");
  await assert.rejects(addAgent(f.room.id, f.assistant.id), /only be in its DM with its owner/);

  // Only the owner gets a DM with it; other people and agents get none.
  assert.equal(await findOrCreateDM(f.server.id, f.peer.id, f.assistant.id), null);
  const other = await createAgent(f.server.id, `other-${randomUUID().slice(0, 8)}`, { runtime: "codex" });
  assert.equal(await findOrCreateAgentDM(f.server.id, other.id, f.assistant.id), null);

  // It posts only in the owner DM (and its threads): not a channel, not #all, not a DM with anyone else.
  const sendKey = (await mintAgentCredential({ agentId: f.assistant.id, scopes: ["send", "read"], name: "assistant-send", createdByUserId: null })).apiKey;
  assert.equal((await agentSend(app.baseUrl, sendKey, `dm:@${f.owner.name}`)).status, 200);
  assert.notEqual((await agentSend(app.baseUrl, sendKey, `dm:@${f.peer.name}`)).status, 200);
  assert.notEqual((await agentSend(app.baseUrl, sendKey, `#${f.room.name}`)).status, 200);
  const all = await getSystemAllChannel(f.server.id);
  assert.ok(all, "fixture: the server has #all");
  assert.equal(await canAgentPostToChannel(all.id, f.assistant.id), false, "#all is closed to assistants");
  assert.equal(await canAgentPostToChannel(all.id, other.id), true, "...and only to assistants");

  // The deferred trigger is the backstop for any other insert path.
  await assert.rejects(
    getDb().insert(channelAgents).values({ channelId: f.room.id, agentId: f.assistant.id }),
    (err: unknown) => /only be in its DM with its owner/.test(String((err as { cause?: { message?: string } }).cause?.message ?? err)),
  );
});
