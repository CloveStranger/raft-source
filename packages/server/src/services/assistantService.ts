/**
 * RFC 074 §2 personal assistant (v0): an agent whose
 * `agents.assistant_owner_user_id` names a person may read what that person
 * can see, minus DMs, through the assistant-only Agent API reads. The
 * assistant always calls with its own credential; the owner's identity is
 * applied here, on the server, and nowhere else.
 *
 * Every read re-checks the whole chain (`resolveAssistantOwner`): the flag is
 * on for the server, the agent is live and still this person's assistant, and
 * the person is still a member of the server. Nothing is cached, so clearing
 * the link, removing the owner, or turning the flag off takes effect on the
 * next request.
 */
import { createHash } from "node:crypto";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agents, assistantDoorbells, channelAgents, channelHumans, channels, messages, thirdPartyAgentEvents } from "../db/schema";
import type { AgentOrchestrator } from "./agentOrchestrator";
import { SYSTEM_ASSISTANT_APP } from "./agentAppEventsService";
import type { InboxNotificationFactInput } from "./inboxNotificationService";
import {
  buildThirdPartyAgentMessage,
  claimQueuedThirdPartyAgentEventForDelivery,
  getAgentInboundOAuthResource,
  releaseThirdPartyAgentEventDeliveryClaim,
} from "./oauthService";
import { recordTraceEvent } from "../tracing/semanticTrace";
import * as channelService from "./channelService";
import { getActorServerRoleInServer } from "../lib/actorPermissions";
import { evaluateFeatureFlag, IDENTITY_BORROWING_FEATURE_FLAG_KEY } from "./featureFlagService";

export const ASSISTANT_NOT_ENABLED_CODE = "assistant_not_enabled";

export async function isIdentityBorrowingEnabled(serverId: string): Promise<boolean> {
  try {
    const evaluation = await evaluateFeatureFlag({ key: IDENTITY_BORROWING_FEATURE_FLAG_KEY, serverId });
    return evaluation.enabled;
  } catch {
    // Fail closed: an evaluation failure must never open a borrowed read.
    return false;
  }
}

/** The configured owner, or null. Says nothing about whether reads are allowed. */
export async function getAssistantOwnerUserId(
  agentId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<string | null> {
  const [row] = await executor
    .select({ ownerUserId: agents.assistantOwnerUserId })
    .from(agents)
    .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
    .limit(1);
  return row?.ownerUserId ?? null;
}

/**
 * The person this agent may currently read as, or null when any link of the
 * chain is missing. Callers answer every null the same way
 * (`403 assistant_not_enabled`) so the reason is not observable.
 */
export async function resolveAssistantOwner(agentId: string, serverId: string): Promise<string | null> {
  if (!await isIdentityBorrowingEnabled(serverId)) return null;
  const [row] = await getDb()
    .select({ ownerUserId: agents.assistantOwnerUserId })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.serverId, serverId), isNull(agents.deletedAt)))
    .limit(1);
  const ownerUserId = row?.ownerUserId ?? null;
  if (!ownerUserId) return null;
  const ownerRole = await getActorServerRoleInServer(serverId, "user", ownerUserId);
  return ownerRole ? ownerUserId : null;
}

/**
 * True for a DM or a thread under a DM: the conversations an assistant never
 * reads (RFC 074 `excl = ['dm']`). A thread whose parent cannot be resolved
 * counts as a DM, so an unknown shape fails closed.
 */
export async function isDmScopedChannel(channel: { type: string; parentMessageId: string | null }): Promise<boolean> {
  if (channel.type === "dm") return true;
  if (channel.type !== "thread") return false;
  if (!channel.parentMessageId) return true;
  const [parent] = await getDb()
    .select({ channelId: messages.channelId })
    .from(messages)
    .where(eq(messages.id, channel.parentMessageId))
    .limit(1);
  if (!parent) return true;
  const parentChannel = await channelService.getChannel(parent.channelId);
  return !parentChannel || parentChannel.type === "dm";
}

export type SetAssistantOwnerResult =
  | { ok: true; agentId: string; ownerUserId: string }
  | { ok: false; reason: "not_found" | "not_creator" | "not_enabled" | "owner_has_assistant" }
  | { ok: false; reason: "has_channels"; channelCount: number };

