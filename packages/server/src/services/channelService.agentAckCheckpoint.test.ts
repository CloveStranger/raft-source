import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { agentChannelReadCursors, agents, channelAgents, channels, servers, users } from "../db/schema";
import { getDb } from "../db/index";
import { createMessage } from "./messageService";
import { getAgentLegacyReadCursor, markAgentLegacyAckCheckpoint } from "./channelService";

type PgliteLike = { query: (...args: unknown[]) => Promise<unknown> };

test("the legacy ack checkpoint writes every acked conversation's cursor in one statement, forward only", async ({ db }) => {
  const [owner] = await db.insert(users).values({ email: "ack-checkpoint@test.com", name: "AckOwner", passwordHash: "x", emailVerified: true }).returning();
  const [server] = await db.insert(servers).values({ name: "Ack Checkpoint", slug: "ack-checkpoint", ownerId: owner.id }).returning();
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: "ack-agent", status: "active" }).returning();
  const rooms = await db.insert(channels).values(Array.from({ length: 6 }, (_, i) => ({
    serverId: server.id, name: `ack-room-${i}`, type: "channel" as const,
  }))).returning();
  await db.insert(channelAgents).values(rooms.map((room) => ({ channelId: room.id, agentId: agent.id })));
  const [outsider] = await db.insert(channels).values({ serverId: server.id, name: "ack-outsider", type: "channel" }).returning();

  const seqs: number[] = [];
  const lastSeq = new Map<string, number>();
  for (const room of [...rooms, outsider]) {
    for (let i = 0; i < 2; i += 1) {
      const message = await createMessage(room.id, "user", owner.id, `ack ${room.name} ${i}`);
      seqs.push(message.seq);
      lastSeq.set(room.id, message.seq);
    }
  }
  // A cursor already past the acked seqs stays where it is.
  const ahead = lastSeq.get(rooms[0].id)! + 1000;
  await db.insert(agentChannelReadCursors).values({ agentId: agent.id, channelId: rooms[0].id, lastReadSeq: ahead });

  const pg = (getDb() as unknown as { $client: PgliteLike }).$client;
  const originalQuery = pg.query.bind(pg);
  let cursorWrites = 0;
  pg.query = ((...args: unknown[]) => {
    if (typeof args[0] === "string" && /agent_channel_read_cursors/.test(args[0]) && /^\s*(insert|update)/i.test(args[0])) cursorWrites += 1;
    return originalQuery(...args);
  }) as PgliteLike["query"];
  try {
    await markAgentLegacyAckCheckpoint(agent.id, seqs);
  } finally {
    pg.query = originalQuery;
  }

  assert.equal(cursorWrites, 1, "one write for all conversations, not one or two per conversation");
  assert.equal(await getAgentLegacyReadCursor(agent.id, rooms[0].id), ahead);
  for (const room of rooms.slice(1)) assert.equal(await getAgentLegacyReadCursor(agent.id, room.id), lastSeq.get(room.id), room.name);
  assert.equal(await getAgentLegacyReadCursor(agent.id, outsider.id), 0, "not a member: not written");
});
