import { expect } from "@playwright/test";
import type { APIRequestContext, Browser, Page } from "@playwright/test";
import { test } from "../fixtures/scenario";

/**
 * The public server page (`/s/<slug>` for a visitor who is not a member) is a
 * separate page from the signed-in shell, built from the same rui parts: the
 * app shell, the rail, and the Sidebar root and rows. It drifted from the
 * signed-in look more than once because nothing compared the two (a yellow
 * rail in Elegant, 62px headers next to 56px ones, a pink selected channel).
 *
 * This spec renders both in one browser, per theme, and requires the shared
 * chrome to measure the same: rail, channel-column frame and header, scroll
 * surface, the column width, the selected and unselected channel row, and
 * the channel panel header with the line under it.
 *
 * The signed-in side is the real app on a tenant of its own (it adds a second
 * channel so there is an unselected row to measure). The public side mocks only the
 * three public read endpoints; the page itself is the real built bundle. So
 * this guards the chrome, not the public API.
 *
 * Not compared, because the two differ by design: column height (the public
 * page has a bottom banner), the header title text, the section label row
 * (the signed-in one is a collapse toggle with a sort menu), and anything
 * below `md`, where the signed-in app switches to tabs.
 */

const THEMES = {
  brutal: { mode: "light", lightThemeId: "brutal", darkThemeId: "elegant" },
  "elegant-light": { mode: "light", lightThemeId: "elegant", darkThemeId: "elegant" },
  "elegant-dark": { mode: "dark", lightThemeId: "elegant", darkThemeId: "elegant" },
} as const;

const PUBLIC_SLUG = "parity-public-fixture";
const PUBLIC_FIXTURE = {
  server: { id: "parity-server", name: "Parity Fixture", slug: PUBLIC_SLUG, avatarUrl: null },
  channels: [
    { id: "parity-channel-1", name: "announcements", description: null },
    { id: "parity-channel-2", name: "general", description: null },
  ],
  canJoinAsGuest: false,
};

type Surface = "signed-in" | "public";

/** Runs in the page. Returns only values that must match across the two surfaces. */
function measureChrome(surface: Surface) {
  const style = (el: Element, keys: string[]) => {
    const computed = getComputedStyle(el) as unknown as Record<string, string>;
    return Object.fromEntries(keys.map((key) => [key, computed[key]]));
  };
  const height = (el: Element) => Math.round(el.getBoundingClientRect().height * 10) / 10;
  const need = <T,>(value: T | null | undefined, what: string): T => {
    if (value == null) throw new Error(`parity probe: ${what} not found on the ${surface} surface`);
    return value;
  };

  const rail = need(document.querySelector('[data-slot="app-rail-root"]'), "rail");
  const railHeader = need(rail.querySelector('[data-slot="app-rail-header"]'), "rail header");
  const sidebar = need(
    surface === "public"
      ? document.querySelector('[data-testid="public-server-channel-sidebar-root"]')
      : document.querySelector('[data-testid="sidebar-root"]'),
    "channel column",
  );
  const header = need(
    [...sidebar.children].find((child) => child.classList.contains("h-panel-header")),
    "channel column header",
  );
  const title = need(header.firstElementChild, "channel column title");
  const scroller = need(
    sidebar.querySelector(
      surface === "public" ? '[data-testid="public-server-channel-list"]' : '[data-testid="sidebar-scroll-surface"]',
    ),
    "scroll surface",
  );
  const rows = [
    ...sidebar.querySelectorAll(surface === "public" ? "[data-public-channel-id]" : "[data-sidebar-channel-id]"),
  ];
  const activeRow = need(rows.find((row) => row.hasAttribute("data-active")), "selected channel row");
  const idleRow = need(rows.find((row) => !row.hasAttribute("data-active")), "unselected channel row");

  // The line under the channel header is drawn by the conversation panel frame
  // around it, not by the header, so a header placed outside that frame keeps
  // its classes and silently loses the line.
  const main = need(document.querySelector('[data-slot="app-shell-main-slot"]'), "main column");
  const panelHeader = need(main.querySelector('[data-slot="panel-header"]'), "channel panel header");
  const panelFrame = need(panelHeader.parentElement, "channel panel frame");

  const ROW = [
    "backgroundColor", "color", "borderTopWidth", "borderTopColor", "borderRadius", "boxShadow",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "marginBottom", "columnGap",
    "fontSize", "fontWeight",
  ];
  const rowIcon = (row: Element) => {
    const icon = need(row.querySelector("svg"), "channel row icon");
    const box = icon.getBoundingClientRect();
    return { width: box.width, height: box.height, color: getComputedStyle(icon).color };
  };

  return {
    rail: { width: rail.getBoundingClientRect().width, ...style(rail, ["backgroundColor"]) },
    railHeaderHeight: height(railHeader),
    // Both columns are resizable; each test starts from a fresh browser context, so both sit at the default width.
    column: {
      width: sidebar.getBoundingClientRect().width,
      ...style(sidebar, ["backgroundColor", "borderRightWidth", "borderRightColor"]),
    },
    header: {
      height: height(header),
      ...style(header, ["backgroundColor", "borderBottomWidth", "borderBottomColor", "paddingLeft"]),
    },
    title: style(title, ["fontSize", "fontWeight", "color"]),
    panelHeader: {
      height: height(panelHeader),
      ...style(panelHeader, ["borderBottomWidth", "borderBottomColor", "backgroundColor"]),
      frameBackgroundColor: getComputedStyle(panelFrame).backgroundColor,
    },
    scroller: style(scroller, ["paddingLeft", "paddingRight", "paddingTop"]),
    activeRow: { height: height(activeRow), ...style(activeRow, ROW), icon: rowIcon(activeRow) },
    idleRow: { height: height(idleRow), ...style(idleRow, ROW), icon: rowIcon(idleRow) },
  };
}