/**
 * Make `agentId` the caller's assistant. Only the person being borrowed from
 * can grant it (RFC 074 §5.1: a server admin cannot grant on someone's
 * behalf), and only on an agent that person created: otherwise whoever runs
 * the agent would read the person's content.
 */
export async function setAssistantOwner(input: {
  serverId: string;
  agentId: string;
  userId: string;
}): Promise<SetAssistantOwnerResult> {
  const db = getDb();
  const [agent] = await db
    .select({
      id: agents.id,
      creatorType: agents.creatorType,
      creatorId: agents.creatorId,
      ownerUserId: agents.assistantOwnerUserId,
    })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.serverId, input.serverId), isNull(agents.deletedAt)))
    .limit(1);
  if (!agent) return { ok: false, reason: "not_found" };
  if (agent.creatorType !== "user" || agent.creatorId !== input.userId) return { ok: false, reason: "not_creator" };
  if (!await isIdentityBorrowingEnabled(input.serverId)) return { ok: false, reason: "not_enabled" };
  if (agent.ownerUserId === input.userId) return { ok: true, agentId: agent.id, ownerUserId: input.userId };
  // An assistant lives only in its DM with its owner (RFC 074 §2): refuse while
  // it is still in any other channel or DM, rather than silently removing it.
  const otherChannels = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count
    FROM ${channelAgents} ca
    JOIN ${channels} c ON c.id = ca.channel_id
    WHERE ca.agent_id = ${agent.id}
      AND c.deleted_at IS NULL
      AND NOT (
        c.type = 'dm'
        AND EXISTS (SELECT 1 FROM ${channelHumans} h WHERE h.channel_id = c.id AND h.user_id = ${input.userId})
        AND NOT EXISTS (SELECT 1 FROM ${channelAgents} o WHERE o.channel_id = c.id AND o.agent_id <> ${agent.id})
      )`);
  const channelCount = Number(otherChannels.rows[0]?.count ?? 0);
  if (channelCount > 0) return { ok: false, reason: "has_channels", channelCount };
  try {
    await db
      .update(agents)
      .set({ assistantOwnerUserId: input.userId, updatedAt: new Date() })
      .where(and(eq(agents.id, agent.id), isNull(agents.deletedAt)));
  } catch (err) {
    if (isUniqueViolation(err, "idx_agents_server_assistant_owner")) {
      return { ok: false, reason: "owner_has_assistant" };
    }
    throw err;
  }
  return { ok: true, agentId: agent.id, ownerUserId: input.userId };
}

/**
 * Clear the link. Only the owner may clear it; the flag is not required, so
 * a person can always take their access back.
 */
export async function clearAssistantOwner(input: {
  serverId: string;
  agentId: string;
  userId: string;
}): Promise<{ ok: true } | { ok: false; reason: "not_found" | "not_owner" }> {
  const db = getDb();
  const [agent] = await db
    .select({ id: agents.id, ownerUserId: agents.assistantOwnerUserId })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.serverId, input.serverId), isNull(agents.deletedAt)))
    .limit(1);
  if (!agent) return { ok: false, reason: "not_found" };
  if (agent.ownerUserId === null) return { ok: true };
  if (agent.ownerUserId !== input.userId) return { ok: false, reason: "not_owner" };
  await db
    .update(agents)
    .set({ assistantOwnerUserId: null, updatedAt: new Date() })
    .where(and(eq(agents.id, agent.id), eq(agents.assistantOwnerUserId, input.userId)));
  return { ok: true };
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; constraint_name?: unknown; cause?: unknown };
    if (candidate.code === "23505" && (candidate.constraint === constraint || candidate.constraint_name === constraint)) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Doorbell (RFC 074 §2 item 3): "your owner's inbox has new activity".
//
// Producer: recordInboxNotificationFacts calls recordAssistantDoorbells inside
// the transaction that writes the owner's facts. It only INSERTs ... ON
// CONFLICT DO NOTHING into assistant_doorbells (one pending row per assistant;
// no lock on an existing row, so concurrent messages to the same owner do not
// queue behind each other). DMs and threads under DMs never ring, and neither
// do facts that are not unread for the owner (their own sends).
//
// Worker: the first change after a quiet period goes out at once; changes
// within ASSISTANT_DOORBELL_COALESCE_MS of the last doorbell go out together
// when that window closes. A send deletes the pending row and inserts a
// `system.assistant` event into third_party_agent_events in ONE transaction,
// then delivers it like an app event (inbox row + push). If that delivery
// fails, the row is still queued: the next /events pull rebuilds it and the
// push sweep announces it.
// ---------------------------------------------------------------------------

export const ASSISTANT_DOORBELL_COALESCE_MS = 30_000;
export const ASSISTANT_DOORBELL_TTL_MS = 60 * 60 * 1000;
const ASSISTANT_DOORBELL_POLL_MS = 5_000;
const ASSISTANT_DOORBELL_KICK_DELAY_MS = 250;
const ASSISTANT_DOORBELL_BATCH = 100;

export async function recordAssistantDoorbells(
  facts: readonly InboxNotificationFactInput[],
  executor: DatabaseExecutor,
): Promise<number> {
  const keyed = new Map<string, { receiverId: string; serverId: string; sourceChannelId: string }>();
  for (const fact of facts) {
    if (fact.receiverType !== "user" || fact.unreadEligible === false || fact.kind === "dm") continue;
    keyed.set(`${fact.receiverId}:${fact.serverId}:${fact.sourceChannelId}`, fact);
  }
  if (keyed.size === 0) return 0;
  const rows = [...keyed.values()];
  const receiverIds = rows.map((row) => row.receiverId);
  const serverIds = rows.map((row) => row.serverId);
  const channelIds = rows.map((row) => row.sourceChannelId);
  // One statement whatever the fan-out (three array parameters). The join on
  // agents uses the partial unique (server_id, assistant_owner_user_id) index,
  // so a batch with no assistant owner costs one index probe per receiver.
  const result = await executor.execute(sql`
    INSERT INTO ${assistantDoorbells} (agent_id, server_id, owner_user_id)
    SELECT DISTINCT a.id, a.server_id, a.assistant_owner_user_id
    FROM unnest(${sql.param(receiverIds)}::uuid[], ${sql.param(serverIds)}::uuid[], ${sql.param(channelIds)}::uuid[]) AS f(receiver_id, server_id, channel_id)
    JOIN ${agents} a
      ON a.server_id = f.server_id
     AND a.assistant_owner_user_id = f.receiver_id
     AND a.deleted_at IS NULL
    JOIN ${channels} c ON c.id = f.channel_id
    LEFT JOIN ${channels} p ON p.id = c.parent_channel_id
    WHERE c.type <> 'dm'
      AND (c.type <> 'thread' OR (p.id IS NOT NULL AND p.type <> 'dm'))
    ON CONFLICT (agent_id) DO NOTHING
    RETURNING agent_id`);
  const inserted = result.rows.length;
  if (inserted > 0) kickAssistantDoorbellDrain();
  return inserted;
}

type DoorbellDeliverer = Pick<AgentOrchestrator, "deliverMessage">;

let doorbellDeliverer: DoorbellDeliverer | null = null;
let kickTimer: ReturnType<typeof setTimeout> | null = null;
let draining: Promise<number> | null = null;

/** Schedule a drain shortly after the producing transaction has likely committed. The poll is the floor. */
export function kickAssistantDoorbellDrain(): void {
  if (!doorbellDeliverer || kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    void runAssistantDoorbellDrain();
  }, ASSISTANT_DOORBELL_KICK_DELAY_MS);
  kickTimer.unref?.();
}

function runAssistantDoorbellDrain(): Promise<number> {
  if (!doorbellDeliverer) return Promise.resolve(0);
  if (draining) return draining;
  const deliverer = doorbellDeliverer;
  draining = drainAssistantDoorbells({ deliverer })
    .catch((err) => {
      console.error("[AssistantDoorbell] drain failed", err);
      return 0;
    })
    .finally(() => { draining = null; });
  return draining;
}

export function startAssistantDoorbellWorker(input: { agentOrchestrator: DoorbellDeliverer }): { stop(): void } {
  doorbellDeliverer = input.agentOrchestrator;
  const interval = setInterval(() => { void runAssistantDoorbellDrain(); }, ASSISTANT_DOORBELL_POLL_MS);
  interval.unref?.();
  return {
    stop() {
      clearInterval(interval);
      if (kickTimer) clearTimeout(kickTimer);
      kickTimer = null;
      doorbellDeliverer = null;
    },
  };
}

/**
 * Send every pending doorbell whose window is open. Returns how many were
 * sent. Pending rows of an assistant that is no longer effective (flag off,
 * link cleared, owner gone) are dropped without a send.
 */
export async function drainAssistantDoorbells(input: { deliverer: DoorbellDeliverer; now?: Date }): Promise<number> {
  const db = getDb();
  const now = input.now ?? new Date();
  const pending = await db
    .select()
    .from(assistantDoorbells)
    .orderBy(asc(assistantDoorbells.firstChangeAt))
    .limit(ASSISTANT_DOORBELL_BATCH);
  let sent = 0;
  for (const row of pending) {
    if (await resolveAssistantOwner(row.agentId, row.serverId) !== row.ownerUserId) {
      await db.delete(assistantDoorbells).where(and(
        eq(assistantDoorbells.agentId, row.agentId),
        eq(assistantDoorbells.firstChangeAt, row.firstChangeAt),
      ));
      continue;
    }
    const [last] = await db
      .select({ createdAt: thirdPartyAgentEvents.createdAt })
      .from(thirdPartyAgentEvents)
      .where(and(
        eq(thirdPartyAgentEvents.agentId, row.agentId),
        eq(thirdPartyAgentEvents.systemApp, SYSTEM_ASSISTANT_APP),
      ))
      .orderBy(desc(thirdPartyAgentEvents.createdAt))
      .limit(1);
    if (last && now.getTime() - last.createdAt.getTime() < ASSISTANT_DOORBELL_COALESCE_MS) continue;

    const event = await db.transaction(async (tx) => {
      const [claimed] = await tx
        .delete(assistantDoorbells)
        .where(eq(assistantDoorbells.agentId, row.agentId))
        .returning();
      // Another replica sent it first.
      if (!claimed) return null;
      const payload = {
        type: "owner_inbox_updated",
        owner_user_id: claimed.ownerUserId,
        first_change_at: claimed.firstChangeAt.toISOString(),
        last_change_at: now.toISOString(),
      };
      const [created] = await tx.insert(thirdPartyAgentEvents).values({
        serverId: claimed.serverId,
        agentId: claimed.agentId,
        clientId: null,
        systemApp: SYSTEM_ASSISTANT_APP,
        kind: "event",
        summary: "Your owner's inbox has new activity (DMs not included). List it with the assistant owner inbox.",
        payload,
        payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
        resource: getAgentInboundOAuthResource(claimed.serverId),
        status: "queued",
        expiresAt: new Date(now.getTime() + ASSISTANT_DOORBELL_TTL_MS),
        createdAt: now,
        updatedAt: now,
      }).returning();
      return created ?? null;
    });
    if (!event) continue;
    sent += 1;
    recordTraceEvent("server.assistant.doorbell.sent", {
      agent_id: event.agentId,
      subject_user_id: row.ownerUserId,
      event_id: event.id,
      pending_ms: now.getTime() - row.firstChangeAt.getTime(),
    });
    if (!await claimQueuedThirdPartyAgentEventForDelivery(event.id)) continue;
    try {
      await input.deliverer.deliverMessage(event.agentId, buildThirdPartyAgentMessage({
        event,
        clientKey: SYSTEM_ASSISTANT_APP,
        clientName: SYSTEM_ASSISTANT_APP,
      }));
    } catch (err) {
      // Still queued in the table: the next /events pull rebuilds it and the
      // push sweep announces it.
      await releaseThirdPartyAgentEventDeliveryClaim(event.id);
      console.error("[AssistantDoorbell] delivery failed; left queued", err);
    }
  }
  return sent;
}

/** Test seam: run one drain with the given deliverer, as the worker would. */
export function __setAssistantDoorbellDelivererForTests(deliverer: DoorbellDeliverer | null): void {
  doorbellDeliverer = deliverer;
}
