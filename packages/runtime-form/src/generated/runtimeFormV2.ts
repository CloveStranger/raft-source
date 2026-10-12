// Generated from packages/runtime-form/contract/runtime-form-v2.contract.json (sha256 8b82ac6e39a87e8d). Do not edit.
// Every type is open: a receiver must ignore keys it does not know.

/** Response of GET /api/servers/:id/machines/:machineId/runtime-forms/v2/:runtimeId (create), or of GET /api/agents/:id/runtime-form (edit, with `values`: the agent's current field values; writeOnly fields are never included). */
export interface RuntimeFormV2Definition {
  protocolVersion: 2;
  runtimeId: string;
  schemaVersion: string;
  dataSchema: RuntimeFormV2DataSchema;
  uiSchema?: RuntimeFormV2UiSchema;
  optionSources?: Record<string, RuntimeFormV2OptionSourceRef>;
  /** Client capabilities this form needs beyond the base v2 renderer. Absent or null means []. A client that sees an entry it does not implement, a value that is not an array, or a non-string entry must treat the whole v2 form as unavailable and fall back to its v1/legacy form; it must never render a partial v2 form. Names (frozen): `select.custom_value` (OptionSource.customValueAllowed), `choice.labels` (FieldCopy.choices), `option_source.status` (OptionSource.status/reason/retryable), `provider.saved_connection` (Option.connectionId/underlyingProviderId/group/unavailable: saved provider connection options in a provider source; the client must render the saved group, keep connection-owned fields (the writeOnly secret and any gateway URL/capability field) out of formValues entirely — never as empty strings — restore the direct schema's own visibility/required rules for them when the selection moves off a connection, and never submit an apiKey for a connection selection). A form lists a name only when it uses that feature; the server never sends those fields to a form that does not list the name. */
  requiredClientCapabilities?: string[];
  /** Opaque token identifying this exact form build (entry version + relevant server flags + scope). Sent only on the v2 form endpoints. A client that fetches option sources for this form should pass it back as ?formRevision=<token>; see OptionSource for the three outcomes. Clients that do not know it keep working: the parameter is optional. */
  revision?: string;
  values?: Record<string, unknown>;
  /** Edit only (sent with `values`). Keyed by the pointer of a writeOnly field (e.g. `/apiKey`); the value lists the pointers of the fields the stored secret is bound to (e.g. `["/provider", "/apiUrl"]`). On edit a blank writeOnly field keeps the stored secret only while every listed field still equals its value in `values`. Comparison: both sides as strings (absent = ""), surrounding whitespace trimmed and trailing `/` characters removed, then exact. A listed field that is currently hidden by `visibility` is not compared. When a listed field differs and the secret is blank (and visible), the client must treat the secret as required and block saving, saying a new secret is needed; the server refuses that save anyway (`api_key_required` at the field). Absent: a blank writeOnly field always means keep. A secret pointer or listed pointer naming no field is ignored. Optional and advisory: no requiredClientCapabilities entry; a client that ignores it still gets the server's refusal. */
  writeOnlyKeepRequiresUnchanged?: Record<string, string[]>;
  [key: string]: unknown;
}

export interface RuntimeFormV2DataSchema {
  type: "object";
  required?: string[];
  properties: Record<string, RuntimeFormV2FieldSchema>;
  [key: string]: unknown;
}

/** Render by `type` (with x-optionSource or x-optionsFrom), never by field name. An unknown `type` is unsupported: skip it if optional, block saving if required. */
export interface RuntimeFormV2FieldSchema {
  type: string;
  title?: string;
  minLength?: number;
  format?: string;
  writeOnly?: boolean;
  "x-optionSource"?: string;
  "x-optionsFrom"?: RuntimeFormV2OptionsFrom;
  /** capability `provider.saved_connection`. True on a field whose value a selected saved provider connection owns (the writeOnly secret, a gateway URL/capability field). While the field that offers connection options holds a connection selection, a client renders this field disabled with a placeholder, treats it as not required, and keeps it out of formValues entirely (never an empty string); moving the selection off a connection restores this field's own visibility and required rules and clears its value. Sent only to forms that declare the capability. */
  "x-connectionOwned"?: boolean;
  /** JSON Schema allows a boolean (`false`) or a value schema (`{"type": "string"}` for a key-value map); clients must accept both. */
  additionalProperties?: unknown;
  [key: string]: unknown;
}

