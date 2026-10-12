import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import { LeftRail } from "../src/components/layout/LeftRail";
import { TestIntlProvider } from "./helpers/intl";
import { ThemeProvider } from "raft-ui";
import { useServerStore } from "../src/store/serverStore";

// Teeth for task #750/#751 (artin's rail chrome reports, #proj-uiux 2026-08-02):
//   #750 — the server-switcher attention dot painted UNDER the avatar image:
//          AvatarImageWithFallback gives its img `relative z-[1]`; a z-auto
//          positioned dot always loses to an explicit stack level regardless
//          of DOM order. The dot must carry an explicit level above it.
//   #751 — the rail's bottom Settings button sat flush to the edge; the rail
//          column now keeps bottom padding.
// Both teeth pin the exact stacking/spacing relationships at DOM level (RED
// if the marker classes are removed); the pixel-level proof is the browser
// verification attached to the PR.

// raft-ui's ThemeProvider reads the system colour-scheme through
// matchMedia, which jsdom does not implement. Same stub shape the other
// provider-backed suites use (see aboutFeedback.behavior.test.tsx).
function matchMediaStub(matches: boolean): typeof window.matchMedia {
  return ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
const originalMatchMedia =
  typeof window.matchMedia === "function" ? window.matchMedia : matchMediaStub(false);
window.matchMedia = originalMatchMedia;

const originalApiGet = api.get;
const originalServerState = useServerStore.getState();

afterEach(() => {
  cleanup();
  api.get = originalApiGet;
  window.matchMedia = originalMatchMedia;
  useServerStore.setState(originalServerState, true);
});

function seedServers() {
  useServerStore.setState({
    ...originalServerState,
    current: {
      id: "server-1",
      name: "Botiverse",
      slug: "botiverse",
      avatarUrl: "https://cdn.example.com/botiverse-avatar.png",
    } as never,
    servers: [
      { id: "server-1", name: "Botiverse", slug: "botiverse" },
      { id: "server-2", name: "Other", slug: "other" },
    ] as never,
  });
  api.get = ((url: string) => {
    if (url === "/servers/unread-summary") {
      return Promise.resolve({
        data: [{ serverId: "server-2", unreadCount: 3, serverPushMuted: false, activityUnreadCount: 3 }],
      });
    }
    return new Promise(() => {});
  }) as typeof api.get;
}

function renderRail() {
  return render(
    <MemoryRouter initialEntries={["/s/botiverse/channel/general"]}>
      <TestIntlProvider>
        <LeftRail />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

test("#750: the server-switcher attention dot outranks the avatar image's explicit z-[1]", async () => {
  seedServers();
  const { container } = renderRail();
  // Simulate App's single boot-entry fetch (LeftRail itself no longer fetches
  // on mount) so the summary lands and the dot appears.
  void useServerStore.getState().loadServerUnreadSummary();
  const switcher = container.querySelector<HTMLButtonElement>('button[aria-label*="Botiverse"]');
  assert.ok(switcher, "server switcher button renders");

  const avatar = switcher.querySelector<HTMLImageElement>('img[src="https://cdn.example.com/botiverse-avatar.png"]');
  assert.ok(avatar, "avatar image renders");
  assert.match(avatar.className, /z-\[1\]/, "the avatar image keeps its explicit stack level (the element the dot must beat)");

  await waitFor(() => {
    const found = switcher.querySelector<HTMLSpanElement>('[data-slot="app-rail-item-indicator"]');
    assert.ok(found, "attention dot appears once the unread summary lands");
    return found;
  });
  assert.match(
    switcher.querySelector('[data-slot="app-rail-item-indicator"]')?.parentElement?.className ?? "",
    /\[&_\[data-slot=app-rail-item-indicator\]\]:z-\[2\]/,
    "the indicator's parent must establish an explicit level ABOVE z-[1] — a z-auto positioned element paints under the image regardless of DOM order",
  );
});

test("#751: the rail column keeps bottom padding so the Settings button is not flush to the edge", () => {
  seedServers();
  const { container } = renderRail();
  const rail = container.querySelector<HTMLDivElement>('[data-testid="workspace-left-rail"]');
  assert.ok(rail, "left rail renders");
  assert.match(rail.className, /pb-2/, "rail column keeps bottom padding for the trailing Settings button");
});

// Teeth for cindyz's Elegant-adaptation pass on the public server page
// (#proj-frontend, "public server的页面几乎没有做elegant mode适配"). The public
// branch of LeftRail hand-rolled its rail from brutal-only utilities, so every
// theme rendered one identical yellow strip -- measured rgb(255,212,64) / 64px
// / 2px black border in Brutal, Elegant-light AND Elegant-dark on the
// pre-change build. jsdom has no CSS cascade, so the tooth is the className
// divergence itself: the rail now reads useThemeFamily() through rui's
// AppRail* slots, so Brutal and Elegant must NOT resolve to the same chrome.
// The old markup produced a byte-identical className under both providers,
// which is exactly what these assertions make impossible. Pixel proof is on
// the PR.

function renderPublicRail(theme: "brutal" | "elegant") {
  return render(
    <MemoryRouter initialEntries={["/s/open-team"]}>
      <TestIntlProvider>
        {/* syncDom=false: an isolated island must not mutate the app root. */}
        <ThemeProvider theme={theme} syncDom={false}>
          <LeftRail
            side="left"
            publicProjection={{
              server: { id: "s1", name: "Open Team", slug: "open-team", avatarUrl: null },
              authenticated: false,
              showHelp: true,
              activeMode: "chat",
              onSelectMode: () => {},
              onSelectSettingsTab: () => {},
              onAnonymousServerSelection: () => {},
            }}
          />
        </ThemeProvider>
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

function publicRail(theme: "brutal" | "elegant") {
  const { container } = renderPublicRail(theme);
  const rail = container.querySelector<HTMLDivElement>('[data-public-server-rail="true"]');
  assert.ok(rail, `public rail renders under the ${theme} provider`);
  return rail;
}

test("the public rail resolves different chrome per theme instead of one hardcoded brutal strip", () => {
  seedServers();
  const brutal = publicRail("brutal").className;
  cleanup();
  const elegant = publicRail("elegant").className;

  assert.notEqual(
    brutal,
    elegant,
    "Brutal and Elegant must not share one className — the pre-fix markup was theme-blind",
  );

  assert.match(brutal, /bg-primary/, "Brutal keeps the brand yellow surface (bg-primary -> brutal-yellow-400)");
  assert.match(brutal, /border-black/, "Brutal keeps its hard black rail border");
  assert.match(brutal, /w-16/, "Brutal keeps the 64px rail width");

  assert.match(elegant, /bg-layer-canvas-muted/, "Elegant takes the themed canvas surface");
  assert.match(elegant, /w-14/, "Elegant takes the narrower 56px rail");
  assert.ok(
    !/border-black/.test(elegant),
    "Elegant must not inherit the brutal black border — this was the visible defect",
  );
  assert.ok(
    !/bg-soft-signal/.test(elegant),
    "Elegant must not paint the brand yellow — this was the visible defect",
  );
});

test("the public rail is composed from rui AppRail* slots", () => {
  seedServers();
  const rail = publicRail("elegant");
  assert.deepEqual(
    [...rail.children].map((child) => child.getAttribute("data-slot")),
    ["app-rail-header", "app-rail-nav", "app-rail-footer"],
    "header/nav/footer must be the rui slots — the bespoke divs are where the brutal-only chrome lived",
  );
});

test("the public rail header takes its height from the shell, not from an override of its own", () => {
  seedServers();
  const { container } = renderPublicRail("elegant");
  const header = container.querySelector<HTMLDivElement>('[data-slot="app-rail-header"]');
  assert.ok(header, "public rail header renders");
  // The public page now mounts the rui AppShellRoot, which sets
  // --shell-header-height for every header row at once. A height pinned here
  // would let the rail drift from the other columns again.
  assert.doesNotMatch(
    header.className,
    /h-panel-header/,
    "the rail header must not carry the pre-shell height pin",
  );
});

test("the public rail's logo and tabs render through AppRailItem", () => {
  seedServers();
  const { container } = renderPublicRail("elegant");
  for (const testId of ["public-server-switcher-trigger", "left-rail-tab-chat", "left-rail-settings"]) {
    const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    assert.ok(button, `${testId} renders`);
    assert.ok(
      button.querySelector('[data-slot="app-rail-item-icon"]'),
      `${testId} must render through AppRailItem so its hover/selected states follow the theme`,
    );
  }
});

test("the public rail's server avatar is the standard rail item in Brutal too", () => {
  seedServers();
  const { container } = renderPublicRail("brutal");
  const trigger = container.querySelector<HTMLButtonElement>('[data-testid="public-server-switcher-trigger"]');
  assert.ok(trigger, "brutal server avatar renders");
  assert.ok(
    trigger.querySelector('[data-slot="app-rail-item-icon"]') !== null,
    "Brutal must render the avatar through AppRailItem, like the signed-in rail",
  );
  assert.doesNotMatch(trigger.className, /\bbg-black\b/, "the public-only black block is gone");
});
