import "./helpers/domSetup";

import assert from "node:assert/strict";
import { createIntl } from "react-intl";
import type { IntlShape } from "react-intl";

import { runtimeModelSourceStatusForTest } from "../src/components/agent/RuntimeConfigFields";
import type { RuntimeModelSourceState } from "../src/hooks/useRuntimeModels";
import { mergedMessages } from "../src/i18n/messages";
import type { RuntimeModelDetectionLookupReason } from "@botiverse/raft-shared";

// task #735 behavior teeth for the detect-side consumption site
// (RuntimeConfigFields model-source status): a `runtime_not_found` lookup
// discriminates WHY it missed. Only a confirmed miss keeps the install
// guidance; every other arm — and an old daemon with no reason — must never
// read as "install it". Copy is Cat's ruling on task #735 rev10.

const en = createIntl({ locale: "en", defaultLocale: "en", messages: mergedMessages("en") });
const zh = createIntl({ locale: "zh-cn", defaultLocale: "en", messages: mergedMessages("zh-cn") });

function statusText(intl: IntlShape, reason?: RuntimeModelDetectionLookupReason): string {
  const source: RuntimeModelSourceState = {
    kind: "error",
    retryable: true,
    code: "runtime_not_found",
    ...(reason ? { reason } : {}),
  };
  return String(runtimeModelSourceStatusForTest(intl, "codex", source));
}

test("a confirmed miss keeps the install guidance, in both locales", () => {
  assert.equal(statusText(en, "not_installed"), "Codex CLI was not found on this Computer. Install it, then retry.");
  assert.equal(statusText(zh, "not_installed"), "此 Computer 未找到 Codex CLI。请安装后重试。");
});

test("a timed-out lookup gets the timeout arm, never the install guidance", () => {
  assert.equal(
    statusText(en, "probe_timeout"),
    "Checking for Codex CLI on this Computer timed out. Retry, or check this Computer's status.",
  );
  assert.equal(
    statusText(zh, "probe_timeout"),
    "检查此 Computer 上的 Codex CLI 超时。请重试，或查看此 Computer 的状态。",
  );
});

test("a denied lookup gets the permission arm, never the install guidance", () => {
  assert.equal(
    statusText(en, "permission_denied"),
    "Could not check for Codex CLI on this Computer: permission denied. Check permissions on that machine, then retry.",
  );
  assert.equal(
    statusText(zh, "permission_denied"),
    "无法检查此 Computer 上的 Codex CLI：权限被拒绝。请检查那台机器的权限后重试。",
  );
});

test("an unresolved lookup failure gets the neutral arm, never the install guidance", () => {
  assert.equal(
    statusText(en, "probe_failed"),
    "Could not confirm whether Codex CLI is available on this Computer. Retry, or check this Computer's status.",
  );
  assert.equal(
    statusText(zh, "probe_failed"),
    "无法确认此 Computer 上是否有 Codex CLI。请重试，或查看此 Computer 的状态。",
  );
});

test("old-daemon compat: code present with NO reason is the neutral arm", () => {
  const neutralEn = "Could not confirm whether Codex CLI is available on this Computer. Retry, or check this Computer's status.";
  const neutralZh = "无法确认此 Computer 上是否有 Codex CLI。请重试，或查看此 Computer 的状态。";
  assert.equal(statusText(en), neutralEn);
  assert.equal(statusText(zh), neutralZh);
  // The neutral arm must not collapse back into install guidance.
  assert.notEqual(statusText(en), "Codex CLI was not found on this Computer. Install it, then retry.");
});