/** Choices derived from the option currently selected in another field: that option's `attribute` (a string list) are the choices, and its `defaultAttribute` (if any) is the default. Example: Kimi reasoning effort follows the selected model. */
export interface RuntimeFormV2OptionsFrom {
  field: string;
  attribute: string;
  defaultAttribute?: string;
  [key: string]: unknown;
}

export interface RuntimeFormV2UiSchema {
  order?: string[];
  layout?: RuntimeFormV2Layout;
  visibility?: RuntimeFormV2VisibilityRule[];
  localization?: Record<string, RuntimeFormV2FieldCopy>;
  [key: string]: unknown;
}

export interface RuntimeFormV2Layout {
  advanced?: string[];
  [key: string]: unknown;
}

/** Show the field at `pointer` only when the field at when.pointer has one of when.in. */
export interface RuntimeFormV2VisibilityRule {
  pointer: string;
  when: RuntimeFormV2VisibilityCondition;
  [key: string]: unknown;
}

export interface RuntimeFormV2VisibilityCondition {
  pointer: string;
  in: string[];
  [key: string]: unknown;
}

export interface RuntimeFormV2FieldCopy {
  label?: string;
  hint?: string;
  placeholder?: string;
  /** capability `choice.labels`. Display copy for the choices of a `select` or `derived_select` field, keyed by option value. Label priority: choices[value].label, else the option's own `label`, else the raw value; `description` comes only from here. Keys that match no option are ignored; an option without a key falls back per that priority. */
  choices?: Record<string, RuntimeFormV2ChoiceCopy>;
  [key: string]: unknown;
}

/** Copy for one choice (FieldCopy.choices, capability `choice.labels`). */
export interface RuntimeFormV2ChoiceCopy {
  label: string;
  description?: string;
  [key: string]: unknown;
}

/** Choices for the field at `pointer`, loaded from .../runtime-forms/v2/:runtimeId/option-sources/:sourceId. */
export interface RuntimeFormV2OptionSourceRef {
  sourceId: string;
  kind: "select" | "dependent_select";
  pointer: string;
  dependsOn?: string;
  [key: string]: unknown;
}

