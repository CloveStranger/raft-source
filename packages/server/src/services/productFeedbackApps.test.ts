import assert from "node:assert/strict";
import {
  CachedProductFeedbackApps,
  productFeedbackAppsParameterName,
  productFeedbackEnvForSource,
  productFeedbackUnavailableReason,
  ProductFeedbackSourceUnavailableError,
  resolveProductFeedbackEnv,
  selectProductFeedbackEnv,
} from "./productFeedbackApps";

const ANDROID_APP_ID = "a48a84f8-04ed-4db3-9297-189a14a36afc";
const IOS_APP_ID = "fbfaceca-6d27-47e1-9c20-e56a39535339";

function app(appId: string, slug: string) {
  return {
    app_slug: slug,
    app_id: appId,
    reporter_integration_id: "a7df6737-1452-4680-a23a-c321277f53f4",
    credential_revision: "1",
    client_key: `qk_${slug}`,
    token: `token_${slug}`,
  };
}

const APPS = JSON.stringify({
  shared: {
    reporter_id_secret: "multi-reporter-secret",
    route_subject_root: Buffer.alloc(32, 7).toString("base64url"),
    cursor_secret: "multi-cursor-secret",
  },
  android: app(ANDROID_APP_ID, "raft-feedback-android"),
  ios: app(IOS_APP_ID, "raft-feedback-ios"),
});

const LEGACY: NodeJS.ProcessEnv = {
  HANDS_FEEDBACK_BASE_URL: "https://hands.test",
  HANDS_FEEDBACK_APP_SLUG: "raft-web",
  HANDS_FEEDBACK_REPORTER_ID_SECRET: "legacy-reporter-secret",
  HANDS_FEEDBACK_CURSOR_SECRET: "legacy-cursor-secret",
  HANDS_FEEDBACK_CONVERSATION_SESSION_ENABLED: "true",
};

test("a source entry maps onto the legacy variable names with one token and the multi secrets", () => {
  const env = productFeedbackEnvForSource("android", APPS, LEGACY);
  assert.ok(env);
  assert.equal(env.HANDS_FEEDBACK_BASE_URL, "https://hands.test");
  assert.equal(env.HANDS_FEEDBACK_APP_SLUG, "raft-feedback-android");
  assert.equal(env.HANDS_FEEDBACK_APP_ID, ANDROID_APP_ID);
  assert.equal(env.HANDS_FEEDBACK_CLIENT_KEY, "qk_raft-feedback-android");
  assert.equal(env.HANDS_FEEDBACK_APP_TOKEN, "token_raft-feedback-android");
  assert.equal(env.HANDS_FEEDBACK_CONVERSATION_APP_TOKEN, "token_raft-feedback-android");
  assert.equal(env.HANDS_FEEDBACK_CONVERSATION_CREDENTIAL_REVISION, "1");
  assert.equal(env.HANDS_FEEDBACK_CONVERSATION_SESSION_ENABLED, "true");
  assert.equal(env.HANDS_FEEDBACK_REPORTER_ID_SECRET, "multi-reporter-secret");
  assert.equal(env.HANDS_FEEDBACK_ROUTE_SUBJECT_KEY_ID, "v1");
  assert.equal(env.HANDS_FEEDBACK_ROUTE_SUBJECT_COMMITMENT_SCOPE, "multi");
  // Never the legacy (raft-web) secrets.
  assert.notEqual(env.HANDS_FEEDBACK_REPORTER_ID_SECRET, LEGACY.HANDS_FEEDBACK_REPORTER_ID_SECRET);
  assert.notEqual(env.HANDS_FEEDBACK_CURSOR_SECRET, LEGACY.HANDS_FEEDBACK_CURSOR_SECRET);
});

test("each app gets its own cursor key, so a cursor does not verify across apps", () => {
  const android = productFeedbackEnvForSource("android", APPS, LEGACY);
  const ios = productFeedbackEnvForSource("ios", APPS, LEGACY);
  assert.ok(android?.HANDS_FEEDBACK_CURSOR_SECRET && ios?.HANDS_FEEDBACK_CURSOR_SECRET);
  assert.notEqual(android.HANDS_FEEDBACK_CURSOR_SECRET, ios.HANDS_FEEDBACK_CURSOR_SECRET);
  assert.notEqual(android.HANDS_FEEDBACK_CURSOR_SECRET, "multi-cursor-secret");
});

