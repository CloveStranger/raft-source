import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { WIKI_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";

import api from "../src/api/client";
import { LeftRail } from "../src/components/layout/LeftRail";
import { TestIntlProvider } from "./helpers/intl";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import {
  publishServerFeatureFlagValuesFromLabsReadback,
  resetServerFeatureFlagsForTests,
} from "../src/store/serverFeatureFlags";

const originalApiGet = api.get;
const originalApiPost = api.post;

afterEach(() => {
  api.get = originalApiGet;
  api.post = originalApiPost;
  cleanup();
  localStorage.clear();
  resetServerFeatureFlagsForTests();
  useAuthStore.setState({ user: null, loading: false, initialized: true });
  useServerStore.setState({ current: null, servers: [], members: [] });
});

test("LeftRail omits the retired Wiki tab even when its old flag is enabled", () => {
  api.get = (async () => ({ data: [] })) as typeof api.get;
  api.post = (async () => ({
    data: { evaluations: [{ key: WIKI_FEATURE_FLAG_KEY, enabled: true }] },
  })) as typeof api.post;
  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "owner@example.com",
      gravatarHash: "",
      name: "owner",
      displayName: "Owner",
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      preferredTimezone: null,
      autoTranslationEnabled: false,
      preferredTranslationDisplay: "original",
      preferredTimeFormat: null,
      preferredMessageBodyFontSize: null,
      referralSource: null,
      referralSourceOther: null,
      referralSourceSkippedAt: null,
    },
    loading: false,
    initialized: true,
  } as never);
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Server",
      avatarUrl: null,
      slug: "server",
      ownerId: "user-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "pro",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-07-22T00:00:00.000Z",
    },
    servers: [],
    members: [],
  } as never);
  publishServerFeatureFlagValuesFromLabsReadback({
    serverId: "server-1",
    serverLabVersion: 1,
    masterEnabled: true,
    labs: [{
      key: WIKI_FEATURE_FLAG_KEY,
      name: "Wiki",
      description: "",
      state: "open",
      enrolled: true,
      effective: true,
    }],
  });

  const first = render(
    <MemoryRouter initialEntries={["/s/server"]}>
      <TestIntlProvider locale="zh-cn">
        <LeftRail />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.ok(screen.queryByRole("button", { name: "Wiki" }) === null);
  assert.deepEqual(
    Array.from(first.container.querySelectorAll<HTMLElement>('[data-testid^="left-rail-tab-"]'))
      .map((element) => element.dataset.testid),
    [
      "left-rail-tab-search",
      "left-rail-tab-chat",
      "left-rail-tab-activity",
      "left-rail-tab-tasks",
      "left-rail-tab-members",
      "left-rail-tab-computers",
    ],
    "the rail omits retired Wiki even when its old flag is enabled",
  );
});
