import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { HostedAgentModelView } from "@botiverse/raft-shared";
import api from "../src/api/client";
import { AgentHostedRuntimeModel, hostedRuntimeModelPath } from "../src/components/agent/AgentHostedRuntimeModel";
import { TestIntlProvider } from "./helpers/intl";

const originalGet = api.get;
const originalPut = api.put;

const VIEW: HostedAgentModelView = {
  models: [
    { id: "deepseek-flash", label: "DeepSeek Flash", provider: "deepseek" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", provider: "openai" },
  ],
  default: "deepseek-flash",
  defaultLabel: "DeepSeek Flash",
  model: "deepseek-flash",
  label: "DeepSeek Flash",
  source: "default",
  locked: false,
};

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.put = originalPut;
});

function mockGet(view: HostedAgentModelView | { status: number }) {
  const calls: string[] = [];
  api.get = (async (url: string) => {
    calls.push(url);
    if ("status" in view && !("models" in view)) throw { response: { status: view.status } };
    return { data: view };
  }) as typeof api.get;
  return calls;
}

function renderModel() {
  return render(<TestIntlProvider locale="en"><AgentHostedRuntimeModel agentId="agent-1" /></TestIntlProvider>);
}

async function pick(name: string) {
  const box = await screen.findByTestId("agent-hosted-runtime-model-select");
  fireEvent.focus(box);
  fireEvent.keyDown(box, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name }));
}

test("shows the provider's default as the current choice; picking a model PUTs its id and says it applies from the next turn", async () => {
  const gets = mockGet(VIEW);
  const puts: Array<{ url: string; body: unknown }> = [];
  api.put = (async (url: string, body: unknown) => {
    puts.push({ url, body });
    return { data: { ...VIEW, model: "gpt-5.6-luna", label: "GPT-5.6 Luna", source: "chosen" } };
  }) as typeof api.put;
  renderModel();
  const box = await screen.findByTestId("agent-hosted-runtime-model-select") as HTMLInputElement;
  assert.equal(gets[0], hostedRuntimeModelPath("agent-1"));
  assert.equal(box.value, "Default (DeepSeek Flash)");
  await pick("GPT-5.6 Luna");
  await waitFor(() => assert.equal(puts.length, 1));
  assert.deepEqual(puts[0], { url: "/agents/agent-1/hosted-runtime/model", body: { model: "gpt-5.6-luna" } });
  await waitFor(() => assert.match(screen.getByTestId("agent-hosted-runtime-model-notice").textContent ?? "", /from its next turn/));
  assert.equal(box.value, "GPT-5.6 Luna");
});

test("the pick shows at once while saving, and rolls back if the save fails", async () => {
  mockGet(VIEW);
  let finish: (() => void) | undefined;
  api.put = (() => new Promise((_resolve, reject) => { finish = () => reject({ response: { status: 502 } }); })) as typeof api.put;
  renderModel();
  const box = await screen.findByTestId("agent-hosted-runtime-model-select") as HTMLInputElement;
  await pick("GPT-5.6 Luna");
  await waitFor(() => assert.equal(box.value, "GPT-5.6 Luna", "optimistic while the PUT is in flight"));
  assert.match(screen.getByTestId("agent-hosted-runtime-model-notice").textContent ?? "", /Saving/);
  finish!();
  await waitFor(() => assert.equal(box.value, "Default (DeepSeek Flash)", "rolled back"));
  assert.match(screen.getByTestId("agent-hosted-runtime-model-notice").textContent ?? "", /could not be changed/);
});

test("choosing the default again sends model: null", async () => {
  mockGet({ ...VIEW, model: "gpt-5.6-luna", label: "GPT-5.6 Luna", source: "chosen" });
  const bodies: unknown[] = [];
  api.put = (async (_url: string, body: unknown) => { bodies.push(body); return { data: VIEW }; }) as typeof api.put;
  renderModel();
  await pick("Default (DeepSeek Flash)");
  await waitFor(() => assert.deepEqual(bodies, [{ model: null }]));
});

test("a locked model is read-only and says an administrator set it", async () => {
  mockGet({ ...VIEW, model: "openai/gpt-6", label: "GPT-6", source: "admin", locked: true });
  renderModel();
  const locked = await screen.findByTestId("agent-hosted-runtime-model-locked");
  assert.match(locked.textContent ?? "", /GPT-6/);
  assert.match(locked.textContent ?? "", /An administrator has set this agent's model/);
  assert.equal(screen.queryAllByTestId("agent-hosted-runtime-model-select").length, 0);
});

test("422 and 409 on save say why and reload what the provider has now", async () => {
  const gets = mockGet(VIEW);
  let status = 422;
  api.put = (async () => { throw { response: { status } }; }) as typeof api.put;
  renderModel();
  await pick("GPT-5.6 Luna");
  await waitFor(() => assert.match(screen.getByTestId("agent-hosted-runtime-model-notice").textContent ?? "", /no longer offered/));
  assert.equal(gets.length, 2, "the list is refreshed");
  status = 409;
  await pick("GPT-5.6 Luna");
  await waitFor(() => assert.match(screen.getByTestId("agent-hosted-runtime-model-notice").textContent ?? "", /was not saved/));
});

test("hidden when the agent is not hosted or not ready (4xx); a warning on provider failure", async () => {
  mockGet({ status: 409 });
  const { container } = renderModel();
  await waitFor(() => assert.equal(container.querySelectorAll('[data-testid="agent-hosted-runtime-model"]').length, 0));
  cleanup();
  mockGet({ status: 502 });
  renderModel();
  await screen.findByText(/could not be loaded/);
});
