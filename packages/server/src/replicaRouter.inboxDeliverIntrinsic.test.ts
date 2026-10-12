import assert from "node:assert/strict";

import type { AgentMessage } from "@botiverse/raft-shared";
import {
  __setInboxDeliveryHandlerForTests,
  __setInboxDeliveryReceiptRouteRuntimeForTests,
  handleReplicaMessage,
  routeInboxDelivery,
  type RoutedInboxDeliveryOptions,
} from "./replicaRouter";

const message: AgentMessage = {
  channel_id: "onboarding-context",
  channel_name: "onboarding-context",
  channel_type: "channel",
  sender_id: "system",
  sender_name: "system",
  sender_type: "system",
  content: "owner facts",
  timestamp: "2026-10-09T07:00:00.000Z",
  message_id: "onboarding-owner-facts-server-1",
  seq: 0,
};

afterEach(() => {
  __setInboxDeliveryHandlerForTests(null);
  __setInboxDeliveryReceiptRouteRuntimeForTests(null);
});

function captureRoute(): { outgoing: Array<Record<string, unknown>> } {
  const captured = { outgoing: [] as Array<Record<string, unknown>> };
  __setInboxDeliveryReceiptRouteRuntimeForTests({
    isAvailable: () => true,
    getTargetReplica: async () => "replica-target",
    publish: async (_targetReplicaId, raw) => {
      captured.outgoing.push(JSON.parse(raw) as Record<string, unknown>);
      handleReplicaMessage("slock:replica:target", raw);
      return 1;
    },
  });
  return captured;
}

function captureHandler(): Array<RoutedInboxDeliveryOptions> {
  const received: Array<RoutedInboxDeliveryOptions> = [];
  __setInboxDeliveryHandlerForTests((_agentId, _machineId, _message, options) => {
    received.push(options);
  });
  return received;
}

test("plain inbox route carries intrinsic in the replica envelope to the owner handler", async () => {
  const captured = captureRoute();
  const received = captureHandler();

  const routed = await routeInboxDelivery("agent-1", "machine-1", message, new Set(), { intrinsic: true });

  assert.equal(routed, true);
  assert.deepEqual(captured.outgoing[0]?.deliveryOptions, { intrinsic: true });
  assert.deepEqual(received, [{ intrinsic: true }]);
});

test("plain inbox route without intrinsic keeps the old envelope and the owner gets no intrinsic", async () => {
  const captured = captureRoute();
  const received = captureHandler();

  await routeInboxDelivery("agent-1", "machine-1", message, new Set());
  await routeInboxDelivery("agent-1", "machine-1", message, new Set(), { intrinsic: false });

  assert.equal("deliveryOptions" in (captured.outgoing[0] ?? {}), false);
  assert.equal("deliveryOptions" in (captured.outgoing[1] ?? {}), false);
  assert.deepEqual(received, [{}, {}]);
});

test("intrinsic inside the AgentMessage payload is not read as a delivery option", () => {
  const received = captureHandler();

  handleReplicaMessage("slock:replica:target", JSON.stringify({
    type: "inbox:deliver",
    machineId: "machine-1",
    agentId: "agent-1",
    payload: { ...message, intrinsic: true, deliveryOptions: { intrinsic: true } },
  }));

  assert.deepEqual(received, [{}]);
});
