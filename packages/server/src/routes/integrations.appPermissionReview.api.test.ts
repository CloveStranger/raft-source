import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { users, oauthClients } from "../db/schema";
import { createServer } from "../services/serverService";
import { createOAuthClient } from "../services/oauthService";
import { createAppOutboundPermissionRevision } from "../services/appOutboundPermissionService";

const test = createApiTest({ onboardingOpenerFlagDefaultEnabled: false });

test("permission review approval binds the displayed revision and rejects a silently replaced request", async ({ app }) => {
  const suffix = randomUUID();
  const [owner] = await getDb().insert(users).values({
    email: `review-${suffix}@example.test`,
    name: `review-${suffix}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("review", `review-${suffix}`, owner.id);
  const { client } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    appType: "third_party_global",
    clientId: `review-${suffix.slice(0, 8)}`,
    name: "Review fixture",
  });
  await getDb().update(oauthClients).set({ publishStatus: "published" }).where(eq(oauthClients.id, client.id));

  const actor = { type: "human" as const, id: owner.id };
  const first = await createAppOutboundPermissionRevision({ clientId: client.id, actor, groups: ["agent"], events: [] });
  assert.ok(first);
  const firstRevisionId = first.revision.id;

  const token = await tokenForHuman(owner.email);
  const headers = {
    Authorization: `Bearer ${token}`,
    "X-Server-Id": server.id,
    "Content-Type": "application/json",
  };
  const prior = process.env.SLOCK_MARKETPLACE_REVIEWER_USER_IDS;
  process.env.SLOCK_MARKETPLACE_REVIEWER_USER_IDS = owner.id;
  try {
    const listing = await (await fetch(`${app.baseUrl}/api/integrations/marketplace`, { headers })).json();
    const row = listing.find((entry: { id: string }) => entry.id === client.id);
    assert.deepEqual(row.appNotificationPendingGroups, ["agent"]);
    assert.equal(row.appNotificationPendingRevisionId, firstRevisionId);
    assert.equal(row.canReviewAppNotifications, true);

    // An explicitly present but invalid expected_revision_id is a client bug:
    // it must not degrade into approve-latest.
    for (const invalid of [null, 123, "not-a-uuid", ""]) {
      const badResponse = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/app-notifications/permissions/review`, {
        method: "POST",
        headers,
        body: JSON.stringify({ expected_revision_id: invalid }),
      });
      assert.equal(badResponse.status, 400, `expected_revision_id=${JSON.stringify(invalid)} must be rejected`);
    }
    const [stillPending] = await getDb().select({ pending: oauthClients.outboundPendingRevisionId }).from(oauthClients).where(eq(oauthClients.id, client.id));
    assert.equal(stillPending.pending, firstRevisionId, "invalid inputs must not approve anything");

    // The publisher replaces the request before the reviewer clicks approve.
    const replacement = await createAppOutboundPermissionRevision({
      clientId: client.id,
      actor,
      groups: ["agent", "server"],
      events: [],
    });
    assert.ok(replacement);
    const replacementRevisionId = replacement.revision.id;

    const staleResponse = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/app-notifications/permissions/review`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expected_revision_id: firstRevisionId }),
    });
    assert.equal(staleResponse.status, 409, "stale UI approval must fail rather than approve unseen authority");
    const staleBody = await staleResponse.json();
    assert.equal(staleBody.code, "permission_revision_stale");

    // The pending revision is still the replacement — nothing was approved.
    const [stored] = await getDb().select({
      groups: oauthClients.outboundCurrentGroups,
      pending: oauthClients.outboundPendingRevisionId,
    }).from(oauthClients).where(eq(oauthClients.id, client.id));
    assert.equal(stored.pending, replacementRevisionId);
    assert.deepEqual(stored.groups, []);

    // Approving with the replacement's id commits exactly that revision.
    const approveResponse = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/app-notifications/permissions/review`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expected_revision_id: replacementRevisionId }),
    });
    assert.equal(approveResponse.status, 200);
    const [committed] = await getDb().select({
      groups: oauthClients.outboundCurrentGroups,
      pending: oauthClients.outboundPendingRevisionId,
    }).from(oauthClients).where(eq(oauthClients.id, client.id));
    assert.equal(committed.pending, null);
    assert.deepEqual([...committed.groups].sort(), ["agent", "server"]);
  } finally {
    if (prior === undefined) delete process.env.SLOCK_MARKETPLACE_REVIEWER_USER_IDS;
    else process.env.SLOCK_MARKETPLACE_REVIEWER_USER_IDS = prior;
  }
});
