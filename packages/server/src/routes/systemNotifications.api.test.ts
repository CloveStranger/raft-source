import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import {
  agents,
  computers,
  featureFlagRules,
  featureFlags,
  machines,
  serverMembers,
  systemAttentionIncidents,
  users,
} from "../db/schema";
import { createServer } from "../services/serverService";
import { USAGE_LIMIT_ATTENTION_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function createVerifiedUser(email: string) {
  const [user] = await getDb().insert(users).values({
    id: randomUUID(),
    email,
    name: email.split("@")[0],
    displayName: email.split("@")[0],
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}



test("system-notification feed follows viewMachines and excludes managed Computers", async ({ app }) => {
  const owner = await createVerifiedUser("notification-owner@slock.test");
  const admin = await createVerifiedUser("notification-admin@slock.test");
  const member = await createVerifiedUser("notification-member@slock.test");
  const outsider = await createVerifiedUser("notification-outsider@slock.test");
  const server = await createServer("Notification authority", "notification-authority", owner.id);
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: admin.id, role: "admin" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);
  const [offlineMachine] = await getDb().insert(machines).values({
    serverId: server.id,
    userId: owner.id,
    name: "Offline Daemon",
    apiKeyHash: "unused-hash",
    daemonVersion: "0.60.0",
  }).returning();
  const [managedComputerMachine] = await getDb().insert(machines).values({
    serverId: server.id,
    userId: owner.id,
    name: "Managed Computer",
    apiKeyHash: "unused-computer-machine-hash",
    daemonVersion: "0.1.0",
  }).returning();
  await getDb().insert(computers).values({
    serverId: server.id,
    machineId: managedComputerMachine.id,
    name: "Managed Computer",
    apiKeyHash: "unused-computer-key-hash",
    apiKeyPrefix: "sk_computer_notification",
    attachedByUserId: owner.id,
  });
  const [activeAgent] = await getDb().insert(agents).values([
    { serverId: server.id, name: "active-offline-agent", machineId: offlineMachine.id, status: "active" },
    { serverId: server.id, name: "inactive-offline-agent", machineId: offlineMachine.id, status: "inactive" },
    {
      serverId: server.id,
      name: "deleted-active-offline-agent",
      machineId: offlineMachine.id,
      status: "active",
      deletedAt: new Date(),
    },
  ]).returning();

  let machineStatusReads = 0;
  app.app.set("agentOrchestrator", {
    getMachineStatus: async () => {
      machineStatusReads += 1;
      return "offline" as const;
    },
    getMachineStatusVersion: async () => 3,
    getMachineDaemonVersion: () => null,
    getMachineComputerVersion: async () => null,
  });

  const ownerToken = await tokenForHuman(owner.email);
  const adminToken = await tokenForHuman(admin.email);
  const memberToken = await tokenForHuman(member.email);
  const outsiderToken = await tokenForHuman(outsider.email);
  const read = async (token: string) => {
    const response = await fetch(`${app.baseUrl}/api/servers/${server.id}/system-notifications`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Server-Id": server.id,
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    return await response.json() as {
      contractVersion: string;
      snapshotMode: string;
      clientState: { read: string; dismiss: string };
      notifications: Array<{
        id: string;
        type: string;
        kind: string;
        action: { targetId: string };
        payload: { activeAgentCount: number };
      }>;
    };
  };

  const ownerFeed = await read(ownerToken);
  assert.equal(ownerFeed.contractVersion, "server-system-notifications-v1");
  assert.equal(ownerFeed.snapshotMode, "replace");
  assert.deepEqual(ownerFeed.clientState, {
    read: "none",
    dismiss: "local_by_notification_id",
  });
  assert.deepEqual(ownerFeed.notifications.map((notification) => ({
    id: notification.id,
    type: notification.type,
    kind: notification.kind,
    activeAgentCount: notification.payload.activeAgentCount,
    targetId: notification.action.targetId,
  })), [{
    id: `machine-offline:${offlineMachine.id}`,
    type: "machine.offline",
    kind: "error",
    activeAgentCount: 1,
    targetId: offlineMachine.id,
  }]);

  const adminFeed = await read(adminToken);
  assert.deepEqual(
    adminFeed.notifications.map((notification) => ({
      id: notification.id,
      type: notification.type,
      targetId: notification.action.targetId,
    })),
    ownerFeed.notifications.map((notification) => ({
      id: notification.id,
      type: notification.type,
      targetId: notification.action.targetId,
    })),
    "owner/admin share viewMachines authority",
  );

  const memberFeed = await read(memberToken);
  assert.deepEqual(
    memberFeed.notifications.map((notification) => notification.id),
    ownerFeed.notifications.map((notification) => notification.id),
    "current members receive the same raw-daemon feed through viewMachines",
  );
  assert.ok(
    memberFeed.notifications.every((notification) => !notification.id.includes(managedComputerMachine.id)),
    "managed Computer state stays on its separate aggregate attention surface",
  );
  const readsAfterMembers = machineStatusReads;

  const outsiderResponse = await fetch(`${app.baseUrl}/api/servers/${server.id}/system-notifications`, {
    headers: {
      Authorization: `Bearer ${outsiderToken}`,
      "X-Server-Id": server.id,
    },
  });
  assert.equal(outsiderResponse.status, 403, "server-context middleware rejects non-members");
  assert.equal(
    machineStatusReads,
    readsAfterMembers,
    "non-member feed must fail closed before querying canonical machine read models",
  );

  await getDb().update(agents).set({ status: "inactive" }).where(eq(agents.id, activeAgent.id));
  const idleFeed = await read(ownerToken);
  assert.equal(idleFeed.notifications[0]?.kind, "warning");
  assert.equal(idleFeed.notifications[0]?.payload.activeAgentCount, 0);

  await getDb().update(serverMembers)
    .set({ role: "member" })
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, admin.id)));
  assert.equal(
    (await read(adminToken)).notifications[0]?.type,
    "machine.offline",
    "admin-to-member keeps the feed because both roles currently have viewMachines",
  );

  await getDb().update(serverMembers)
    .set({ role: "admin" })
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, member.id)));
  assert.equal((await read(memberToken)).notifications[0]?.type, "machine.offline", "promotion grants the canonical feed");
});

