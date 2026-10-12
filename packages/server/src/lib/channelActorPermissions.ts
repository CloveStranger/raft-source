import { withChannelWriterFence } from "../services/channelConversionFenceService";
import {
  canAddChannelMembers,
  channelSupportsRoles,
  getChannelAdminBasis,
  hasEffectiveChannelCapability,
  type ChannelAdminBasis,
  type ChannelActorAdmissionClass,
  type ChannelRole,
  type ServerCapability,
  type ServerRole,
} from "@botiverse/raft-shared";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { channelAgents, channelHumans, channels } from "../db/schema";
import { resolveActorContext, type ActorContextType } from "./actorPermissions";

export interface ChannelActorContext {
  actorType: ActorContextType;
  actorId: string;
  serverId: string;
  channelId: string;
  channelType: string;
  channelName: string;
  channelArchivedAt: Date | null;
  channelDeletedAt: Date | null;
  serverRole: ServerRole | null;
  channelRole: ChannelRole | null;
  channelAuthorityRevision: number | null;
  isChannelMember: boolean;
  canAccessChannel: boolean;
  supportsChannelRoles: boolean;
  admissionClass: ChannelActorAdmissionClass;
  channelAdminBasis: ChannelAdminBasis;
}

export async function resolveChannelActorContext(
  serverId: string,
  channelId: string,
  actorType: ActorContextType,
  actorId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<ChannelActorContext | null> {
  const contexts = await resolveChannelActorContextsMany(serverId, [channelId], actorType, actorId, executor);
  return contexts.get(channelId) ?? null;
}

/**
 * resolveChannelActorContext for many channels of one server in three queries
 * (the channels, the actor's server role, the actor's memberships), whatever
 * the number of channels. The single entry point of the rule: a channel list
 * resolved each channel on its own under Promise.all, three queries apiece, and
 * one request borrowed up to 381 pool connections (prod 2026-10-06). Channels
 * that do not resolve (missing, another server, or no server role) are absent.
 */
export async function resolveChannelActorContextsMany(
  serverId: string,
  channelIds: readonly string[],
  actorType: ActorContextType,
  actorId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<Map<string, ChannelActorContext>> {
  const contexts = new Map<string, ChannelActorContext>();
  const ids = [...new Set(channelIds)];
  if (ids.length === 0) return contexts;
  const db = executor;
  const channelRows = await db.select({
    id: channels.id,
    serverId: channels.serverId,
    name: channels.name,
    type: channels.type,
    archivedAt: channels.archivedAt,
    deletedAt: channels.deletedAt,
  }).from(channels).where(and(inArray(channels.id, ids), eq(channels.serverId, serverId)));
  if (channelRows.length === 0) return contexts;
  const actor = await resolveActorContext(serverId, actorType, actorId, executor);
  if (!actor.serverRole) return contexts;

  const foundIds = channelRows.map((channel) => channel.id);
  const memberships = actorType === "agent"
    ? await db.select({ channelId: channelAgents.channelId, role: channelAgents.role, authorityRevision: channelAgents.authorityRevision })
      .from(channelAgents)
      .where(and(inArray(channelAgents.channelId, foundIds), eq(channelAgents.agentId, actorId)))
    : await db.select({ channelId: channelHumans.channelId, role: channelHumans.role, authorityRevision: channelHumans.authorityRevision })
      .from(channelHumans)
      .where(and(inArray(channelHumans.channelId, foundIds), eq(channelHumans.userId, actorId)));
  const membershipByChannel = new Map(memberships.map((membership) => [membership.channelId, membership]));

  for (const channel of channelRows) {
    const membership = membershipByChannel.get(channel.id);
    const isChannelMember = Boolean(membership);
    const supportsChannelRoles = channelSupportsRoles(channel.type, channel.name);
    const canAccessChannel = channel.type === "channel"
      ? true
      : channel.type === "private" || channel.type === "joint"
        ? isChannelMember
        : false;
    const channelRole = (membership?.role ?? null) as ChannelRole | null;

    contexts.set(channel.id, {
      actorType,
      actorId,
      serverId,
      channelId: channel.id,
      channelType: channel.type,
      channelName: channel.name,
      channelArchivedAt: channel.archivedAt,
      channelDeletedAt: channel.deletedAt,
      serverRole: actor.serverRole,
      channelRole,
      channelAuthorityRevision: membership?.authorityRevision ?? null,
      isChannelMember,
      canAccessChannel,
      supportsChannelRoles,
      admissionClass: actor.serverRole === "guest" ? "guest" : "current_member",
      channelAdminBasis: getChannelAdminBasis({
        serverRole: actor.serverRole,
        channelRole,
        isChannelMember,
        supportsChannelRoles,
      }),
    });
  }
  return contexts;
}

export function channelActorHasCapability(
  context: ChannelActorContext,
  capability: ServerCapability,
): boolean {
  if (capability === "addChannelMembers") {
    return canAddChannelMembers({
      serverRole: context.serverRole,
      admissionClass: context.admissionClass,
      isChannelMember: context.isChannelMember,
      channelType: context.channelType,
      channelName: context.channelName,
      archived: context.channelArchivedAt !== null,
      deleted: context.channelDeletedAt !== null,
    });
  }
  return context.canAccessChannel && hasEffectiveChannelCapability({
    serverRole: context.serverRole,
    channelRole: context.channelRole,
    isChannelMember: context.isChannelMember,
    supportsChannelRoles: context.supportsChannelRoles,
    capability,
    channelType: context.channelType,
  });
}

export async function actorHasChannelCapability(
  serverId: string,
  channelId: string,
  actorType: ActorContextType,
  actorId: string,
  capability: ServerCapability,
  executor: DatabaseExecutor = getDb(),
): Promise<boolean> {
  const context = await resolveChannelActorContext(
    serverId,
    channelId,
    actorType,
    actorId,
    executor,
  );
  return context ? channelActorHasCapability(context, capability) : false;
}

export async function withLockedChannelActorCapability<T>(
  input: {
    serverId: string;
    channelId: string;
    actorType: ActorContextType;
    actorId: string;
    capability: ServerCapability;
  },
  callback: (executor: DatabaseExecutor, context: ChannelActorContext) => Promise<T>,
): Promise<T> {
  return withLockedChannelActorCapabilities({
    ...input,
    capabilities: [input.capability],
  }, callback);
}

export async function withLockedChannelActorCapabilities<T>(
  input: {
    serverId: string;
    channelId: string;
    actorType: ActorContextType;
    actorId: string;
    capabilities: readonly ServerCapability[];
  },
  callback: (executor: DatabaseExecutor, context: ChannelActorContext) => Promise<T>,
): Promise<T> {
  return withChannelWriterFence(input.channelId, async (tx) => {
    const [lockedChannel] = await tx.select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.id, input.channelId), eq(channels.serverId, input.serverId)))
      .for("update")
      .limit(1);
    if (!lockedChannel) throw new Error("Channel not found");

    const context = await resolveChannelActorContext(
      input.serverId,
      input.channelId,
      input.actorType,
      input.actorId,
      tx,
    );
    if (!context || !input.capabilities.every((capability) => channelActorHasCapability(context, capability))) {
      throw new Error("Channel capability required");
    }
    return callback(tx, context);
  });
}
