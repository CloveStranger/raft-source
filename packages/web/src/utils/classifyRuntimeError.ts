import type { MessageId } from "../i18n/messages";

// Runtime-error classification (@Wug boundary 2026-08-04): only enumerable,
// stable patterns are recognized and mapped to catalog copy; anything else
// stays null so the caller falls back to the generic message (or the raw
// diagnostic in the creator debug view). We never substring-translate
// arbitrary server English.

// `toolArgsInvalid` (task #1127) is reachable only from the daemon's typed
// carrier, never from `classifyRuntimeError` below: the upstream sentence is
// matched once in the daemon, and the web must not grow a second text matcher
// for the same fact.
export type RuntimeErrorKind = "notLoggedIn" | "notInstalled" | "authFailed" | "toolArgsInvalid";

const PATTERNS: readonly { kind: RuntimeErrorKind; re: RegExp }[] = [
  { kind: "notLoggedIn", re: /is not logged in/i },
  { kind: "notInstalled", re: /not installed/i },
  { kind: "authFailed", re: /(?:auth(?:entication|orization)? (?:failed|error|invalid)|invalid api key|unauthorized)/i },
];

export function classifyRuntimeError(message: string): RuntimeErrorKind | null {
  for (const { kind, re } of PATTERNS) {
    if (re.test(message)) return kind;
  }
  return null;
}

export const RUNTIME_ERROR_LABEL_ID: Record<RuntimeErrorKind, MessageId> = {
  notLoggedIn: "agent.runtimeError.notLoggedIn",
  notInstalled: "agent.runtimeError.notInstalled",
  authFailed: "agent.runtimeError.authFailed",
  toolArgsInvalid: "agent.runtimeError.toolArgsInvalid",
};

// task #735 — a runtime lookup failure (`runtime_not_found`) now discriminates
// WHY the lookup missed, on both the detect side (`unavailableReason`:
// not_installed/probe_timeout/probe_failed/permission_denied) and the launch
// side (`WindowsLaunchFailureReason`: not_on_path/lookup_timed_out/
// lookup_permission_denied/lookup_failed). Only a confirmed miss may keep the
// install-guidance copy; timeouts, permission denials and unresolved failures
// each get their own arm, and an absent reason (old daemon) is unresolved too
// — uncertainty never collapses into "install it".
export type RuntimeLookupDisplay = "confirmed_missing" | "timeout" | "permission_denied" | "unconfirmed";

export function runtimeLookupDisplayForReason(reason: string | null | undefined): RuntimeLookupDisplay {
  switch (reason) {
    // Detect: probe found no executable. Launch: the locator answered
    // CommandNotFoundException (exit 3) — a genuine miss, not a failed check.
    case "not_installed":
    case "not_on_path":
      return "confirmed_missing";
    case "probe_timeout":
    case "lookup_timed_out":
      return "timeout";
    case "permission_denied":
    case "lookup_permission_denied":
      return "permission_denied";
    // probe_failed / lookup_failed / absent (old daemon) / unknown value.
    default:
      return "unconfirmed";
  }
}

/** Catalog ids for the non-install arms; each site keeps its own confirmed-missing copy. */
export const RUNTIME_LOOKUP_DISPLAY_MESSAGE_ID: Record<Exclude<RuntimeLookupDisplay, "confirmed_missing">, MessageId> = {
  timeout: "agent.runtimeModels.runtimeLookupTimeout",
  permission_denied: "agent.runtimeModels.runtimeLookupPermissionDenied",
  unconfirmed: "agent.runtimeModels.runtimeLookupUnresolved",
};