test("usage-limit attention syncs per-recipient seen/dismiss and resurfaces on a new activation", async ({ app }) => {
  const owner = await createVerifiedUser("attention-owner@slock.test");
  const admin = await createVerifiedUser("attention-admin@slock.test");
  const member = await createVerifiedUser("attention-member@slock.test");
  const server = await createServer("Usage attention", "usage-attention", owner.id);
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: admin.id, role: "admin" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);
  await getDb().insert(featureFlags).values({
    key: USAGE_LIMIT_ATTENTION_FEATURE_FLAG_KEY,
    description: "test",
    randomizationUnit: "server",
    defaultEnabled: false,
    salt: USAGE_LIMIT_ATTENTION_FEATURE_FLAG_KEY,
  }).onConflictDoNothing();
  await getDb().insert(featureFlagRules).values({
    flagKey: USAGE_LIMIT_ATTENTION_FEATURE_FLAG_KEY,
    stage: "server",
    decision: "allow",
    values: [server.id],
  });
  const [machine] = await getDb().insert(machines).values({
    serverId: server.id,
    userId: owner.id,
    name: "Cindy MacBook",
    apiKeyHash: "unused-attention-machine-hash",
  }).returning();
  const activatedAt = new Date("2026-10-11T08:00:00.000Z");
  const [first] = await getDb().insert(systemAttentionIncidents).values({
    serverId: server.id,
    machineId: machine.id,
    kind: "usage_limit_reached",
    provider: "codex",
    accountKeyHash: "a".repeat(64),
    windowKey: "primary",
    activationGeneration: 1,
    affectedAgentIds: [randomUUID(), randomUUID()],
    activatedAt,
    lastObservedAt: activatedAt,
  }).returning();

  const ownerToken = await tokenForHuman(owner.email);
  const adminToken = await tokenForHuman(admin.email);
  const memberToken = await tokenForHuman(member.email);
  const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "X-Server-Id": server.id });
  const read = async (token: string) => {
    const response = await fetch(`${app.baseUrl}/api/servers/${server.id}/system-notifications-v2`, {
      headers: headers(token),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    return await response.json() as {
      contractVersion: string;
      unseenCount: number;
      notifications: Array<{ id: string; seenAt: string | null; machine: { id: string; name: string }; affectedAgentIds: string[] }>;
    };
  };
  const mutate = async (token: string, incidentId: string, action: "seen" | "dismiss") => {
    const response = await fetch(
      `${app.baseUrl}/api/servers/${server.id}/system-notifications-v2/${incidentId}/${action}`,
      { method: "POST", headers: headers(token) },
    );
    assert.equal(response.status, 200);
  };

  const ownerInitial = await read(ownerToken);
  assert.equal(ownerInitial.contractVersion, "server-system-attention-v1");
  assert.equal(ownerInitial.unseenCount, 1);
  assert.deepEqual(ownerInitial.notifications.map((notification) => ({
    id: notification.id,
    seenAt: notification.seenAt,
    machine: notification.machine,
    affectedAgentCount: notification.affectedAgentIds.length,
  })), [{
    id: first.id,
    seenAt: null,
    machine: { id: machine.id, name: "Cindy MacBook" },
    affectedAgentCount: 2,
  }]);
  assert.equal((await read(adminToken)).unseenCount, 1, "another recipient owns an independent receipt");
  assert.deepEqual((await read(memberToken)).notifications, [], "ordinary members are not recipients");

  await getDb().update(featureFlags).set({ killSwitch: true })
    .where(eq(featureFlags.key, USAGE_LIMIT_ATTENTION_FEATURE_FLAG_KEY));
  assert.deepEqual((await read(ownerToken)).notifications, [], "kill switch empties the replace snapshot");
  const gatedMutation = await fetch(
    `${app.baseUrl}/api/servers/${server.id}/system-notifications-v2/${first.id}/seen`,
    { method: "POST", headers: headers(ownerToken) },
  );
  assert.equal(gatedMutation.status, 404, "kill switch also closes direct receipt writes");
  await getDb().update(featureFlags).set({ killSwitch: false })
    .where(eq(featureFlags.key, USAGE_LIMIT_ATTENTION_FEATURE_FLAG_KEY));

  await mutate(ownerToken, first.id, "seen");
  assert.equal((await read(ownerToken)).unseenCount, 0, "a second device reads the server-backed seen receipt");
  assert.equal((await read(adminToken)).unseenCount, 1, "owner seen does not mark admin seen");
  await mutate(ownerToken, first.id, "dismiss");
  assert.deepEqual((await read(ownerToken)).notifications, []);
  assert.equal((await read(adminToken)).notifications.length, 1);

  const recoveredAt = new Date("2026-10-11T09:00:00.000Z");
  await getDb().update(systemAttentionIncidents).set({
    state: "resolved",
    resolvedAt: recoveredAt,
    lastObservedAt: recoveredAt,
  }).where(eq(systemAttentionIncidents.id, first.id));
  const [second] = await getDb().insert(systemAttentionIncidents).values({
    serverId: server.id,
    machineId: machine.id,
    kind: "usage_limit_reached",
    provider: "codex",
    accountKeyHash: "a".repeat(64),
    windowKey: "primary",
    activationGeneration: 2,
    affectedAgentIds: [randomUUID()],
    activatedAt: new Date("2026-10-11T10:00:00.000Z"),
    lastObservedAt: new Date("2026-10-11T10:00:00.000Z"),
  }).returning();
  const ownerReactivated = await read(ownerToken);
  assert.equal(ownerReactivated.unseenCount, 1);
  assert.deepEqual(ownerReactivated.notifications.map((notification) => notification.id), [second.id]);
});
