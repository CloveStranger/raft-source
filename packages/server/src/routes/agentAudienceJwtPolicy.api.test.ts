import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { appAgentJwtSettingsSchema } from "@botiverse/raft-shared";
import { agentJwtIssuanceCounter } from "../metrics";
import { getDb } from "../db/index";
import { users, oauthClients, oauthClientInstalls, integrationAuditEvents } from "../db/schema";
import { backfillLegacyAgentJwtPolicies } from "../services/agentAudienceJwtPolicyService";
import { createOAuthClient } from "../services/oauthService";
import { createServer, addMember } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createApiTest } from "../test/integration/apiTest";
import { openTestApp } from "../test/integration/app";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

test("App JWT settings enable without operator configuration and preserve Server installation consent", async () => {
  const previous = process.env.RAFT_AGENT_JWT_AUDIENCES;
  delete process.env.RAFT_AGENT_JWT_AUDIENCES;
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const seedUser = async (label: string) => {
      const suffix = randomUUID();
      const [user] = await getDb().insert(users).values({ name: `jwt-${label}-${suffix}`, email: `${suffix}@raft.test`, passwordHash: await fixturePasswordHash("password123"), emailVerified: true, profileSetupCompletedAt: new Date() }).returning();
      return { ...user, token: await tokenForHuman(user.email) };
    };
    const owner = await seedUser("owner");
    const installer = await seedUser("installer");
    const member = await seedUser("member");
    const source = await createServer("Publisher", `publisher-${randomUUID()}`, owner.id);
    const target = await createServer("Installer", `installer-${randomUUID()}`, installer.id);
    const unrelated = await createServer("Unrelated", `unrelated-${randomUUID()}`, installer.id);
    await addMember(source.id, member.id);
    const { client } = await createOAuthClient({ serverId: source.id, createdByUserId: owner.id, clientId: `jwt-${randomUUID().slice(0, 8)}`, name: "Audience app", allowedScopes: ["openid", "profile"] });
    const settings = (serverId: string, token: string, body?: object) => fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/agent-jwt`, {
      method: body ? "PUT" : "GET", headers: { Authorization: `Bearer ${token}`, "X-Server-Id": serverId, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const sourceAgent = await createAgent(source.id, "SourceAgent", { runtime: "external", model: "external" });
    const targetAgent = await createAgent(target.id, "TargetAgent", { runtime: "external", model: "external" });
    const sourceKey = await mintAgentCredential({ agentId: sourceAgent.id, scopes: ["read"], name: "source", createdByUserId: null });
    const targetKey = await mintAgentCredential({ agentId: targetAgent.id, scopes: ["read"], name: "target", createdByUserId: null });
    const issue = (token: string) => fetch(`${app.baseUrl}/internal/agent-api/integrations/token`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ service: client.clientId }) });

    const initial = appAgentJwtSettingsSchema.parse(await (await settings(source.id, owner.token)).json());
    assert.equal(initial.enabled, false);
    assert.equal(initial.scope, "app");
    assert.equal((await issue(sourceKey.apiKey)).status, 403);
    const unknown = await fetch(`${app.baseUrl}/internal/agent-api/integrations/token`, { method: "POST", headers: { Authorization: `Bearer ${targetKey.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ service: "unknown-private-app" }) });
    const unknownError = await unknown.json() as { errorCode: string };
    const privateError = await (await issue(targetKey.apiKey)).json() as { errorCode: string };
    assert.equal(privateError.errorCode, unknownError.errorCode, "an unavailable private App cannot disclose its JWT policy through error codes");
    await getDb().update(oauthClients).set({ agentJwtEnabled: null }).where(eq(oauthClients.id, client.id));
    process.env.RAFT_AGENT_JWT_AUDIENCES = "invalid";
    const unavailableLegacy = await issue(targetKey.apiKey);
    assert.equal(unavailableLegacy.status, unknown.status, "unavailable legacy Apps cannot expose a configuration error");
    assert.equal((await unavailableLegacy.json() as { errorCode: string }).errorCode, unknownError.errorCode);
    delete process.env.RAFT_AGENT_JWT_AUDIENCES;
    await getDb().update(oauthClients).set({ agentJwtEnabled: false }).where(eq(oauthClients.id, client.id));

    assert.equal((await settings(source.id, member.token, { enabled: true })).status, 403);
    assert.equal((await settings(unrelated.id, installer.token, { enabled: true })).status, 404);
    assert.equal((await settings(source.id, owner.token, { enabled: "true" })).status, 400);
    assert.equal((await settings(source.id, owner.token, { enabled: true, audience: "other" })).status, 400);
    assert.equal((await settings(source.id, owner.token, { enabled: true })).status, 200);
    assert.equal(appAgentJwtSettingsSchema.parse(await (await settings(source.id, owner.token)).json()).effectiveEnabled, true);
    const firstIssue = await issue(sourceKey.apiKey);
    assert.equal(firstIssue.status, 200, "no env change or restart required");
    const issued = await firstIssue.json() as { access_token: string; expires_in: number };
    const claims = JSON.parse(Buffer.from(issued.access_token.split(".")[1], "base64url").toString());
    assert.equal(claims.aud, client.clientId);
    assert.equal(claims.server_id, source.id);
    assert.equal(issued.expires_in, 300);
    process.env.RAFT_AGENT_JWT_AUDIENCES = "invalid";
    assert.equal((await issue(sourceKey.apiKey)).status, 200, "explicit enable ignores invalid legacy config");
    delete process.env.RAFT_AGENT_JWT_AUDIENCES;
    const unknownService = `unregistered-${randomUUID()}`;
    await fetch(`${app.baseUrl}/internal/agent-api/integrations/token`, { method: "POST", headers: { Authorization: `Bearer ${sourceKey.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ service: unknownService }) });
    const metric = await agentJwtIssuanceCounter.get();
    assert.ok(metric.values.some((value) => value.labels.client_id === client.clientId && value.labels.outcome === "issued"));
    assert.ok(metric.values.every((value) => value.labels.client_id !== unknownService && value.labels.client_id !== sourceAgent.id));
    assert.equal(JSON.stringify(metric).includes(issued.access_token), false);

    await settings(source.id, owner.token, { enabled: false });
    process.env.RAFT_AGENT_JWT_AUDIENCES = JSON.stringify([{ serverId: source.id, clientId: client.clientId }]);
    assert.equal((await issue(sourceKey.apiKey)).status, 403, "explicit off overrides legacy env");
    await settings(source.id, owner.token, { enabled: true });
    delete process.env.RAFT_AGENT_JWT_AUDIENCES;

    await getDb().update(oauthClients).set({ appType: "third_party_global", publishStatus: "published" }).where(eq(oauthClients.id, client.id));
    assert.equal((await issue(targetKey.apiKey)).status, 403, "publisher declaration cannot install or approve for another Server");
    const [installation] = await getDb().insert(oauthClientInstalls).values({ serverId: target.id, clientId: client.id, installedByUserId: installer.id }).returning();
    assert.equal((await issue(targetKey.apiKey)).status, 403, "existing/new installs default unapproved");
    const installState = appAgentJwtSettingsSchema.parse(await (await settings(target.id, installer.token)).json());
    assert.equal(installState.scope, "installation");
    assert.equal(installState.enabled, false);
    assert.equal((await settings(target.id, owner.token, { enabled: true })).status, 403, "publisher cannot act as target admin");
    assert.equal((await settings(target.id, installer.token, { enabled: true })).status, 200);
    const targetIssued = await issue(targetKey.apiKey);
    assert.equal(targetIssued.status, 200);
    const targetClaims = JSON.parse(Buffer.from((await targetIssued.json() as { access_token: string }).access_token.split(".")[1], "base64url").toString());
    assert.equal(targetClaims.server_id, target.id, "issuer identity comes from invoking Agent, not publisher");
    assert.equal(targetClaims.aud, client.clientId);
    await settings(source.id, owner.token, { enabled: false });
    assert.equal((await issue(targetKey.apiKey)).status, 403, "publisher withdrawal stops issuance");
    assert.equal((await settings(target.id, installer.token, { enabled: true })).status, 400);
    await settings(source.id, owner.token, { enabled: true });
    await settings(target.id, installer.token, { enabled: false });
    assert.equal((await issue(targetKey.apiKey)).status, 403, "installation disable stops new tokens");
    await settings(target.id, installer.token, { enabled: true });
    await getDb().update(oauthClientInstalls).set({ status: "suspended" }).where(eq(oauthClientInstalls.id, installation.id));
    assert.equal((await issue(targetKey.apiKey)).status, 403);
    await getDb().delete(oauthClientInstalls).where(eq(oauthClientInstalls.id, installation.id));
    assert.equal((await issue(targetKey.apiKey)).status, 403);
    await getDb().insert(oauthClientInstalls).values({ serverId: target.id, clientId: client.id, installedByUserId: installer.id });
    assert.equal((await issue(targetKey.apiKey)).status, 403, "reinstall does not restore prior JWT approval");

    const events = await getDb().select().from(integrationAuditEvents).where(and(eq(integrationAuditEvents.clientId, client.id), eq(integrationAuditEvents.eventType, "installation.agent_jwt_updated")));
    assert.ok(events.length >= 3);
    assert.equal(events[0].actorId, installer.id);
    assert.equal(events[0].serverId, target.id);
    assert.equal(JSON.stringify(events).includes(issued.access_token), false);

    await getDb().execute(sql.raw("CREATE FUNCTION reject_jwt_policy_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type = 'app.agent_jwt_updated' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$;"));
    await getDb().execute(sql.raw("CREATE TRIGGER reject_jwt_policy_audit BEFORE INSERT ON integration_audit_events FOR EACH ROW EXECUTE FUNCTION reject_jwt_policy_audit();"));
    assert.equal((await settings(source.id, owner.token, { enabled: false })).status, 500);
    const [afterFailedAudit] = await getDb().select({ enabled: oauthClients.agentJwtEnabled }).from(oauthClients).where(eq(oauthClients.id, client.id));
    assert.equal(afterFailedAudit.enabled, true, "policy and audit commit atomically");
  } finally {
    if (previous === undefined) delete process.env.RAFT_AGENT_JWT_AUDIENCES; else process.env.RAFT_AGENT_JWT_AUDIENCES = previous;
    await app.close();
  }
}, 120_000);


test("legacy JWT import is read-only by default, reconciles input, and cannot resurrect explicit off", async () => {
  const previous = process.env.RAFT_AGENT_JWT_AUDIENCES;
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const suffix = randomUUID();
    const [owner] = await getDb().insert(users).values({ name: `jwt-${suffix}`, email: `${suffix}@raft.test`, passwordHash: await fixturePasswordHash("password123"), emailVerified: true }).returning();
    const server = await createServer("Legacy JWT", `legacy-${suffix}`, owner.id);
    const create = async (name: string, enabled: boolean | null) => {
      const { client } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: `${name}-${suffix.slice(0, 8)}`, name, allowedScopes: ["openid", "profile"] });
      await getDb().update(oauthClients).set({ agentJwtEnabled: enabled }).where(eq(oauthClients.id, client.id));
      return client;
    };
    const legacy = await create("legacy", null);
    const off = await create("explicit-off", false);
    const on = await create("explicit-on", true);
    const unrelated = await create("unlisted", null);
    const pair = (client: { clientId: string }) => ({ serverId: server.id, clientId: client.clientId });
    process.env.RAFT_AGENT_JWT_AUDIENCES = JSON.stringify([pair(legacy), pair(legacy), pair(off), pair(on), pair({ clientId: "not-registered" })]);
    const expected = { rawEntries: 5, distinctPairs: 4, duplicates: 1, importedEnabled: 1, preservedEnabled: 1, preservedDisabled: 1, rejected: 1, nonAllowlistedDisabled: 1, rejectedDisabled: 0 };
    assert.deepEqual(await backfillLegacyAgentJwtPolicies(), { apply: false, ...expected });
    const read = async (id: string) => (await getDb().select({ enabled: oauthClients.agentJwtEnabled }).from(oauthClients).where(eq(oauthClients.id, id)))[0].enabled;
    assert.equal(await read(legacy.id), null, "preview writes nothing");
    assert.deepEqual(await backfillLegacyAgentJwtPolicies(true), { apply: true, ...expected });
    assert.equal(await read(legacy.id), true);
    assert.equal(await read(off.id), false);
    assert.equal(await read(on.id), true);
    assert.equal(await read(unrelated.id), false);
    const auditCount = (await getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "app.agent_jwt_updated"))).length;
    assert.equal(auditCount, 2);
    const repeated = await backfillLegacyAgentJwtPolicies(true);
    assert.equal(repeated.importedEnabled, 0);
    assert.equal(repeated.preservedEnabled, 2);
    assert.equal((await getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "app.agent_jwt_updated"))).length, auditCount);
    process.env.RAFT_AGENT_JWT_AUDIENCES = "invalid";
    await assert.rejects(() => backfillLegacyAgentJwtPolicies(true), /AGENT_JWT_CONFIGURATION_INVALID/);
  } finally {
    if (previous === undefined) delete process.env.RAFT_AGENT_JWT_AUDIENCES; else process.env.RAFT_AGENT_JWT_AUDIENCES = previous;
    await app.close();
  }
}, 120_000);
