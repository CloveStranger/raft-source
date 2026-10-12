import type { AgentMessage } from "@botiverse/raft-shared";
import type { AgentMessageDeliveryResult, DeliverMessageOptions } from "../services/agentOrchestrator";

/** Any double's deliverMessage: its own parameter types, called with production's arguments. */
type DeliveringStub = { deliverMessage: (agentId: string, message: never, options?: never) => unknown };
type ChannelDelivery = { agentId: string; message: AgentMessage; options?: DeliverMessageOptions };

/**
 * Gives a plain orchestrator test double the channel-batch surface production
 * calls: deliverMessagesOnChannel delivers each item through the double's own
 * deliverMessage (looked up at call time, so a test that swaps deliverMessage
 * later is still observed), and loadDeliveryGates reads nothing (null: each
 * delivery checks its own gates).
 */
export function withChannelDelivery<T extends DeliveringStub>(stub: T): T & {
  deliverMessagesOnChannel: (channelId: string, deliveries: ReadonlyArray<ChannelDelivery>) => Array<Promise<AgentMessageDeliveryResult>>;
  loadDeliveryGates: (channelId: string, agentIds: readonly string[]) => Promise<null>;
} {
  return Object.assign(stub, {
    deliverMessagesOnChannel: (_channelId: string, deliveries: ReadonlyArray<ChannelDelivery>) =>
      deliveries.map(({ agentId, message, options }) => {
        const deliver = stub.deliverMessage as unknown as (agentId: string, message: AgentMessage, options?: DeliverMessageOptions) => unknown;
        return Promise.resolve(deliver(agentId, message, options)) as Promise<AgentMessageDeliveryResult>;
      }),
    loadDeliveryGates: async () => null,
  });
}