async function settle(page: Page) {
  // Row and hairline colours transition; sample the resting state, with the
  // pointer parked away from every row.
  await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
  await page.mouse.move(900, 500);
}

async function createChannel(
  request: APIRequestContext,
  apiUrl: string,
  serverId: string,
  accessToken: string,
  name: string,
) {
  const response = await request.post(`${apiUrl}/api/channels`, {
    headers: { Authorization: `Bearer ${accessToken}`, "X-Server-Id": serverId },
    data: { name },
  });
  if (!response.ok()) throw new Error(`Failed to create channel: ${response.status()} ${response.statusText()}`);
}

async function measureSignedIn(page: Page, webUrl: string, serverSlug: string, channelId: string) {
  await page.goto(`${webUrl}/s/${serverSlug}`);
  const seedRow = page.locator(`[data-sidebar-channel-id="${channelId}"]`);
  await expect(seedRow).toBeVisible({ timeout: 20_000 });
  await seedRow.click();
  await expect(seedRow).toHaveAttribute("data-active", "true");
  await settle(page);
  return page.evaluate(measureChrome, "signed-in" as Surface);
}

async function measurePublic(browser: Browser, webUrl: string, theme: (typeof THEMES)[keyof typeof THEMES]) {
  // A fresh context with no session: the visitor is anonymous.
  const context = await browser.newContext({ storageState: undefined, viewport: { width: 1280, height: 800 } });
  try {
    await context.addInitScript((prefs) => {
      localStorage.setItem("slock-theme-preferences-v2", JSON.stringify(prefs));
    }, theme);
    const page = await context.newPage();
    const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    await page.route(`**/api/public/servers/${PUBLIC_SLUG}`, (route) => route.fulfill(json(PUBLIC_FIXTURE)));
    await page.route(`**/api/public/servers/${PUBLIC_SLUG}/channels/*/messages*`, (route) =>
      route.fulfill(json({ messages: [] })));
    await page.goto(`${webUrl}/s/${PUBLIC_SLUG}`);
    await expect(page.getByTestId("public-server-page")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("[data-public-channel-id][data-active]")).toHaveCount(1);
    await settle(page);
    const chrome = await page.evaluate(measureChrome, "public" as Surface);
    const mainHeaderHeight = await page
      .getByTestId("public-server-channel-header")
      .evaluate((el) => Math.round(el.getBoundingClientRect().height * 10) / 10);
    return { chrome, mainHeaderHeight };
  } finally {
    await context.close();
  }
}

test.describe("public server page matches the signed-in chrome", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  for (const [themeName, theme] of Object.entries(THEMES)) {
    test(`${themeName}: rail, channel column and rows measure the same`, async ({ page, browser, request, scenario }) => {
      const seedState = scenario.seed;
      await createChannel(request, seedState.urls.api, seedState.server.id, scenario.login.accessToken, "parity-second");
      await page.addInitScript((prefs) => {
        localStorage.setItem("slock-theme-preferences-v2", JSON.stringify(prefs));
      }, theme);

      const signedIn = await measureSignedIn(page, seedState.urls.web, seedState.server.slug, seedState.channel.id);
      const publicPage = await measurePublic(browser, seedState.urls.web, theme);

      expect(publicPage.chrome, "public page chrome must measure like the signed-in chrome").toEqual(signedIn);
      // The three header rows of the public page share one baseline.
      expect(publicPage.mainHeaderHeight, "public channel header height").toBe(publicPage.chrome.header.height);
      expect(publicPage.chrome.railHeaderHeight, "public rail header height").toBe(publicPage.chrome.header.height);
    });
  }
});