test("a missing, incomplete or unparsable entry yields no app", () => {
  assert.equal(productFeedbackEnvForSource("ohos", APPS, LEGACY), null);
  assert.equal(productFeedbackEnvForSource("android", null, LEGACY), null);
  assert.equal(productFeedbackEnvForSource("android", "{not json", LEGACY), null);
  assert.equal(productFeedbackEnvForSource("android", "[]", LEGACY), null);
  const withoutToken = JSON.parse(APPS);
  delete withoutToken.android.token;
  assert.equal(productFeedbackEnvForSource("android", JSON.stringify(withoutToken), LEGACY), null);
  const withoutShared = JSON.parse(APPS);
  delete withoutShared.shared.cursor_secret;
  assert.equal(productFeedbackEnvForSource("android", JSON.stringify(withoutShared), LEGACY), null);
  const { HANDS_FEEDBACK_BASE_URL: _baseUrl, ...noBaseUrl } = LEGACY;
  assert.equal(productFeedbackEnvForSource("android", APPS, noBaseUrl), null);
});

test("flag off keeps the legacy env for every source; flag on never sends mobile to the legacy app", () => {
  for (const source of ["web", "ios", "android", "ohos"] as const) {
    assert.equal(selectProductFeedbackEnv({ source, multiAppEnabled: false, appsJson: APPS, env: LEGACY }), LEGACY);
  }
  assert.equal(
    selectProductFeedbackEnv({ source: "android", multiAppEnabled: true, appsJson: APPS, env: LEGACY })
      .HANDS_FEEDBACK_APP_SLUG,
    "raft-feedback-android",
  );
  assert.throws(
    () => selectProductFeedbackEnv({ source: "ohos", multiAppEnabled: true, appsJson: APPS, env: LEGACY }),
    (error: unknown) => error instanceof ProductFeedbackSourceUnavailableError && error.source === "ohos",
  );
  assert.throws(
    () => selectProductFeedbackEnv({ source: "android", multiAppEnabled: true, appsJson: null, env: LEGACY }),
    ProductFeedbackSourceUnavailableError,
  );
  // Web without its own entry stays on the legacy (web) app.
  assert.equal(selectProductFeedbackEnv({ source: "web", multiAppEnabled: true, appsJson: APPS, env: LEGACY }), LEGACY);
});

test("the apps parameter name comes only from the Terraform-injected staging/prod path", () => {
  assert.equal(
    productFeedbackAppsParameterName({ HANDS_FEEDBACK_APPS_SSM_PARAMETER: "/slock/staging/HANDS_FEEDBACK_APPS" }),
    "/slock/staging/HANDS_FEEDBACK_APPS",
  );
  assert.equal(
    productFeedbackAppsParameterName({ HANDS_FEEDBACK_APPS_SSM_PARAMETER: "/slock/prod/HANDS_FEEDBACK_APPS" }),
    "/slock/prod/HANDS_FEEDBACK_APPS",
  );
  for (const value of [undefined, "", "/slock/staging/OTHER", "/slock/../prod/HANDS_FEEDBACK_APPS", "/other/staging/HANDS_FEEDBACK_APPS"]) {
    assert.equal(productFeedbackAppsParameterName({ HANDS_FEEDBACK_APPS_SSM_PARAMETER: value }), null);
  }
});

test("the apps JSON is read once per window; a failed read is cached as unavailable and logged without values", async () => {
  let now = 1_000;
  const reads: string[] = [];
  let fail = false;
  const apps = new CachedProductFeedbackApps(
    async (name) => {
      reads.push(name);
      if (fail) throw Object.assign(new Error(`boom ${APPS}`), { name: "ParameterNotFound" });
      return APPS;
    },
    { HANDS_FEEDBACK_APPS_SSM_PARAMETER: "/slock/staging/HANDS_FEEDBACK_APPS" },
    60_000,
    () => now,
    10_000,
  );
  assert.equal(await apps.get(), APPS);
  assert.equal(await apps.get(), APPS);
  assert.deepEqual(reads, ["/slock/staging/HANDS_FEEDBACK_APPS"]);

  fail = true;
  now += 60_001;
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    assert.equal(await apps.get(), null);
    assert.equal(await apps.get(), null);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(reads.length, 2);
  assert.deepEqual(warnings, ["[product-feedback] apps parameter unavailable (ParameterNotFound)"]);

  // A failure is retried after the shorter failure window, not the full TTL.
  fail = false;
  now += 10_001;
  assert.equal(await apps.get(), APPS);
  assert.equal(reads.length, 3);

  const unconfigured = new CachedProductFeedbackApps(async () => { throw new Error("must not read"); }, {});
  assert.equal(await unconfigured.get(), null);
});