/** Response of the option-sources endpoint. select: options + defaultValue. dependent_select: per-value lists keyed by the value of dependsOn. `customValueAllowed`, `status`, `reason` and `retryable` are sent only on the v2 endpoint and only to forms that list the matching capability (`select.custom_value`, `option_source.status`); a form without the capability gets the source exactly as before. Form-consistency parameter `?formRevision=<token>` (Definition.revision), optional, three outcomes: (1) absent — the source answers with the plain direct-option protocol and NEVER includes saved-connection options (Option.connectionId) or connection-keyed model maps, so pre-existing clients keep working unchanged; (2) present and matching the server's current build — the source answers within the capability range the form declared; (3) present and not matching — HTTP 409 with code `form_revision_stale` and recovery `refetch_form`; the client must refetch the whole form and must never merge new options into a stale form. The revision guards form consistency only; authorization and connection state are re-checked on every source request and again on save. */
export interface RuntimeFormV2OptionSource {
  sourceId: string;
  kind: "select" | "dependent_select";
  pointer: string;
  dependsOn?: string;
  options?: RuntimeFormV2Option[];
  defaultValue?: string;
  optionsByValue?: Record<string, RuntimeFormV2Option[]>;
  defaultValueByValue?: Record<string, string>;
  customValueAllowedByValue?: Record<string, boolean>;
  /** capability `select.custom_value`; meaningful only for kind `select` (dependent_select keeps customValueAllowedByValue). true: render a combobox (pick a listed option or type a value). The server stores a listed value as a preset and an unlisted typed value as a custom value; a required field still needs a non-empty value. On edit, a stored value that is not in the list is shown and submitted as a typed value, never reported as not-a-choice. */
  customValueAllowed?: boolean;
  /** capability `option_source.status`. live: the list came from the Computer's probe. fallback: the probe was not live and the list is the bundled one (usable; show `reason`). unavailable: no list at all; `options` is []. One status per source, worst wins (unavailable > fallback > live), dependent_select included (there is no per-value status). A source-level failure is reported here, never as a form-level error, and never makes a client fall back to v1 (v1 fallback is only for a form-level 404 or protocol error). Client obligations: unavailable + required field: show the status and (when retryable) a retry, and block submit; unavailable + optional field: hide the field. Retry = request the same source again with `?refresh=1`; the server then bypasses any cache (the Computer's probe gate already single-flights concurrent probes). */
  status?: "live" | "fallback" | "unavailable";
  /** capability `option_source.status`. Why the status is not live; absent when status is live. probe_timeout and probe_failed stay distinct. Server mapping from the Computer's probe outcome: missing_config -> missing_config; no_models (or a live list with no models) -> no_models; unsupported -> unsupported; probe error with code detect_timeout, or the server's own wait timing out -> probe_timeout; probe error with code computer_offline, or the Computer offline/unrouted -> machine_offline; any other probe error or failure -> probe_failed. Clients must accept an unknown reason (show a generic message). */
  reason?: "probe_timeout" | "probe_failed" | "missing_config" | "no_models" | "unsupported" | "machine_offline";
  /** capability `option_source.status`. Whether retrying may change the answer: true for probe_timeout, probe_failed, machine_offline and no_models (the user may add models); false for missing_config and unsupported. Absent or false when status is live. */
  retryable?: boolean;
  [key: string]: unknown;
}

export interface RuntimeFormV2Option {
  value: string;
  label: string;
  providerKind?: string;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  /** capability `provider.saved_connection`. Non-empty marks this option as a saved provider connection. Hard constraint: value === "connection:" + connectionId; an option violating it is a protocol error. Sent only to forms that declare the capability, and only when the request carried a matching formRevision. Display metadata (label, underlyingProviderId, providerKind) is never trusted back: on save the server re-resolves the connection by id in the current server scope. */
  connectionId?: string;
  /** capability `provider.saved_connection`. The connection's provider id (e.g. deepseek). Distinct from providerKind, which only carries preset/gateway semantics. */
  underlyingProviderId?: string;
  /** capability `provider.saved_connection`. Display grouping: saved connections first ("Saved providers"), then direct/manual providers. */
  group?: "saved" | "direct";
  /** capability `provider.saved_connection`. Edit only: the agent's currently bound connection is not selectable right now (disabled, missing credential, retired). It stays visible, keeps the agent's stored value, and blocks save until the user picks something else — a silent rewrite never happens. */
  unavailable?: boolean;
  /** capability `provider.saved_connection`. Localized-safe reason key for `unavailable` (e.g. disabled, missing_credential, retired, not_found). */
  unavailableReason?: string;
  [key: string]: unknown;
}

export interface RuntimeFormV2SubmitRef {
  protocolVersion: 2;
  runtimeId: string;
  [key: string]: unknown;
}

/** The runtime-form part of POST /api/agents: field values keyed by dataSchema property name. The server assembles the runtimeConfig. */
export interface RuntimeFormV2Submission {
  formDefinitionRef: RuntimeFormV2SubmitRef;
  formValues: Record<string, unknown>;
  [key: string]: unknown;
}
