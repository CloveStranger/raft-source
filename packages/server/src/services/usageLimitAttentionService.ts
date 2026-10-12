import {
  SERVER_SYSTEM_ATTENTION_CONTRACT_VERSION,
  USAGE_LIMIT_ATTENTION_FEATURE_FLAG_KEY,
  type RuntimeAccountUsageProvider,
  type RuntimeAccountUsageSnapshot,
  type ServerSystemAttentionResponse,
} from "@botiverse/raft-shared";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { getDb, type DatabaseExecutor } from "../db/index";
import {
  agents,
  machines,
  serverMembers,
  systemAttentionIncidents,
  systemAttentionReceipts,
} from "../db/schema";
import { evaluateFeatureFlag } from "./featureFlagService";

export function runtimeProviderForAgentRuntime(runtime: string): RuntimeAccountUsageProvider | null {
  if (runtime === "kimi-sdk") return "kimi";
  return runtime === "claude" || runtime === "codex" || runtime === "kimi" || runtime === "grok"
    ? runtime
    : null;
}

export type UsageLimitTransition =
  | { action: "ignore" }
  | { action: "activate"; generation: number }
  | { action: "update_active" }
  | { action: "resolve" };

export function planUsageLimitTransition(input: {
  latest: { state: "active" | "resolved"; activationGeneration: number; lastObservedAt: Date } | null;
  observedAt: Date;
  windowStatus: "ok" | "limit_reached" | "parse_unavailable";
}): UsageLimitTransition {
  if (input.windowStatus === "parse_unavailable") return { action: "ignore" };
  if (input.latest && input.observedAt.getTime() <= input.latest.lastObservedAt.getTime()) {
    return { action: "ignore" };
  }
  if (input.windowStatus === "limit_reached") {
    return input.latest?.state === "active"
      ? { action: "update_active" }
      : { action: "activate", generation: (input.latest?.activationGeneration ?? 0) + 1 };
  }
  return input.latest?.state === "active" ? { action: "resolve" } : { action: "ignore" };
}

function identityLockKey(input: {
  serverId: string;
  machineId: string;
  provider: RuntimeAccountUsageProvider;
  accountKeyHash: string;
  windowKey: string;
}): string {
  return [
    "usage-limit-attention-v1",
    input.serverId,
    input.machineId,
    input.provider,
    input.accountKeyHash,
    input.windowKey,
  ].join(":");
}

