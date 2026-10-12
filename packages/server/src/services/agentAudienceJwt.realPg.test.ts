import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { closeDatabase, getDb, initDatabase } from "../db/index";
import { agents, oauthClients, oauthClientInstalls, oauthGrants, serverMembers, serverAgentMembers, servers, users } from "../db/schema";
import { migrateRealPgTestDatabase } from "../test/integration/realPgMigrate";
import { AgentJwtPolicyError, getAppAgentJwtSettings, setAppAgentJwtSettings } from "./agentAudienceJwtPolicyService";
import { AgentAudienceJwtError, issueAgentAudienceJwt } from "./agentAudienceJwtService";

const url = process.env.AGENT_JWT_REAL_PG_URL;
const required = process.env.AGENT_JWT_REAL_PG_REQUIRED === "1";

test.skipIf(!url && !required)("JWT issuer waits for committed grant, client and Agent revocations on real PostgreSQL", async () => {
  if (!url) throw new Error("AGENT_JWT_REAL_PG_REQUIRED=1 requires AGENT_JWT_REAL_PG_URL");
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const previousPolicy = process.env.RAFT_AGENT_JWT_AUDIENCES;
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "isolated-real-pg-jwt-fixture";
  await migrateRealPgTestDatabase(pool, fileURLToPath(new URL("../../drizzle", import.meta.url)));
  await initDatabase(url);
  try {
    for (const boundary of ["grant", "client", "agent", "membership", "policy"] as const) {
      const suffix = randomUUID();
      const [owner] = await getDb().insert(users).values({ name: `jwt-${suffix}`, email: `jwt-${suffix}@raft.test`, passwordHash: "fixture", emailVerified: true }).returning();
      const [server] = await getDb().insert(servers).values({ name: "JWT lock test", slug: `jwt-${suffix}`, ownerId: owner.id }).returning();
      const [agent] = await getDb().insert(agents).values({ serverId: server.id, name: "jwt-agent" }).returning();
      await getDb().insert(serverAgentMembers).values({ serverId: server.id, agentId: agent.id });
      const [client] = await getDb().insert(oauthClients).values({ serverId: server.id, createdByUserId: owner.id, name: "JWT RP", clientId: `jwt-${suffix.slice(0, 8)}`, clientSecretHash: "fixture", allowedScopes: ["openid", "profile"], enabled: true, appType: "server_local", agentJwtEnabled: null }).returning();
      const [grant] = await getDb().insert(oauthGrants).values({ serverId: server.id, agentId: agent.id, clientId: client.id, scopes: ["openid", "profile"], grantedByUserId: owner.id }).returning();
      process.env.RAFT_AGENT_JWT_AUDIENCES = JSON.stringify([{ serverId: server.id, clientId: client.clientId }]);
      const input = { serverId: server.id, agentId: agent.id, service: client.clientId };
      assert.ok((await issueAgentAudienceJwt(input)).access_token, "positive control before revocation");
      const blocker = await pool.connect();
      let result: Promise<unknown> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query("SET LOCAL lock_timeout = '5s'");
        if (boundary === "grant") await blocker.query("UPDATE oauth_grants SET revoked_at = now() WHERE id = $1", [grant.id]);
        if (boundary === "policy") await blocker.query("UPDATE oauth_clients SET agent_jwt_enabled = false WHERE id = $1", [client.id]);
        if (boundary === "client") await blocker.query("UPDATE oauth_clients SET enabled = false WHERE id = $1", [client.id]);
        if (boundary === "agent") await blocker.query("UPDATE agents SET status = 'stopped' WHERE id = $1", [agent.id]);
        if (boundary === "membership") await blocker.query("DELETE FROM server_agent_members WHERE server_id = $1 AND agent_id = $2", [server.id, agent.id]);
        // Started outside any ambient product transaction: a separate connection
        // must wait for the real database lock, not join a savepoint.
        let settled = false;
        result = issueAgentAudienceJwt(input).then(
          () => { settled = true; return "unexpected-token"; },
          (error: unknown) => { settled = true; return error; },
        );
        let waiting = false;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && !settled) {
          const waiters = await pool.query("SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'select%'");
          if (waiters.rowCount) { waiting = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(waiting, true, `${boundary}: issuer must wait on the authority row`);
        await blocker.query("COMMIT");
        const outcome = await result;
        assert.ok(outcome instanceof AgentAudienceJwtError, `${boundary}: no token after committed revocation`);
        assert.equal(outcome.code, boundary === "policy" ? "AGENT_JWT_DISABLED" : "AGENT_JWT_NOT_AUTHORIZED");
      } finally {
        await blocker.query("ROLLBACK").catch(() => {});
        blocker.release();
        await result;
      }
    }
  } finally {
    if (previousPolicy === undefined) delete process.env.RAFT_AGENT_JWT_AUDIENCES; else process.env.RAFT_AGENT_JWT_AUDIENCES = previousPolicy;
    if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
    await closeDatabase();
    await pool.end();
  }
}, 120_000);


