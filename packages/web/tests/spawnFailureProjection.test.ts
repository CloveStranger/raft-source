import assert from "node:assert/strict";
import { createIntl } from "react-intl";
import { mergedMessages } from "../src/i18n/messages/index";
import { formatActivityTextDescriptor, formatSpawnFailureDetail, getActivityTextDescriptor } from "../src/utils/activity";
import { useAgentStore } from "../src/store/agentStore";

// task #1123 — the web must carry the daemon's typed spawn-failure reason and
// must not collapse a failed start into a bare "Offline".

test("offline + runtime_unavailable keeps the daemon's detail in the activity text", () => {
  const descriptor = getActivityTextDescriptor("offline", "Runtime start failed: model not found", "runtime_unavailable");
  assert.deepEqual(descriptor.primary, { raw: "Runtime start failed: model not found" });
  // A plain stop still uses the catalog copy.
  const stopped = getActivityTextDescriptor("offline", "", "stopped");
  assert.equal((stopped.primary as { id: string }).id, "activity.status.stoppedUnavailable");
});

test("model_not_found has dedicated copy in both catalogs that names the model", () => {
  for (const locale of ["en", "zh-cn"] as const) {
    const intl = createIntl({ locale, defaultLocale: "en", messages: mergedMessages(locale) });
    const text = formatActivityTextDescriptor(intl.formatMessage, {
      primary: { id: "activity.status.modelNotFound", values: { model: "claude-opus-5" } },
    });
    assert.ok(text.includes("claude-opus-5"), `${locale}: ${text}`);
    assert.ok(!text.includes("activity.status."), `${locale} copy must resolve`);
  }
});

test("the store keeps the spawnFailure carrier next to the activity state and clears it on the next plain activity", () => {
  const store = useAgentStore.getState();
  store.updateActivity(
    "agent-sf",
    "offline",
    "Runtime start failed",
    10,
    500,
    { launchId: "launch-1", clientSeq: 1 },
    "offline",
    "runtime_unavailable",
    { clientEventId: "evt-sf-1" },
    false,
    false,
    undefined,
    undefined,
    { reason: "model_not_found", model: "claude-opus-5" },
  );
  const state = useAgentStore.getState().agentActivities["agent-sf"];
  assert.equal(state?.detailKind, "runtime_unavailable");
  assert.deepEqual(state?.spawnFailure, { reason: "model_not_found", model: "claude-opus-5" });

  useAgentStore.getState().updateActivity("agent-sf", "working", "Running command", 11, 600, { launchId: "launch-2", clientSeq: 1 }, "working", "running_command");
  assert.equal(useAgentStore.getState().agentActivities["agent-sf"]?.spawnFailure, undefined, "a later plain activity drops the carrier");
});

test("a paused agent's failed start says restarts are paused and how to lift it, in both catalogs", () => {
  for (const locale of ["en", "zh-cn"] as const) {
    const intl = createIntl({ locale, defaultLocale: "en", messages: mergedMessages(locale) });
    const modelPaused = formatSpawnFailureDetail(intl.formatMessage, { reason: "model_not_found", model: "deepseek/deepseek-v4-flash", autoRestartPaused: true }, "daemon text");
    assert.ok(modelPaused?.includes("deepseek/deepseek-v4-flash"), `${locale}: ${modelPaused}`);
    assert.ok(modelPaused?.includes(locale === "en" ? "automatic restarts are paused" : "已暂停自动重启"), `${locale}: ${modelPaused}`);
    const genericPaused = formatSpawnFailureDetail(intl.formatMessage, { reason: "runtime_spawn_failed", autoRestartPaused: true }, "Runtime failed to start.");
    assert.ok(genericPaused?.startsWith("Runtime failed to start."), "other reasons keep the daemon's message, plus the pause");
    assert.ok(!modelPaused?.includes("activity.status.") && !genericPaused?.includes("activity.status."), `${locale} copy must resolve`);
  }
  const intl = createIntl({ locale: "en", defaultLocale: "en", messages: mergedMessages("en") });
  assert.equal(formatSpawnFailureDetail(intl.formatMessage, { reason: "runtime_spawn_failed" }, "x"), null, "not paused, no own copy: keep the daemon detail");
  assert.equal(formatSpawnFailureDetail(intl.formatMessage, undefined, "x"), null);
});

test("task #10: session_needs_reset has its own copy that points to Reset Session, never 'restart the agent'", () => {
  for (const locale of ["en", "zh-cn"] as const) {
    const intl = createIntl({ locale, defaultLocale: "en", messages: mergedMessages(locale) });
    for (const autoRestartPaused of [true, false]) {
      const text = formatSpawnFailureDetail(intl.formatMessage, { reason: "session_needs_reset", autoRestartPaused }, "daemon text");
      assert.ok(text && !text.includes("activity.status."), `${locale}: ${text}`);
      assert.ok(text.includes(locale === "en" ? "Reset Session & Restart" : "重置会话并重启"), `${locale}: ${text}`);
      assert.ok(!text.includes(locale === "en" ? "or restart the agent" : "手动重启 Agent 后恢复"), `${locale}: ${text}`);
    }
  }
});
