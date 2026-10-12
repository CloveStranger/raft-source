import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { currentDate, type AppAgentJwtSettings } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { oauthClients, oauthClientInstalls, serverMembers } from "../db/schema";
import { actorRoleHasServerCapability } from "../lib/actorPermissions";
import { oauthClientIsUserManagedPredicate } from "./oauthClientManagementPolicy";
import { recordIntegrationAuditEvent } from "./integrationAuditService";

export type AgentJwtDenialReason = "policy_off" | "invalid_legacy_policy" | "agent_unavailable" | "membership_missing" | "app_unavailable" | "installation_unavailable" | "installation_unapproved" | "grant_revoked";
export class AgentAudienceJwtError extends Error {
  constructor(readonly code: "AGENT_JWT_DISABLED" | "AGENT_JWT_NOT_AUTHORIZED" | "AGENT_JWT_CONFIGURATION_INVALID", readonly reason: AgentJwtDenialReason = code === "AGENT_JWT_CONFIGURATION_INVALID" ? "invalid_legacy_policy" : code === "AGENT_JWT_DISABLED" ? "policy_off" : "app_unavailable") {
    super(code);
  }
}
export class AgentJwtPolicyError extends Error {
  constructor(readonly status: 400 | 403 | 404, message: string) { super(message); }
}

const legacyPolicySchema = z.array(z.object({
  serverId: z.string().uuid(),
  clientId: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
}).strict()).max(100);

// Compatibility only for rows that existed before this field was introduced.
// Explicit App decisions never parse or inherit the old operator configuration.
export function appSupportsAgentJwt(client: {
  agentJwtEnabled: boolean | null;
  appType: string;
  serverId: string;
  clientId: string;
}): boolean {
  if (client.agentJwtEnabled !== null) return client.agentJwtEnabled;
  if (client.appType !== "server_local") return false;
  const raw = process.env.RAFT_AGENT_JWT_AUDIENCES?.trim();
  if (!raw) return false;
  const parsed = legacyPolicySchema.safeParse((() => {
    try { return JSON.parse(raw); } catch { return null; }
  })());
  if (!parsed.success) throw new AgentAudienceJwtError("AGENT_JWT_CONFIGURATION_INVALID");
  return parsed.data.some((pair) => pair.serverId === client.serverId && pair.clientId === client.clientId);
}

async function readPolicyRows(db: DatabaseExecutor, serverId: string, clientId: string, lock: boolean) {
  const clientQuery = db.select({
    id: oauthClients.id, serverId: oauthClients.serverId, clientId: oauthClients.clientId,
    appType: oauthClients.appType, enabled: oauthClients.enabled,
    allowedScopes: oauthClients.allowedScopes, agentJwtEnabled: oauthClients.agentJwtEnabled,
  }).from(oauthClients).where(and(eq(oauthClients.id, clientId), oauthClientIsUserManagedPredicate()));
  const [client] = lock ? await clientQuery.for("update") : await clientQuery;
  if (!client) throw new AgentJwtPolicyError(404, "App not found on this Server");
  const installQuery = db.select({ id: oauthClientInstalls.id, status: oauthClientInstalls.status, agentJwtEnabled: oauthClientInstalls.agentJwtEnabled })
    .from(oauthClientInstalls).where(and(eq(oauthClientInstalls.clientId, client.id), eq(oauthClientInstalls.serverId, serverId)));
  const [installation] = lock ? await installQuery.for("update") : await installQuery;
  const source = client.serverId === serverId;
  if (!source && (client.appType !== "third_party_global" || !installation)) {
    throw new AgentJwtPolicyError(404, "App not found on this Server");
  }
  return { client, installation, source };
}

function projectSettings({ client, installation, source }: Awaited<ReturnType<typeof readPolicyRows>>): AppAgentJwtSettings {
  const appEnabled = appSupportsAgentJwt(client);
  const enabled = source ? appEnabled : installation?.agentJwtEnabled === true;
  const usable = client.enabled && ["openid", "profile"].every((scope) => client.allowedScopes?.includes(scope))
    && (!installation || installation.status === "active");
  return {
    scope: source ? "app" : "installation", enabled, appEnabled,
    effectiveEnabled: usable && appEnabled && enabled && (client.appType === "server_local" || installation?.status === "active"),
    canEnable: usable && (source || appEnabled),
    audience: client.clientId, expiresIn: 300,
  };
}

export async function getAppAgentJwtSettings(serverId: string, clientId: string): Promise<AppAgentJwtSettings> {
  return projectSettings(await readPolicyRows(getDb(), serverId, clientId, false));
}

