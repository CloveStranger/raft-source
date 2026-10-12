import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { appSupportsAgentJwt } from "./agentAudienceJwtPolicyService";

const previous = process.env.RAFT_AGENT_JWT_AUDIENCES;
afterEach(() => { if (previous === undefined) delete process.env.RAFT_AGENT_JWT_AUDIENCES; else process.env.RAFT_AGENT_JWT_AUDIENCES = previous; });
const legacy = { serverId: "11111111-1111-4111-8111-111111111111", clientId: "fixture-app", appType: "server_local", agentJwtEnabled: null };

test("stored App decisions override even invalid legacy config; fallback never enables distributed Apps", () => {
  process.env.RAFT_AGENT_JWT_AUDIENCES = "invalid";
  assert.equal(appSupportsAgentJwt({ ...legacy, agentJwtEnabled: false }), false);
  assert.equal(appSupportsAgentJwt({ ...legacy, agentJwtEnabled: true }), true);
  assert.throws(() => appSupportsAgentJwt(legacy), /AGENT_JWT_CONFIGURATION_INVALID/);
  process.env.RAFT_AGENT_JWT_AUDIENCES = JSON.stringify([{ serverId: legacy.serverId, clientId: legacy.clientId }]);
  assert.equal(appSupportsAgentJwt(legacy), true);
  assert.equal(appSupportsAgentJwt({ ...legacy, appType: "third_party_global" }), false);
  assert.equal(appSupportsAgentJwt({ ...legacy, serverId: "22222222-2222-4222-8222-222222222222" }), false);
});

test("policy migration preserves old clients for compatibility but defaults new clients and every installation off", async () => {
  const db = new PGlite();
  try {
    await db.exec("CREATE TABLE oauth_clients (id text PRIMARY KEY); CREATE TABLE oauth_client_installs (id text PRIMARY KEY); INSERT INTO oauth_clients VALUES ('old'); INSERT INTO oauth_client_installs VALUES ('old');");
    await db.exec(readFileSync(new URL("../../drizzle/0325_amazing_greymalkin.sql", import.meta.url), "utf8"));
    await db.exec("INSERT INTO oauth_clients (id) VALUES ('new'); INSERT INTO oauth_client_installs (id) VALUES ('new');");
    const clients = await db.query<{ id: string; agent_jwt_enabled: boolean | null }>("SELECT * FROM oauth_clients ORDER BY id");
    assert.deepEqual(clients.rows, [{ id: "new", agent_jwt_enabled: false }, { id: "old", agent_jwt_enabled: null }]);
    const installations = await db.query<{ agent_jwt_enabled: boolean }>("SELECT agent_jwt_enabled FROM oauth_client_installs");
    assert.ok(installations.rows.every((row) => row.agent_jwt_enabled === false));
  } finally { await db.close(); }
});