export class UsageLimitAttentionService {
  async ingest(
    machineId: string,
    snapshot: RuntimeAccountUsageSnapshot,
    executor: DatabaseExecutor = getDb(),
  ): Promise<void> {
    const [machine] = await executor
      .select({ serverId: machines.serverId })
      .from(machines)
      .where(eq(machines.id, machineId));
    if (!machine) return;

    const gate = await evaluateFeatureFlag({
      key: USAGE_LIMIT_ATTENTION_FEATURE_FLAG_KEY,
      serverId: machine.serverId,
    }, executor);
    if (!gate.enabled) return;

    const machineAgents = await executor
      .select({ id: agents.id, runtime: agents.runtime })
      .from(agents)
      .where(and(eq(agents.serverId, machine.serverId), eq(agents.machineId, machineId), isNull(agents.deletedAt)));
    const affectedAgentIds = machineAgents
      .filter((agent) => runtimeProviderForAgentRuntime(agent.runtime) === snapshot.provider)
      .map((agent) => agent.id)
      .sort();

    const observedAt = new Date(snapshot.collectedAt);
    for (const account of snapshot.accounts) {
      for (const window of account.windows) {
        if (window.status === "parse_unavailable") continue;
        if (window.status === "limit_reached" && affectedAgentIds.length === 0) continue;
        await executor.transaction(async (tx) => {
          const identity = {
            serverId: machine.serverId,
            machineId,
            provider: snapshot.provider,
            accountKeyHash: account.accountKey,
            windowKey: window.id,
          };
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${identityLockKey(identity)}, 0))`);
          const [latest] = await tx
            .select()
            .from(systemAttentionIncidents)
            .where(and(
              eq(systemAttentionIncidents.serverId, identity.serverId),
              eq(systemAttentionIncidents.machineId, identity.machineId),
              eq(systemAttentionIncidents.kind, "usage_limit_reached"),
              eq(systemAttentionIncidents.provider, identity.provider),
              eq(systemAttentionIncidents.accountKeyHash, identity.accountKeyHash),
              eq(systemAttentionIncidents.windowKey, identity.windowKey),
            ))
            .orderBy(desc(systemAttentionIncidents.activationGeneration))
            .limit(1);

          const transition = planUsageLimitTransition({ latest: latest ?? null, observedAt, windowStatus: window.status });
          if (transition.action === "ignore") return;

          if (transition.action === "update_active" || transition.action === "activate") {
            const resetsAt = window.resetsAt ? new Date(window.resetsAt) : null;
            if (transition.action === "update_active") {
              await tx.update(systemAttentionIncidents).set({
                affectedAgentIds,
                lastObservedAt: observedAt,
                resetsAt,
                updatedAt: new Date(),
              }).where(eq(systemAttentionIncidents.id, latest.id));
              return;
            }
            await tx.insert(systemAttentionIncidents).values({
              ...identity,
              kind: "usage_limit_reached",
              activationGeneration: transition.generation,
              affectedAgentIds,
              activatedAt: observedAt,
              lastObservedAt: observedAt,
              resetsAt,
            });
            return;
          }

          if (transition.action === "resolve" && latest?.state === "active") {
            await tx.update(systemAttentionIncidents).set({
              state: "resolved",
              resolvedAt: observedAt,
              lastObservedAt: observedAt,
              updatedAt: new Date(),
            }).where(eq(systemAttentionIncidents.id, latest.id));
          }
        });
      }
    }
  }

  async listForReceiver(
    serverId: string,
    userId: string,
    executor: DatabaseExecutor = getDb(),
  ): Promise<ServerSystemAttentionResponse> {
    const generatedAt = new Date();
    const [membership] = await executor
      .select({ role: serverMembers.role })
      .from(serverMembers)
      .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
    if (membership?.role !== "owner" && membership?.role !== "admin") {
      return this.emptyResponse(generatedAt);
    }
    const gate = await evaluateFeatureFlag({
      key: USAGE_LIMIT_ATTENTION_FEATURE_FLAG_KEY,
      serverId,
      userId,
      platform: "web",
    }, executor);
    if (!gate.enabled) return this.emptyResponse(generatedAt);

    const rows = await executor
      .select({
        incident: systemAttentionIncidents,
        machineName: machines.name,
        seenAt: systemAttentionReceipts.seenAt,
        dismissedAt: systemAttentionReceipts.dismissedAt,
      })
      .from(systemAttentionIncidents)
      .innerJoin(machines, eq(machines.id, systemAttentionIncidents.machineId))
      .leftJoin(systemAttentionReceipts, and(
        eq(systemAttentionReceipts.incidentId, systemAttentionIncidents.id),
        eq(systemAttentionReceipts.userId, userId),
      ))
      .where(and(
        eq(systemAttentionIncidents.serverId, serverId),
        eq(systemAttentionIncidents.state, "active"),
        isNull(systemAttentionReceipts.dismissedAt),
      ))
      .orderBy(desc(systemAttentionIncidents.activatedAt));

    const notifications = rows.map(({ incident, machineName, seenAt }) => ({
      id: incident.id,
      kind: "usage_limit_reached" as const,
      severity: "warning" as const,
      state: "active" as const,
      activatedAt: incident.activatedAt.toISOString(),
      lastObservedAt: incident.lastObservedAt.toISOString(),
      seenAt: seenAt?.toISOString() ?? null,
      machine: { id: incident.machineId, name: machineName },
      provider: incident.provider,
      windowKey: incident.windowKey,
      resetsAt: incident.resetsAt?.toISOString() ?? null,
      affectedAgentIds: incident.affectedAgentIds,
    }));
    return {
      contractVersion: SERVER_SYSTEM_ATTENTION_CONTRACT_VERSION,
      generatedAt: generatedAt.toISOString(),
      snapshotMode: "replace",
      unseenCount: notifications.filter((notification) => notification.seenAt === null).length,
      notifications,
    };
  }

  async markSeen(serverId: string, userId: string, incidentId: string, executor: DatabaseExecutor = getDb()): Promise<boolean> {
    return this.writeReceipt(serverId, userId, incidentId, "seen", executor);
  }

  async dismiss(serverId: string, userId: string, incidentId: string, executor: DatabaseExecutor = getDb()): Promise<boolean> {
    return this.writeReceipt(serverId, userId, incidentId, "dismiss", executor);
  }

  private async writeReceipt(
    serverId: string,
    userId: string,
    incidentId: string,
    action: "seen" | "dismiss",
    executor: DatabaseExecutor,
  ): Promise<boolean> {
    const [membership] = await executor
      .select({ role: serverMembers.role })
      .from(serverMembers)
      .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
    if (membership?.role !== "owner" && membership?.role !== "admin") return false;
    const gate = await evaluateFeatureFlag({
      key: USAGE_LIMIT_ATTENTION_FEATURE_FLAG_KEY,
      serverId,
      userId,
      platform: "web",
    }, executor);
    if (!gate.enabled) return false;
    const [incident] = await executor.select({ id: systemAttentionIncidents.id })
      .from(systemAttentionIncidents)
      .where(and(
        eq(systemAttentionIncidents.id, incidentId),
        eq(systemAttentionIncidents.serverId, serverId),
        eq(systemAttentionIncidents.state, "active"),
      ));
    if (!incident) return false;
    const now = new Date();
    await executor.insert(systemAttentionReceipts).values({
      incidentId,
      userId,
      seenAt: now,
      dismissedAt: action === "dismiss" ? now : null,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [systemAttentionReceipts.incidentId, systemAttentionReceipts.userId],
      set: action === "dismiss"
        ? { seenAt: sql`COALESCE(${systemAttentionReceipts.seenAt}, ${now})`, dismissedAt: now, updatedAt: now }
        : { seenAt: sql`COALESCE(${systemAttentionReceipts.seenAt}, ${now})`, updatedAt: now },
    });
    return true;
  }

  private emptyResponse(generatedAt: Date): ServerSystemAttentionResponse {
    return {
      contractVersion: SERVER_SYSTEM_ATTENTION_CONTRACT_VERSION,
      generatedAt: generatedAt.toISOString(),
      snapshotMode: "replace",
      unseenCount: 0,
      notifications: [],
    };
  }
}

export const usageLimitAttentionService = new UsageLimitAttentionService();
