import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./helpers/domSetup";
import { cleanup, screen } from "@testing-library/react";

import { IMBridgesSection, isSlackBridgeSurfaceEnabled } from "../src/components/settings/IMBridgesSettingsSection";
import type {
  SlackBridgeProvisioningProvider,
  SlackBridgeProvisioningView,
} from "../src/components/settings/slackBridgeProvisioning";
import {
  SETTINGS_TABS,
  settingsTabIdForRouteSlug,
  settingsRouteSlugForTab,
} from "../src/components/settings/settingsNavigation";
import { renderWithIntl } from "./helpers/intl";
import {
  readSlackOAuthReturnError,
  stripSlackOAuthReturnParams,
} from "../src/components/settings/slackOAuthReturn";

afterEach(cleanup);

const readSource = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function connectView(): SlackBridgeProvisioningView {
  return {
    kind: "ready",
    snapshot: {
      stage: "connect",
      workspaceName: null,
      raftChannels: [],
      slackChannels: [],
      channelPairs: [],
      preflight: null,
      rawHealth: null,
    },
  };
}

function provider(): SlackBridgeProvisioningProvider {
  const view = connectView();
  return {
    load: async () => view,
    connect: async () => view,
    beginOAuth: async () => ({ kind: "view", view }),
    saveChannelPairs: async () => view,
    runPreflight: async () => view,
    enable: async () => view,
  };
}

test("IM Bridges is a dedicated Settings destination immediately before Applications", () => {
  assert.equal(settingsTabIdForRouteSlug("im-bridges"), "im-bridges");
  assert.equal(settingsRouteSlugForTab("im-bridges"), "im-bridges");

  const ids = SETTINGS_TABS.map((tab) => tab.id);
  assert.equal(ids.indexOf("im-bridges") + 1, ids.indexOf("integrations"));
});

test("IM Bridges visibility requires a resolved, enabled server-scoped gate", () => {
  assert.equal(isSlackBridgeSurfaceEnabled({ resolved: false, enabled: false }), false);
  assert.equal(isSlackBridgeSurfaceEnabled({ resolved: true, enabled: false }), false);
  assert.equal(isSlackBridgeSurfaceEnabled({ resolved: true, enabled: true }), true);
});

test("the provider-neutral IM Bridges surface contains the Slack setup flow", async () => {
  renderWithIntl(<IMBridgesSection canManage provider={provider()} />);

  assert.ok(screen.getByTestId("im-bridges-section"));
  assert.ok(screen.getByRole("heading", { name: "Messaging bridges" }));
  assert.ok(screen.getByText("Manage connections between Raft and external messaging services."));
  assert.ok(await screen.findByText("Raft for Slack"));
  assert.ok(screen.getByRole("button", { name: "Connect with Slack" }));
});

test("Slack setup is routed only through IM Bridges, never Applications", () => {
  const settingsPanel = readSource("src/components/settings/SettingsPanel.tsx");
  const imBridges = readSource("src/components/settings/IMBridgesSettingsSection.tsx");

  assert.match(settingsPanel, /settingsTab === "im-bridges" && <IMBridgesSettingsSection \/>/u);
  assert.match(settingsPanel, /settingsTab === "integrations" && <IntegrationsSection \/>/u);
  assert.doesNotMatch(settingsPanel, /SlackBridgeSetupWizard/u);
  assert.match(imBridges, /useServerFeatureFlag\(SLACK_BRIDGE_FEATURE_FLAG_KEYS\.master\)/u);
  assert.match(imBridges, /if \(!isSlackBridgeSurfaceEnabled\(slackBridge\)\) return null;/u);
  assert.match(imBridges, /<SlackBridgeSetupWizard canManage=\{canManage\} provider=\{provider\} \/>/u);
  assert.match(settingsPanel, /isSlackBridgeSurfaceEnabled\(slackBridgeGate\)/u);
  assert.match(settingsPanel, /requestedSettingsTab === "im-bridges" && !slackBridgeEnabled/u);
});

test("a Slack OAuth failure redirect maps to an explainable message", () => {
  assert.equal(readSlackOAuthReturnError(""), null);
  assert.equal(readSlackOAuthReturnError("?code=abc"), null);
  assert.equal(
    readSlackOAuthReturnError("?slack_oauth=error&code=slack_oauth_provider_rejected")?.messageId,
    "settings.slackBridge.oauthReturn.cancelled",
  );
  assert.equal(
    readSlackOAuthReturnError("?slack_oauth=error&code=slack_oauth_reconciliation_required")?.messageId,
    "settings.slackBridge.oauthReturn.unconfirmed",
  );
  assert.deepEqual(
    readSlackOAuthReturnError("?slack_oauth=error&code=slack_oauth_rejected&reason=provider_rejected&provider_error=bad_client_secret"),
    { messageId: "settings.slackBridge.oauthReturn.failed", code: "slack_oauth_rejected" },
  );
  assert.equal(
    stripSlackOAuthReturnParams("?tab=x&slack_oauth=error&code=slack_oauth_rejected&reason=provider_rejected&provider_error=bad_client_secret"),
    "?tab=x",
  );
  assert.equal(stripSlackOAuthReturnParams("?slack_oauth=error&code=slack_oauth_retryable"), "");
});

test("the IM Bridges page explains a failed Slack authorization instead of showing raw JSON", async () => {
  renderWithIntl(
    <IMBridgesSection
      canManage
      provider={provider()}
      oauthReturnError={readSlackOAuthReturnError(
        "?slack_oauth=error&code=slack_oauth_rejected&reason=provider_rejected&provider_error=bad_client_secret",
      )}
    />,
  );

  const banner = screen.getByTestId("slack-oauth-return-error");
  assert.match(banner.textContent ?? "", /Slack authorization didn't finish/u);
  assert.match(banner.textContent ?? "", /nothing was changed\. Try again; if it keeps failing, contact Raft support and mention code slack_oauth_rejected/u);
  assert.ok(await screen.findByText("Raft for Slack"));
});
