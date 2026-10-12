import assert from "node:assert/strict";

import { classifyRuntimeError, RUNTIME_LOOKUP_DISPLAY_MESSAGE_ID, runtimeLookupDisplayForReason } from "../src/utils/classifyRuntimeError";

// Runtime-error sentinel teeth (@Wug 2026-08-04): only enumerable stable
// patterns classify; unknown text stays null so the caller falls back without
// mistranslating or swallowing.

test("known runtime error patterns classify to their kinds", () => {
  assert.equal(classifyRuntimeError("Claude Code is not logged in on this machine. Please log in locally."), "notLoggedIn");
  assert.equal(classifyRuntimeError("Codex CLI is not installed on this computer."), "notInstalled");
  assert.equal(classifyRuntimeError("Authentication failed. Check your credentials."), "authFailed");
  assert.equal(classifyRuntimeError("invalid API key"), "authFailed");
});

test("unknown runtime error text stays null (never mistranslated)", () => {
  assert.equal(classifyRuntimeError("The daemon lost its connection to the workspace broker."), null);
  assert.equal(classifyRuntimeError(""), null);
  // A near-miss must not over-match: "installed" alone is not "not installed".
  assert.equal(classifyRuntimeError("The runtime was installed but is not responding."), null);
});

// task #735 — the lookup-reason split shared by the detect (runtime-models
// source state) and launch (spawn-failure carrier) consumption sites.

test("task #735: both reason vocabularies map to the same display arms", () => {
  // Only a confirmed miss may keep install guidance.
  assert.equal(runtimeLookupDisplayForReason("not_installed"), "confirmed_missing");
  assert.equal(runtimeLookupDisplayForReason("not_on_path"), "confirmed_missing");
  // The check itself never answered.
  assert.equal(runtimeLookupDisplayForReason("probe_timeout"), "timeout");
  assert.equal(runtimeLookupDisplayForReason("lookup_timed_out"), "timeout");
  assert.equal(runtimeLookupDisplayForReason("permission_denied"), "permission_denied");
  assert.equal(runtimeLookupDisplayForReason("lookup_permission_denied"), "permission_denied");
  assert.equal(runtimeLookupDisplayForReason("probe_failed"), "unconfirmed");
  assert.equal(runtimeLookupDisplayForReason("lookup_failed"), "unconfirmed");
});

test("task #735: an absent (old daemon) or unknown reason is unresolved, never a confirmed miss", () => {
  assert.equal(runtimeLookupDisplayForReason(undefined), "unconfirmed");
  assert.equal(runtimeLookupDisplayForReason(null), "unconfirmed");
  assert.equal(runtimeLookupDisplayForReason("some_future_reason"), "unconfirmed");
});

test("task #735: every non-install arm resolves to agent.runtimeModels.* catalog copy", () => {
  assert.deepEqual(RUNTIME_LOOKUP_DISPLAY_MESSAGE_ID, {
    timeout: "agent.runtimeModels.runtimeLookupTimeout",
    permission_denied: "agent.runtimeModels.runtimeLookupPermissionDenied",
    unconfirmed: "agent.runtimeModels.runtimeLookupUnresolved",
  });
});
