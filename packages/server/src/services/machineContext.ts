import crypto from "node:crypto";
import { SERVER_CAPABILITY_START_SPAWN_ERROR_V1, type ServerToMachineMessage } from "@botiverse/raft-shared";
import { serverMachineContextCapabilities } from "../runtimeOutcomeOutboxIngest";

type MachineContextSocket = {
  send(data: string): void;
};

/** One machine connection's epoch; minted by the route so `machine:context` can carry it. */
export function newMachineConnectionEpochId(machineId: string): string {
  return `machine:${machineId}:connection:${crypto.randomUUID()}`;
}

/**
 * The connection route has already authenticated both identities. Send this
 * before registration can replay any queued Agent/App work to the machine.
 * `capabilities` is omitted when the server advertises none, so the frame is
 * unchanged for every daemon until a capability is switched on.
 * `connectionEpochId` goes out only with `agent:start-spawn-error-v1` (task
 * #365): the daemon refuses an automatic `agent:start` stamped with another
 * epoch.
 */
export function sendAuthenticatedMachineContext(
  ws: MachineContextSocket,
  context: { machineId: string; serverId: string; connectionEpochId?: string },
  capabilities: readonly string[] = serverMachineContextCapabilities(),
): void {
  const sendsEpoch = context.connectionEpochId !== undefined && capabilities.includes(SERVER_CAPABILITY_START_SPAWN_ERROR_V1);
  const message = {
    type: "machine:context",
    machineId: context.machineId,
    serverId: context.serverId,
    ...(capabilities.length > 0 ? { capabilities: [...capabilities] } : {}),
    ...(sendsEpoch ? { connectionEpochId: context.connectionEpochId } : {}),
  } satisfies ServerToMachineMessage;
  ws.send(JSON.stringify(message));
}
