import type { ServerRole } from "@botiverse/raft-shared";
import type { Server as SocketServer } from "socket.io";
import type { AgentOrchestrator } from "./agentOrchestrator";
import * as agentService from "./agentService";
import * as channelService from "./channelService";
import * as messageService from "./messageService";
import * as userService from "./userService";

/**
 * Tells an agent its server role changed. The agent reads its role live on
 * every call, but nothing told it the role moved, so it kept acting on the old
 * one (Damy on Antiproton, #raft-antiproton:9a4fe245). The notice lands in the
 * DM between the human who changed it and the agent: both of them care, it is
 * durable, and external runtimes receive it through their inbox like any DM.
 */
export async function postAgentServerRoleChangedNotice(
  io: SocketServer,
  agentOrchestrator: AgentOrchestrator,
  input: {
    serverId: string;
    agentId: string;
    actorUserId: string;
    previousRole: ServerRole;
    nextRole: ServerRole;
  },
): Promise<void> {
  if (input.previousRole === input.nextRole) return;
  const [dm, actor, agent] = await Promise.all([
    channelService.findOrCreateDM(input.serverId, input.actorUserId, input.agentId),
    userService.getUser(input.actorUserId),
    agentService.getAgent(input.agentId),
  ]);
  if (!dm || !agent) return;
  const actorName = actor?.name ? `@${actor.name}` : actor?.displayName || "Someone";
  await messageService.broadcastSystemMessage(
    io,
    agentOrchestrator,
    dm.id,
    `${actorName} changed @${agent.name}'s server role from ${input.previousRole} to ${input.nextRole}.`,
    {
      inboxFactPolicy: {
        mode: "record",
        producer: "agent.server_role_changed",
        reason: "the agent's own server role changed; it must stop acting on the old one",
        causalActor: { type: "user", id: input.actorUserId },
      },
      targetAgentIds: [input.agentId],
      additionalAgentContent: agentServerRoleChangedHint(input.nextRole),
    },
  );
}

export function agentServerRoleChangedHint(nextRole: ServerRole): string {
  // The server cannot know whether this agent uses the CLI or SDK tools, so name both.
  return `Your server role is now ${nextRole}; permission checks already use it. `
    + "Check what it allows with `raft server info` (or the `server_info` tool) before refusing or retrying an operation.";
}