test.skipIf(!url && !required)("JWT issuer and settings wait for target installation and current manager authority", async () => {
  if (!url) throw new Error("AGENT_JWT_REAL_PG_REQUIRED=1 requires AGENT_JWT_REAL_PG_URL");
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "isolated-real-pg-jwt-policy-fixture";
  await migrateRealPgTestDatabase(pool, fileURLToPath(new URL("../../drizzle", import.meta.url)));
  await initDatabase(url);
  try {
    for (const boundary of ["approval", "installation", "manager-role"] as const) {
      const suffix = randomUUID();
      const [owner] = await getDb().insert(users).values({ name: `jwt-policy-${suffix}`, email: `jwt-policy-${suffix}@raft.test`, passwordHash: "fixture", emailVerified: true }).returning();
      const [publisher] = await getDb().insert(servers).values({ name: "Publisher", slug: `publisher-${suffix}`, ownerId: owner.id }).returning();
      const [target] = await getDb().insert(servers).values({ name: "Installer", slug: `installer-${suffix}`, ownerId: owner.id }).returning();
      await getDb().insert(serverMembers).values({ serverId: target.id, userId: owner.id, role: "admin" });
      const [agent] = await getDb().insert(agents).values({ serverId: target.id, name: "target-agent" }).returning();
      await getDb().insert(serverAgentMembers).values({ serverId: target.id, agentId: agent.id });
      const [client] = await getDb().insert(oauthClients).values({ serverId: publisher.id, createdByUserId: owner.id, name: "Shared JWT App", clientId: `jwt-policy-${suffix.slice(0, 8)}`, clientSecretHash: "fixture", allowedScopes: ["openid", "profile"], enabled: true, appType: "third_party_global", agentJwtEnabled: true }).returning();
      const [installation] = await getDb().insert(oauthClientInstalls).values({ serverId: target.id, clientId: client.id, installedByUserId: owner.id, agentJwtEnabled: true }).returning();
      const input = { serverId: target.id, agentId: agent.id, service: client.clientId };
      assert.ok((await issueAgentAudienceJwt(input)).access_token);
      const blocker = await pool.connect();
      let result: Promise<unknown> | undefined;
      try {
        await blocker.query("BEGIN");
        if (boundary === "approval") await blocker.query("UPDATE oauth_client_installs SET agent_jwt_enabled = false WHERE id = $1", [installation.id]);
        if (boundary === "installation") await blocker.query("DELETE FROM oauth_client_installs WHERE id = $1", [installation.id]);
        if (boundary === "manager-role") await blocker.query("UPDATE server_members SET role = 'member' WHERE server_id = $1 AND user_id = $2", [target.id, owner.id]);
        let settled = false;
        const work = boundary === "manager-role"
          ? setAppAgentJwtSettings({ serverId: target.id, clientId: client.id, actorUserId: owner.id, enabled: false })
          : issueAgentAudienceJwt(input);
        result = work.then(() => { settled = true; return "unexpected-success"; }, (error: unknown) => { settled = true; return error; });
        let waiting = false;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && !settled) {
          const waiters = await pool.query("SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'select%'");
          if (waiters.rowCount) { waiting = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(waiting, true, `${boundary}: real pending lock waiter`);
        await blocker.query("COMMIT");
        const outcome = await result;
        if (boundary === "manager-role") {
          assert.ok(outcome instanceof AgentJwtPolicyError);
          assert.equal(outcome.status, 403);
          assert.equal((await getAppAgentJwtSettings(target.id, client.id)).enabled, true, "revoked manager cannot change policy");
        } else {
          assert.ok(outcome instanceof AgentAudienceJwtError);
          assert.equal(outcome.code, boundary === "approval" ? "AGENT_JWT_DISABLED" : "AGENT_JWT_NOT_AUTHORIZED");
        }
      } finally {
        await blocker.query("ROLLBACK").catch(() => {}); blocker.release(); await result;
      }
    }
  } finally {
    if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
    await closeDatabase(); await pool.end();
  }
}, 120_000);
