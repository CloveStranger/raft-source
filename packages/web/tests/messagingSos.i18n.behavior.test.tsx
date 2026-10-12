import assert from "node:assert/strict";
import { createIntl } from "react-intl";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { mergedMessages } from "../src/i18n/messages";
import SOSDialog from "../src/components/message/SOSDialog";
import api from "../src/api/client";
import { TestIntlProvider } from "./helpers/intl";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

const originalApiPost = api.post;

afterEach(() => {
  cleanup();
  api.post = originalApiPost;
});

test("catalog pins SOS dialog MessageIds with Chinese and ICU", () => {
  assert.equal(en["message.sos.stopAllAgents"], "Stop All Agents");
  assert.equal(en["message.sos.stopAction"], "Stop");
  assert.equal(en["message.sos.agentsStopped"], "Agents Stopped");
  assert.equal(
    en["message.sos.confirmWarning"],
    "All running agents in #{channel} will stop immediately. You can provide new guidance before resuming them.",
  );
  assert.equal(en["message.sos.allStopped"], "All agents have been stopped.");
  assert.equal(
    en["message.sos.guidanceHint"],
    "Provide new guidance or corrections. All agents will see this when they resume.",
  );
  assert.equal(
    en["message.sos.guidancePlaceholder"],
    "e.g. Stop modifying the database schema — focus only on the frontend changes I described…",
  );
  assert.equal(en["message.sos.keepStopped"], "Keep Stopped");
  assert.equal(en["message.sos.resumeAll"], "Resume All");
  assert.equal(en["message.sos.stopping"], "Stopping…");
  assert.equal(en["message.sos.resuming"], "Resuming…");
  assert.match(en["message.sos.confirmWarning"], /\{channel\}/);
  assert.match(zh["message.sos.confirmWarning"], /\{channel\}/);
  assert.match(zh["message.sos.stopAllAgents"], /\p{Script=Han}/u);
  assert.notEqual(zh["message.sos.allStopped"], en["message.sos.allStopped"]);
});

test("SOS dialog ids format under zh-cn", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  assert.equal(
    zhIntl.formatMessage({ id: "message.sos.confirmWarning" }, { channel: "ops" }),
    zh["message.sos.confirmWarning"].replace("{channel}", "ops"),
  );
  assert.doesNotMatch(zhIntl.formatMessage({ id: "message.sos.resumeAll" }), /Resume All/);
});

test("SOSDialog renders its real confirmation surface in zh-cn", () => {
  render(
    <TestIntlProvider locale="zh-cn">
      <SOSDialog channelId="channel-1" channelName="紧急频道" onClose={() => undefined} />
    </TestIntlProvider>,
  );

  assert.equal(screen.getByRole("heading").textContent, zh["message.sos.stopAllAgents"]);
  assert.equal(
    document.querySelector('[data-slot="sos-dialog-content"]')?.textContent,
    zh["message.sos.confirmWarning"].replace("{channel}", "紧急频道"),
  );
  assert.ok(screen.getByRole("button", { name: zh["common.confirm.cancel"] }));
  const stop = screen.getByRole("button", { name: zh["message.sos.stopAction"] });
  assert.match(stop.className, /bg-brutal-orange/);
  assert.doesNotMatch(stop.textContent ?? "", /Stop All Agents/);
});

test("SOSDialog stays open and says so when an agent was still starting and missed the guidance", async () => {
  const posts: string[] = [];
  api.post = (async (url: string) => {
    posts.push(url);
    if (url.endsWith("/resume-all-agents")) {
      return { data: { ok: false, started: 1, total: 2, results: [{ agentId: "a", ok: true }, { agentId: "b", ok: false, reason: "start_in_flight" }] } };
    }
    return { data: { ok: true } };
  }) as typeof api.post;
  let closed = 0;
  render(
    <TestIntlProvider locale="en">
      <SOSDialog channelId="channel-1" channelName="ops" onClose={() => { closed += 1; }} />
    </TestIntlProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: en["message.sos.stopAction"] }));
  const guidance = await screen.findByPlaceholderText(en["message.sos.guidancePlaceholder"]);
  fireEvent.change(guidance, { target: { value: "focus on the frontend" } });
  fireEvent.click(screen.getByRole("button", { name: en["message.sos.resumeAll"] }));

  await waitFor(() => assert.ok(document.querySelector('[data-slot="sos-resume-shortfall"]')));
  assert.match(
    document.querySelector('[data-slot="sos-resume-shortfall"]')?.textContent ?? "",
    /1 agent is still starting and did not get your guidance/,
  );
  assert.equal(closed, 0, "the dialog stays open so the guidance can be sent again");
  assert.equal((screen.getByPlaceholderText(en["message.sos.guidancePlaceholder"]) as HTMLTextAreaElement).value, "focus on the frontend");
  assert.deepEqual(posts, ["/channels/channel-1/stop-all-agents", "/channels/channel-1/resume-all-agents"]);
});

test("SOSDialog retries only the agents that missed the guidance", async () => {
  const resumeBodies: unknown[] = [];
  api.post = (async (url: string, body?: unknown) => {
    if (!url.endsWith("/resume-all-agents")) return { data: { ok: true } };
    resumeBodies.push(body);
    return resumeBodies.length === 1
      ? { data: { ok: false, started: 1, total: 2, results: [{ agentId: "a", ok: true }, { agentId: "b", ok: false, reason: "start_in_flight" }] } }
      : { data: { ok: true, started: 1, total: 1, results: [{ agentId: "b", ok: true }] } };
  }) as typeof api.post;
  let closed = 0;
  render(
    <TestIntlProvider locale="en">
      <SOSDialog channelId="channel-1" channelName="ops" onClose={() => { closed += 1; }} />
    </TestIntlProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: en["message.sos.stopAction"] }));
  fireEvent.change(await screen.findByPlaceholderText(en["message.sos.guidancePlaceholder"]), { target: { value: "go" } });
  fireEvent.click(screen.getByRole("button", { name: en["message.sos.resumeAll"] }));
  await waitFor(() => assert.ok(document.querySelector('[data-slot="sos-resume-shortfall"]')));

  fireEvent.click(screen.getByRole("button", { name: en["message.sos.resumeAll"] }));
  await waitFor(() => assert.equal(closed, 1));
  assert.equal(resumeBodies.length, 2);
  assert.equal((resumeBodies[0] as { agentIds?: string[] }).agentIds, undefined, "the first resume goes to every agent");
  assert.deepEqual((resumeBodies[1] as { agentIds?: string[] }).agentIds, ["b"], "the retry goes only to the agent that missed it");
});

test("SOSDialog closes when every agent resumed", async () => {
  api.post = (async (url: string) => (url.endsWith("/resume-all-agents")
    ? { data: { ok: true, started: 1, total: 1, results: [{ agentId: "a", ok: true }] } }
    : { data: { ok: true } })) as typeof api.post;
  let closed = 0;
  render(
    <TestIntlProvider locale="en">
      <SOSDialog channelId="channel-1" channelName="ops" onClose={() => { closed += 1; }} />
    </TestIntlProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: en["message.sos.stopAction"] }));
  fireEvent.change(await screen.findByPlaceholderText(en["message.sos.guidancePlaceholder"]), { target: { value: "go" } });
  fireEvent.click(screen.getByRole("button", { name: en["message.sos.resumeAll"] }));
  await waitFor(() => assert.equal(closed, 1));
});
