/**
 * The model of a hosted (provider-backed) agent, proxied to its provider
 * (antiproton docs/agent-surface.md, "The agent's model"):
 *
 *   GET {base}/provision/models?raftServerId=                         the offered models and the default
 *   GET {base}/provision/agents/by-raft-agent/:raftAgentId/model?raftServerId=   what the next turn runs on
 *   PUT  same, {model: id | null}                                     pick an offered model, or follow the default
 *
 * A pick takes effect from the agent's next turn; nothing restarts. The
 * provider answers 422 for an id it does not offer and 409 `model_locked`
 * while an administrator's row decides the model. Only an `active`
 * provisioning row is served. Outcomes are classified, never thrown.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { HostedAgentModelView } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agentRuntimeProvisions } from "../db/schema";
import {
  providerAgentModelByRaftIdPath,
  providerModelsPath,
  providerRequest,
  resolveProviderConfig,
  type ProviderCallResult,
  type ProviderErrorBody,
} from "./agentRuntimeProviderService";

export type HostedAgentModelResult =
  | { kind: "ok"; view: HostedAgentModelView }
  /** Not provisioned, not active yet, or the provider is not configured on this deployment. */
  | { kind: "unavailable"; reason: string }
  /** 422: the id is not offered (or not a valid value). */
  | { kind: "not_listed"; error: ProviderErrorBody | null }
  /** 409: an administrator's row decides this agent's model. */
  | { kind: "locked"; error: ProviderErrorBody | null }
  | { kind: "bad_request"; error: ProviderErrorBody | null }
  | { kind: "not_found"; error: ProviderErrorBody | null }
  | { kind: "upstream_unavailable"; reason: string; httpStatus: number | null };

// Minimal shape checks; extra fields are dropped.
const modelsSchema = z.object({
  models: z.array(z.object({ id: z.string(), label: z.string(), provider: z.string().catch("") })),
  default: z.string().nullable().catch(null),
  defaultLabel: z.string().nullable().catch(null),
});

const agentModelSchema = z.object({
  model: z.string().nullable(),
  label: z.string().nullable().catch(null),
  source: z.enum(["default", "chosen", "admin"]).catch("default"),
  locked: z.boolean().catch(false),
});

type Failure = Exclude<HostedAgentModelResult, { kind: "ok" }>;

function classify<T>(result: ProviderCallResult, schema: z.ZodType<T>): { ok: true; body: T } | { ok: false; failure: Failure } {
  if (result.kind === "network") return { ok: false, failure: { kind: "upstream_unavailable", reason: result.code, httpStatus: null } };
  if (result.status === 422) return { ok: false, failure: { kind: "not_listed", error: result.error } };
  if (result.status === 409) return { ok: false, failure: { kind: "locked", error: result.error } };
  if (result.status === 400) return { ok: false, failure: { kind: "bad_request", error: result.error } };
  if (result.status === 404) return { ok: false, failure: { kind: "not_found", error: result.error } };
  if (result.status < 200 || result.status >= 300) {
    return { ok: false, failure: { kind: "upstream_unavailable", reason: result.error?.code ?? `http_${result.status}`, httpStatus: result.status } };
  }
  const parsed = schema.safeParse(result.body);
  if (!parsed.success) return { ok: false, failure: { kind: "upstream_unavailable", reason: "invalid_response", httpStatus: result.status } };
  return { ok: true, body: parsed.data };
}

async function hostedTarget(agentId: string): Promise<
  { ok: true; config: { baseUrl: string; token: string }; serverId: string } | { ok: false; failure: Failure }
> {
  const [row] = await getDb().select().from(agentRuntimeProvisions)
    .where(eq(agentRuntimeProvisions.agentId, agentId)).limit(1);
  if (!row) return { ok: false, failure: { kind: "unavailable", reason: "not_provisioned" } };
  if (row.state !== "active") return { ok: false, failure: { kind: "unavailable", reason: `state_${row.state}` } };
  const config = resolveProviderConfig(row.provider);
  if (!config) return { ok: false, failure: { kind: "unavailable", reason: "provider_not_configured" } };
  return { ok: true, config, serverId: row.serverId };
}

async function withModels(
  target: { config: { baseUrl: string; token: string }; serverId: string },
  agentModelCall: Promise<ProviderCallResult>,
): Promise<HostedAgentModelResult> {
  const [models, agentModel] = await Promise.all([
    providerRequest(target.config, "GET", providerModelsPath(target.serverId)),
    agentModelCall,
  ]);
  // The agent's answer decides the outcome first: a refused pick is reported as such.
  const agent = classify(agentModel, agentModelSchema);
  if (!agent.ok) return agent.failure;
  const list = classify(models, modelsSchema);
  if (!list.ok) return list.failure;
  return {
    kind: "ok",
    view: {
      models: list.body.models,
      default: list.body.default,
      defaultLabel: list.body.defaultLabel,
      model: agent.body.model,
      label: agent.body.label,
      source: agent.body.source,
      locked: agent.body.locked,
    },
  };
}

export async function getHostedAgentModel(agentId: string): Promise<HostedAgentModelResult> {
  const target = await hostedTarget(agentId);
  if (!target.ok) return target.failure;
  return withModels(target, providerRequest(target.config, "GET", providerAgentModelByRaftIdPath(agentId, target.serverId)));
}

/** `model: null` follows the provider's default. */
export async function setHostedAgentModel(agentId: string, model: string | null): Promise<HostedAgentModelResult> {
  const target = await hostedTarget(agentId);
  if (!target.ok) return target.failure;
  return withModels(target, providerRequest(target.config, "PUT", providerAgentModelByRaftIdPath(agentId, target.serverId), { body: { model } }));
}