test("resolveProductFeedbackEnv evaluates the flag per user and reads apps only when it is on", async () => {
  let reads = 0;
  const apps = new CachedProductFeedbackApps(
    async () => { reads += 1; return APPS; },
    { HANDS_FEEDBACK_APPS_SSM_PARAMETER: "/slock/staging/HANDS_FEEDBACK_APPS" },
  );
  const off = await resolveProductFeedbackEnv({
    userId: "u1", source: "android", env: LEGACY, apps,
    evaluateFlag: async (input) => ({ key: input.key, enabled: false, reason: "missing_flag" }) as never,
  });
  assert.equal(off, LEGACY);
  assert.equal(reads, 0);
  const on = await resolveProductFeedbackEnv({
    userId: "u1", source: "android", env: LEGACY, apps,
    evaluateFlag: async (input) => ({ key: input.key, enabled: true, reason: "default" }) as never,
  });
  assert.equal(on.HANDS_FEEDBACK_APP_ID, ANDROID_APP_ID);
  assert.equal(reads, 1);
});

test("an unavailable source names why, with field names only and never a value", () => {
  assert.equal(productFeedbackUnavailableReason("android", null, LEGACY), "apps_parameter_not_configured");
  assert.equal(
    productFeedbackUnavailableReason("android", null, { ...LEGACY, HANDS_FEEDBACK_APPS_SSM_PARAMETER: "/slock/staging/HANDS_FEEDBACK_APPS" }),
    "apps_parameter_unread",
  );
  // 10-10: the parameter was pasted with terminal line wraps and did not parse.
  assert.equal(productFeedbackUnavailableReason("android", APPS.slice(0, 200) + "\n" + APPS.slice(200), LEGACY), "apps_json_invalid");
  assert.equal(productFeedbackUnavailableReason("android", "[]", LEGACY), "apps_json_not_object");
  assert.equal(productFeedbackUnavailableReason("ohos", APPS, LEGACY), "source_entry_missing");
  const withoutToken = JSON.parse(APPS);
  delete withoutToken.android.token;
  delete withoutToken.android.client_key;
  assert.equal(
    productFeedbackUnavailableReason("android", JSON.stringify(withoutToken), LEGACY),
    "source_fields_missing:client_key,token",
  );
  const withoutShared = JSON.parse(APPS);
  delete withoutShared.shared.route_subject_root;
  assert.equal(
    productFeedbackUnavailableReason("android", JSON.stringify(withoutShared), LEGACY),
    "shared_fields_missing:route_subject_root",
  );
  const { HANDS_FEEDBACK_BASE_URL: _baseUrl, ...noBaseUrl } = LEGACY;
  assert.equal(productFeedbackUnavailableReason("android", APPS, noBaseUrl), "base_url_missing");
  // Reason codes never carry a secret.
  const secrets = Object.values(JSON.parse(APPS).android).concat(Object.values(JSON.parse(APPS).shared)) as string[];
  for (const reason of [productFeedbackUnavailableReason("android", JSON.stringify(withoutToken), LEGACY)]) {
    for (const secret of secrets) assert.equal(reason.includes(secret), false);
  }
});

test("selectProductFeedbackEnv carries the unavailable reason on the error", () => {
  assert.throws(
    () => selectProductFeedbackEnv({ source: "android", multiAppEnabled: true, appsJson: "{not json", env: LEGACY }),
    (error: unknown) => error instanceof ProductFeedbackSourceUnavailableError && error.reason === "apps_json_invalid",
  );
});