export async function setAppAgentJwtSettings(input: { serverId: string; clientId: string; actorUserId: string; enabled: boolean }): Promise<AppAgentJwtSettings> {
  return getDb().transaction(async (tx) => {
    // Hold current authority through commit; a stale editor/session cannot win
    // against a completed role removal or downgrade.
    const [member] = await tx.select({ role: serverMembers.role }).from(serverMembers).where(and(
      eq(serverMembers.serverId, input.serverId), eq(serverMembers.userId, input.actorUserId),
    )).for("share");
    if (!member || !actorRoleHasServerCapability(member.role, "manageIntegrations")) {
      throw new AgentJwtPolicyError(403, "Only server owners and admins can manage Agent JWT access");
    }
    const rows = await readPolicyRows(tx, input.serverId, input.clientId, true);
    // Turning off must also recover a legacy row whose old env policy is broken.
    if (input.enabled && !projectSettings(rows.source ? { ...rows, client: { ...rows.client, agentJwtEnabled: true } } : rows).canEnable) {
      throw new AgentJwtPolicyError(400, "Enable Login with Raft with openid/profile, an active App, and publisher JWT support first");
    }
    if (rows.source) {
      await tx.update(oauthClients).set({ agentJwtEnabled: input.enabled, updatedAt: currentDate() }).where(eq(oauthClients.id, rows.client.id));
      rows.client.agentJwtEnabled = input.enabled;
    } else {
      await tx.update(oauthClientInstalls).set({ agentJwtEnabled: input.enabled, updatedAt: currentDate() }).where(eq(oauthClientInstalls.id, rows.installation!.id));
      rows.installation!.agentJwtEnabled = input.enabled;
    }
    await recordIntegrationAuditEvent({
      serverId: input.serverId, clientId: rows.client.id,
      eventType: rows.source ? "app.agent_jwt_updated" : "installation.agent_jwt_updated",
      outcome: "success", source: "web", actor: { type: "human", id: input.actorUserId },
      target: { type: "app", id: rows.client.id }, metadata: { clientKey: rows.client.clientId, enabled: input.enabled },
    });
    return projectSettings(rows);
  });
}

/** One-time operator migration after every issuer runs the DB policy resolver.
 * Defaults to read-only; never changes an explicit App decision. */
export async function backfillLegacyAgentJwtPolicies(apply = false) {
  const raw = process.env.RAFT_AGENT_JWT_AUDIENCES;
  if (raw === undefined) throw new AgentAudienceJwtError("AGENT_JWT_CONFIGURATION_INVALID");
  let policy: z.infer<typeof legacyPolicySchema>;
  try { policy = legacyPolicySchema.parse(JSON.parse(raw)); }
  catch { throw new AgentAudienceJwtError("AGENT_JWT_CONFIGURATION_INVALID"); }
  const keyOf = (value: { serverId: string; clientId: string }) => `${value.serverId}\0${value.clientId}`;
  const pairs = new Map(policy.map((pair) => [keyOf(pair), pair]));
  return getDb().transaction(async (tx) => {
    const query = tx.select({ id: oauthClients.id, serverId: oauthClients.serverId, clientId: oauthClients.clientId, appType: oauthClients.appType, enabled: oauthClients.enabled, allowedScopes: oauthClients.allowedScopes, agentJwtEnabled: oauthClients.agentJwtEnabled }).from(oauthClients).where(oauthClientIsUserManagedPredicate()).orderBy(oauthClients.id);
    const clients = apply ? await query.for("update") : await query;
    const byKey = new Map(clients.map((client) => [keyOf(client), client]));
    const enableIds = new Set<string>();
    const result = { apply, rawEntries: policy.length, distinctPairs: pairs.size, duplicates: policy.length - pairs.size, importedEnabled: 0, preservedEnabled: 0, preservedDisabled: 0, rejected: 0, nonAllowlistedDisabled: 0, rejectedDisabled: 0 };
    for (const [key] of pairs) {
      const client = byKey.get(key);
      if (!client || client.appType !== "server_local" || !client.enabled || !["openid", "profile"].every((scope) => client.allowedScopes?.includes(scope))) {
        result.rejected++;
      } else if (client.agentJwtEnabled === true) result.preservedEnabled++;
      else if (client.agentJwtEnabled === false) result.preservedDisabled++;
      else { result.importedEnabled++; enableIds.add(client.id); }
    }
    for (const client of clients) {
      if (client.agentJwtEnabled !== null) continue;
      const enabled = enableIds.has(client.id);
      if (!enabled) {
        if (pairs.has(keyOf(client))) result.rejectedDisabled++;
        else result.nonAllowlistedDisabled++;
      }
      if (!apply) continue;
      await tx.update(oauthClients).set({ agentJwtEnabled: enabled, updatedAt: currentDate() }).where(eq(oauthClients.id, client.id));
      await recordIntegrationAuditEvent({
        serverId: client.serverId, clientId: client.id, eventType: "app.agent_jwt_updated",
        outcome: "success", source: "system", actor: { type: "system" },
        target: { type: "app", id: client.id }, metadata: { clientKey: client.clientId, enabled },
      });
    }
    return result;
  });
}
