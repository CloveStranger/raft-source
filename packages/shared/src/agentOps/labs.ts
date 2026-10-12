// Server Labs: list the server's labs, turn Labs access on or off (owner), and
// enroll in or leave an open lab (server settings authority). The Server
// decides from the agent's current role on every call. Writes are guarded by
// the Labs `version`: pass the one you read, or omit it and the operation
// reads the current version first (a concurrent change then still gets the
// Server's 409, `server_labs_version_conflict`).

import { z } from "zod";

import type { AgentApiClient, AgentApiClientFailure } from "../agentApiClient";
import type { AgentApiServerLabsMutationResponse, AgentApiServerLabsResponse } from "../agentApiContract";
import { raftToolNameFor, type RaftHintOptions } from "./hint";
import { failureFromClientResult, failureOutcome, opError, validateOpRequest, type RaftFailure, type RaftOutcome } from "./outcome";
import { requestSchema } from "./requestSchema";

export const listLabsRequestSchema = z.object({});

export interface SetLabsAccessRequest {
  enabled: boolean;
  expectedVersion?: number;
}

export const setLabsAccessRequestSchema = requestSchema<SetLabsAccessRequest>()(z.object({
  enabled: z.boolean().describe("true turns Labs access on for the server; false turns it off."),
  expectedVersion: z.number().int().nonnegative().optional().describe("The Labs version from the list you are acting on; pass it whenever you read the list earlier, so a change made since then is refused. Omitted, the current version is used and the last write wins."),
}));

export interface SetLabEnrollmentRequest {
  lab: string;
  enabled: boolean;
  expectedVersion?: number;
}

export const setLabEnrollmentRequestSchema = requestSchema<SetLabEnrollmentRequest>()(z.object({
  lab: z.string().describe("The lab's key, from the Labs list."),
  enabled: z.boolean().describe("true enrolls the server in the lab; false leaves it."),
  expectedVersion: z.number().int().nonnegative().optional().describe("The Labs version from the list you are acting on; pass it whenever you read the list earlier, so a change made since then is refused. Omitted, the current version is used and the last write wins."),
}));

/** An operation name as the caller sees it: the tool name in tool form. */
function opName(name: string, options: RaftHintOptions): string {
  return options.hints === "tool" ? raftToolNameFor(name) : name;
}

/** Next actions for the Labs refusal codes, used when the Server sends none. */
function labsRefusalNextAction(serverCode: string, options: RaftHintOptions): string | null {
  const list = `\`${opName("labs.list", options)}\``;
  switch (serverCode) {
    case "server_owner_required":
      return "Only the server owner can turn Labs access on or off; ask the owner.";
    case "server_admin_required":
      return "Changing lab enrollment needs the admin or owner role; ask a server owner or admin to do it, or to change your role.";
    case "server_labs_access_disabled":
      return `Labs access is off for this server; only the owner can turn it on (\`${opName("labs.setAccess", options)}\`).`;
    case "lab_not_open":
      return "This lab is not open for enrollment, so nobody can enroll now. Do not retry.";
    case "lab_not_found":
      return `Check the lab key with ${list}.`;
    case "server_labs_version_conflict":
      return `Labs changed while you were working. Run ${list}, check the change still makes sense, then retry.`;
    default:
      return null;
  }
}

/** A Labs refusal without the Server's own next action gets the one for its code. */
function labsFailure(result: AgentApiClientFailure, options: RaftHintOptions): RaftFailure {
  const failure = failureFromClientResult(result);
  const error = failure.error;
  if (!error.serverCode || error.nextAction !== opError(error.code).nextAction) return failure;
  const nextAction = labsRefusalNextAction(error.serverCode, options);
  return nextAction ? failureOutcome({ ...error, nextAction }) : failure;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

export function formatLabs(labs: AgentApiServerLabsResponse): string {
  const lines = [
    `Labs access: ${labs.accessEnabled ? "on" : "off"} (version ${labs.version}).`,
    `You can turn Labs access on or off: ${yesNo(labs.canManageAccess)}. You can change enrollments: ${yesNo(labs.canManageEnrollments)}.`,
  ];
  if (labs.labs.length === 0) {
    lines.push("No labs are listed.");
  } else {
    for (const lab of labs.labs) {
      lines.push(`- ${lab.labKey}: ${lab.name} (${lab.state}; enrolled: ${yesNo(lab.enrolled)}; in effect: ${yesNo(lab.effective)}). ${lab.description}`);
    }
  }
  return lines.join("\n");
}

export async function listLabs(
  client: Pick<AgentApiClient, "labs">,
  options: RaftHintOptions = {},
): Promise<RaftOutcome<AgentApiServerLabsResponse, "labs">> {
  const result = await client.labs.list();
  if (!result.ok) return labsFailure(result, options);
  return { ok: true, state: "labs", data: result.data, next: null, text: formatLabs(result.data) };
}

async function currentVersion(client: Pick<AgentApiClient, "labs">, expected: number | undefined, options: RaftHintOptions): Promise<number | RaftFailure> {
  if (expected !== undefined) return expected;
  const result = await client.labs.list();
  if (!result.ok) return labsFailure(result, options);
  return result.data.version;
}

function mutationOutcome(data: AgentApiServerLabsMutationResponse, done: string): RaftOutcome<AgentApiServerLabsMutationResponse, "updated" | "unchanged"> {
  return data.applied
    ? { ok: true, state: "updated", data, next: null, text: `${done}\n${formatLabs(data)}` }
    : { ok: true, state: "unchanged", data, next: null, text: `Nothing changed; it was already so.\n${formatLabs(data)}` };
}

export async function setLabsAccess(
  client: Pick<AgentApiClient, "labs">,
  request: SetLabsAccessRequest,
  options: RaftHintOptions = {},
): Promise<RaftOutcome<AgentApiServerLabsMutationResponse, "updated" | "unchanged">> {
  const invalid = validateOpRequest(setLabsAccessRequestSchema, request); if (invalid) return invalid;
  const version = await currentVersion(client, request.expectedVersion, options);
  if (typeof version !== "number") return version;
  const result = await client.labs.setAccess({ enabled: request.enabled, expectedVersion: version });
  if (!result.ok) return labsFailure(result, options);
  return mutationOutcome(result.data, `Turned Labs access ${request.enabled ? "on" : "off"}.`);
}

export async function setLabEnrollment(
  client: Pick<AgentApiClient, "labs">,
  request: SetLabEnrollmentRequest,
  options: RaftHintOptions = {},
): Promise<RaftOutcome<AgentApiServerLabsMutationResponse, "updated" | "unchanged">> {
  const invalid = validateOpRequest(setLabEnrollmentRequestSchema, request); if (invalid) return invalid;
  const lab = request.lab.trim();
  if (!lab) return failureOutcome(opError("INVALID_REQUEST", { message: "Pass the lab's key. Nothing was sent." }));
  const version = await currentVersion(client, request.expectedVersion, options);
  if (typeof version !== "number") return version;
  const result = await client.labs.setEnrollment({ labKey: lab }, { enabled: request.enabled, expectedVersion: version });
  if (!result.ok) return labsFailure(result, options);
  return mutationOutcome(result.data, request.enabled ? `Enrolled the server in ${lab}.` : `The server left ${lab}.`);
}
