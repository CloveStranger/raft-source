import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AppAgentJwtSettings } from "@botiverse/raft-shared";
import { TestIntlProvider } from "./helpers/intl";
import { AgentJwtSettings } from "../src/components/settings/AgentJwtSettings";
import api from "../src/api/client";

const originalGet = api.get;
const originalPut = api.put;
const initial: AppAgentJwtSettings = { scope: "app", enabled: false, appEnabled: false, effectiveEnabled: false, canEnable: true, audience: "example-service", expiresIn: 300 };
afterEach(() => { cleanup(); api.get = originalGet; api.put = originalPut; });
function mount(canManage = true) { return render(<TestIntlProvider><AgentJwtSettings serverId="server-a" clientId="client-1" canManage={canManage} /></TestIntlProvider>); }

test("JWT switch saves the boolean decision and reloads the persisted response", async () => {
  let stored = { ...initial };
  const writes: object[] = [];
  api.get = (async (path: string) => { assert.equal(path, "/integrations/clients/client-1/agent-jwt"); return { data: stored }; }) as typeof api.get;
  api.put = (async (path: string, body: object) => {
    assert.equal(path, "/integrations/clients/client-1/agent-jwt");
    writes.push(body);
    stored = { ...initial, enabled: true, appEnabled: true, effectiveEnabled: true };
    return { data: stored };
  }) as typeof api.put;
  mount();
  const toggle = await screen.findByRole("switch");
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  fireEvent.click(toggle);
  fireEvent.click(screen.getByRole("button", { name: "Save JWT settings" }));
  await waitFor(() => assert.deepEqual(writes, [{ enabled: true }]));
  await waitFor(() => assert.equal((screen.getByRole("button", { name: "Save JWT settings" }) as HTMLButtonElement).disabled, true));
  cleanup(); mount();
  assert.equal((await screen.findByRole("switch")).getAttribute("aria-checked"), "true");
});

test("installation consent cannot enable before publisher support; ordinary members cannot save", async () => {
  api.get = (async () => ({ data: { ...initial, scope: "installation", canEnable: false } })) as typeof api.get;
  let writes = 0;
  api.put = (async () => { writes++; throw new Error("unexpected write"); }) as typeof api.put;
  mount();
  assert.equal((await screen.findByRole("switch")).getAttribute("aria-disabled"), "true");
  assert.ok(screen.getByText("The App must support JWTs and this installation must be active before access can be enabled."));
  cleanup(); mount(false);
  assert.equal((await screen.findByRole("switch")).getAttribute("aria-disabled"), "true");
  assert.ok(screen.queryByRole("button", { name: "Save JWT settings" }) === null);
  assert.equal(writes, 0);
});

test("failed JWT save leaves a visible retry and does not report a saved state", async () => {
  api.get = (async () => ({ data: initial })) as typeof api.get;
  api.put = (async () => { throw new Error("synthetic failure"); }) as typeof api.put;
  mount();
  fireEvent.click(await screen.findByRole("switch"));
  fireEvent.click(screen.getByRole("button", { name: "Save JWT settings" }));
  await screen.findByText("Could not load or save JWT settings. Retry before relying on this change.");
  assert.equal((screen.getByRole("button", { name: "Save JWT settings" }) as HTMLButtonElement).disabled, false);
});


test("the same App reloads per Server and pins saves to that Server while late old reads are ignored", async () => {
  let resolveOld: (value: { data: AppAgentJwtSettings }) => void = () => {};
  const oldRead = new Promise<{ data: AppAgentJwtSettings }>((resolve) => { resolveOld = resolve; });
  api.get = (async (_path: string, config?: { headers?: Record<string, string> }) => {
    return config?.headers?.["X-Server-Id"] === "server-a" ? oldRead : { data: { ...initial, scope: "installation", appEnabled: true } };
  }) as typeof api.get;
  const writes: Array<{ server: string | undefined; body: object }> = [];
  api.put = (async (_path: string, body: object, config?: { headers?: Record<string, string> }) => {
    writes.push({ server: config?.headers?.["X-Server-Id"], body });
    return { data: { ...initial, scope: "installation", appEnabled: true, enabled: true, effectiveEnabled: true } };
  }) as typeof api.put;
  const view = mount();
  view.rerender(<TestIntlProvider><AgentJwtSettings serverId="server-b" clientId="client-1" canManage /></TestIntlProvider>);
  await screen.findByText("Allow Agent JWTs on this Server");
  resolveOld({ data: { ...initial, enabled: true, appEnabled: true, effectiveEnabled: true } });
  await waitFor(() => assert.equal(screen.getByRole("switch").getAttribute("aria-checked"), "false"));
  fireEvent.click(screen.getByRole("switch"));
  fireEvent.click(screen.getByRole("button", { name: "Save JWT settings" }));
  await waitFor(() => assert.deepEqual(writes, [{ server: "server-b", body: { enabled: true } }]));
});

test("switching Server clears the previous approval while the new Server is still loading", async () => {
  let resolveNext: (value: { data: AppAgentJwtSettings }) => void = () => {};
  const nextRead = new Promise<{ data: AppAgentJwtSettings }>((resolve) => { resolveNext = resolve; });
  api.get = (async (_path: string, config?: { headers?: Record<string, string> }) => config?.headers?.["X-Server-Id"] === "server-a"
    ? { data: { ...initial, enabled: true, appEnabled: true, effectiveEnabled: true } }
    : nextRead) as typeof api.get;
  const view = mount();
  assert.equal((await screen.findByRole("switch")).getAttribute("aria-checked"), "true");
  view.rerender(<TestIntlProvider><AgentJwtSettings serverId="server-b" clientId="client-1" canManage /></TestIntlProvider>);
  assert.equal(screen.queryByRole("switch") === null, true, "old Server's approval is not actionable in the new context");
  resolveNext({ data: { ...initial, scope: "installation", appEnabled: true } });
  assert.equal((await screen.findByRole("switch")).getAttribute("aria-checked"), "false");
});
