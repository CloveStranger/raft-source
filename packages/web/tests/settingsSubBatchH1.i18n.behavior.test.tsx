import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";
import MemberGraphSection from "../src/components/settings/MemberGraphSection";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { useServerStore } from "../src/store/serverStore";

// Settings sub-batch H1: MemberGraphSection — the PURE
// string-swap half of the remaining Settings residue. The structural half
// (AppNotificationsControls' module-level Record constants → Record<..., MessageId>)
// is deliberately a separate batch so review isn't mixing two risk profiles.
//
// PRE-PR SWEEP (per @artin's feedback: close the class, don't wait for review to
// find instances). Sweeping both files for user-facing string props confirmed the
// scanner's list was complete — but the sweep itself had a GAP it then exposed:
//
//   my regex matched JSX attributes (`prop="v"`) and missed DEFAULT PARAMETERS
//   (`prop = "v"` in a destructuring signature). That is how
//   `sectionLabel = "Member Graph"` survived — the same latent-default class as
//   SelectionPopover's `emptyLabel = "No matches"` fixed in #5716.
//
// The default is now resolved through the catalog. Today's only caller
// (MainLayout) passes sectionLabel explicitly, so this is a latent leak, not a
// live one — fixed anyway, because "no caller hits it yet" is a fact about today.

const originalGet = api.get;
const initialServerState = useServerStore.getInitialState();

const IDS = [
  "settings.tabs.navAriaLabel",
  "settings.tabs.about",
  "settings.memberGraph.graphAriaLabel",
  "settings.memberGraph.sectionLabel",
  "settings.memberGraph.humans",
  "settings.memberGraph.agents",
  "settings.memberGraph.links",
  "settings.memberGraph.mostConnectedTitle",
  "settings.memberGraph.noMemberships",
  "settings.memberGraph.largestChannelsTitle",
  "settings.memberGraph.noVisibleChannels",
  "settings.memberGraph.refresh",
  "settings.memberGraph.emptyState",
  "settings.memberGraph.loadFailed",
];

afterEach(() => {
  cleanup();
  api.get = originalGet;
  useServerStore.setState(initialServerState, true);
});

test("every id this sub-batch added is present and actually translated in both catalogs", () => {
  const en = enMessages as Record<string, string>;
  const zh = zhMessages as Record<string, string>;

  for (const id of IDS) {
    assert.ok(en[id], `${id} missing from en.ts`);
    assert.ok(zh[id], `${id} missing from zh-cn.ts`);
    assert.notEqual(zh[id], en[id], `${id} is still the English string in zh-cn.ts`);
    // `agents` is intentionally "Agent" in zh — the product keeps the English
    // word for the participant type (cf. 引导 Agent / 新 Agent 问候 in the
    // existing catalog), so it is exempt from the Han-character requirement.
    if (id !== "settings.memberGraph.agents") {
      assert.match(zh[id], /\p{Script=Han}/u, `${id} has no Chinese characters`);
    }
  }
});

test("the member graph resolves its default chrome through the zh-cn catalog", async () => {
  useServerStore.setState({
    current: { id: "server-1", name: "Raft Test", slug: "raft-test" },
  } as never);
  api.get = (async (url: string) => {
    assert.equal(url, "/servers/server-1/member-graph");
    return { data: { humans: [], agents: [], channels: [], edges: [] } };
  }) as typeof api.get;

  render(
    <TestIntlProvider locale="zh-cn">
      <MemberGraphSection />
    </TestIntlProvider>,
  );

  await waitFor(() => {
    assert.ok(screen.getByText(zhMessages["settings.memberGraph.emptyState"]));
  });
  for (const id of [
    "settings.memberGraph.sectionLabel",
    "settings.memberGraph.refresh",
    "settings.memberGraph.humans",
    "settings.memberGraph.agents",
    "settings.memberGraph.links",
    "settings.memberGraph.mostConnectedTitle",
    "settings.memberGraph.noMemberships",
    "settings.memberGraph.largestChannelsTitle",
    "settings.memberGraph.noVisibleChannels",
  ] as const) {
    assert.ok(screen.getByText(zhMessages[id]), `${id} should render through zh-cn`);
  }
  assert.equal(screen.queryByText("Member Graph"), null);
  assert.equal(screen.queryByText("Refresh"), null);
});

test("node link counts use an ICU plural, not an English suffix", () => {
  // `{degree} links` concatenated an English word onto a number. That cannot
  // pluralize or reorder in translation; zh needs "{count} 个连接" with the unit
  // in a different position entirely.
  const en = enMessages as Record<string, string>;
  const zh = zhMessages as Record<string, string>;

  assert.match(en["settings.memberGraph.nodeLinks"], /\{count, plural,/, "en must be an ICU plural");
  assert.match(zh["settings.memberGraph.nodeLinks"], /\{count, plural,/, "zh must be an ICU plural");
  // zh has a single `other` arm by convention (cf. message.chatPanel.*).
  assert.ok(
    !zh["settings.memberGraph.nodeLinks"].includes("one {"),
    "zh plural should use a single other arm",
  );
});
