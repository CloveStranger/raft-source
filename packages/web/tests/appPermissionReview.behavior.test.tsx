import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { TestIntlProvider } from "./helpers/intl";
import SettingsPanel from "../src/components/settings/SettingsPanel";
import { en as enMessages } from "../src/i18n/messages/en";
import api from "../src/api/client";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import { useTranslationStore } from "../src/store/translationStore";
import { useAgentStore } from "../src/store/agentStore";

const originalGet = api.get;
const originalPost = api.post;
const en = enMessages as Record<string, string>;

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  useServerStore.setState(useServerStore.getInitialState(), true);
  useTranslationStore.setState(useTranslationStore.getInitialState(), true);
  useAuthStore.setState({ user: null } as never);
  useAgentStore.setState({ agents: [] } as never);
});

function seedOwner() {
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as never;
  }
  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "u@example.com",
      gravatarHash: "",
      name: "U",
      displayName: "U",
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      displayLanguage: null,
      preferredTimezone: "UTC",
      autoTranslationEnabled: false,
      preferredTranslationDisplay: "translated",
      preferredMessageBodyFontSize: null,
      referralSource: null,
      referralSourceOther: null,
      referralSourceSkippedAt: null,
    },
    loading: false,
    initialized: true,
  } as never);
  useServerStore.setState({
    servers: [{ id: "s1", slug: "s1", name: "S1", role: "owner" }],
    current: { id: "s1", slug: "s1", name: "S1", role: "owner" },
    members: [],
    loading: false,
  } as never);
  useTranslationStore.setState({
    settings: {
      ...useTranslationStore.getInitialState().settings,
      preferredTranslationMode: "off",
      preferredTimeFormat: "24h",
      effectiveTimeFormat: "24h",
    },
    settingsServerId: "s1",
    settingsLoading: false,
    settingsError: null,
  } as never);
}

function renderPanel(tab: "integrations") {
  return render(
    <TestIntlProvider locale="en">
      <MemoryRouter>
        <SettingsPanel tab={tab} />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

const pendingMarketplaceApp = {
  id: "market_tdoc",
  serverId: "other-server",
  clientId: "tdoc-7a927d",
  appType: "third_party_global",
  publishStatus: "published",
  category: "Productivity & Collaboration",
  dataAccessSummary: null,
  publishRejectionReason: null,
  name: "tdoc",
  description: "Docs sync.",
  homepageUrl: "https://example.com/tdoc",
  returnUrl: null,
  agentManifestUrl: null,
  allowedScopes: [],
  logoUrl: null,
  humanMarketplaceVisible: true,
  createdByUserId: "user-2",
  createdAt: "2026-06-25T00:00:00.000Z",
  updatedAt: "2026-06-25T00:00:00.000Z",
  installedAt: null,
  publisherName: "julie",
  privateShared: false,
  appNotificationGroups: [],
  appNotificationEvents: [],
  appNotificationReviewPending: true,
  appNotificationPendingRevisionId: "rev-seen-by-reviewer",
  appNotificationPendingGroups: ["agent"],
  appNotificationPendingEvents: [],
  canReviewAppNotifications: true,
};

test("marketplace app detail shows pending permission groups and a reviewer approve action", async () => {
  seedOwner();
  const posted: { url: string; body?: unknown }[] = [];
  api.get = (async (url: string) => {
    if (url === "/integrations/marketplace") return { data: [pendingMarketplaceApp] };
    if (url === "/integrations/clients") return { data: [] };
    if (url === "/integrations/built-in") return { data: [] };
    if (url === "/integrations/overview") return { data: [] };
    return { data: [] };
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    posted.push({ url: String(url), body });
    return { data: { state: "active" } };
  }) as typeof api.post;

  renderPanel("integrations");
  fireEvent.click(await screen.findByTestId("connected-apps-tab-marketplace"));
  fireEvent.click(await screen.findByText("tdoc"));

  // Pending badge is the permission-update variant, not the generic review copy.
  assert.ok(await screen.findByText(en["settings.connectedApps.appNotifications.permissionUpdatePending"]));
  // Requested (pending) groups are surfaced, not just approved current_groups.
  const summary = await screen.findByTestId("app-notifications-request-summary");
  assert.ok(summary.textContent?.includes("Agent"), "pending 'agent' group must be shown");
  assert.ok(summary.textContent?.includes(en["settings.connectedApps.appNotifications.requestedDataGroups"]));

  const approve = await screen.findByRole("button", { name: en["settings.connectedApps.appNotifications.approvePermissionUpdate"] });
  fireEvent.click(approve);
  await waitFor(() => assert.ok(posted.some((call) => call.url === "/integrations/clients/market_tdoc/app-notifications/permissions/review")));
  const call = posted.find((entry) => entry.url === "/integrations/clients/market_tdoc/app-notifications/permissions/review");
  assert.deepEqual(call?.body, { expected_revision_id: "rev-seen-by-reviewer" }, "approval must bind the displayed revision id");
});

test("marketplace app detail clears the pending state after a successful approve", async () => {
  seedOwner();
  let approved = false;
  let marketplaceReads = 0;
  api.get = (async (url: string) => {
    if (url === "/integrations/marketplace") {
      marketplaceReads++;
      return {
        data: [approved
          ? { ...pendingMarketplaceApp, appNotificationReviewPending: false, appNotificationGroups: ["agent"], appNotificationPendingRevisionId: null, appNotificationPendingGroups: null, appNotificationPendingEvents: null }
          : pendingMarketplaceApp],
      };
    }
    if (url === "/integrations/clients") return { data: [] };
    if (url === "/integrations/built-in") return { data: [] };
    if (url === "/integrations/overview") return { data: [] };
    return { data: [] };
  }) as typeof api.get;
  api.post = (async () => {
    approved = true;
    return { data: { state: "active" } };
  }) as typeof api.post;

  renderPanel("integrations");
  fireEvent.click(await screen.findByTestId("connected-apps-tab-marketplace"));
  fireEvent.click(await screen.findByText("tdoc"));
  fireEvent.click(await screen.findByRole("button", { name: en["settings.connectedApps.appNotifications.approvePermissionUpdate"] }));
  await waitFor(() => assert.ok(marketplaceReads >= 2, "listing should reload after approve"));
  await waitFor(() => assert.ok(
    screen.queryByText(en["settings.connectedApps.appNotifications.permissionUpdatePending"]) === null,
    "pending badge must disappear once the reload shows the approved state",
  ));
});

test("marketplace app detail hides the approve action for non-reviewers", async () => {
  seedOwner();
  api.get = (async (url: string) => {
    if (url === "/integrations/marketplace") {
      return { data: [{ ...pendingMarketplaceApp, canReviewAppNotifications: false }] };
    }
    if (url === "/integrations/clients") return { data: [] };
    if (url === "/integrations/built-in") return { data: [] };
    if (url === "/integrations/overview") return { data: [] };
    return { data: [] };
  }) as typeof api.get;

  renderPanel("integrations");
  fireEvent.click(await screen.findByTestId("connected-apps-tab-marketplace"));
  fireEvent.click(await screen.findByText("tdoc"));

  assert.ok(await screen.findByText(en["settings.connectedApps.appNotifications.permissionUpdatePending"]));
  assert.ok(screen.queryByRole("button", { name: en["settings.connectedApps.appNotifications.approvePermissionUpdate"] }) === null);
});
