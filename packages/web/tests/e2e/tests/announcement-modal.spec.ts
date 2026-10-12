/**
 * Account-wide announcement dismissal, with one dialog and no pagination.
 * The fixture is pre-dismissed for the owner. Only the last test dismisses
 * it for extraHuman so earlier tests can verify read-only presentation.
 */
import { expect, request, test } from "@playwright/test";
import { loginViaApiWithCredentials } from "../fixtures/auth";
import { AUTH_STATE_PATH, waitForSeedState } from "../fixtures/seedState";

// Use a clean storage state — the shared auth.json is for the playwright
// owner who has the announcement pre-dismissed. We need to log in fresh as
// extraHuman for these specs.
test.use({ storageState: { cookies: [], origins: [] } });

async function loginAsExtraHumanInBrowser(page: import("@playwright/test").Page) {
  const seedState = await waitForSeedState();
  const apiCtx = await request.newContext();
  try {
    const login = await loginViaApiWithCredentials(apiCtx, seedState, {
      email: seedState.extraHuman.email,
      password: seedState.extraHuman.password,
    });
    await page.addInitScript(({ accessToken, refreshToken, serverSlug }) => {
      localStorage.setItem("slock_access_token", accessToken);
      localStorage.setItem("slock_refresh_token", refreshToken);
      localStorage.setItem("slock_last_server_slug", serverSlug);
    }, {
      accessToken: login.accessToken,
      refreshToken: login.refreshToken,
      serverSlug: seedState.server.slug,
    });
  } finally {
    await apiCtx.dispose();
  }
  return seedState;
}

test.describe.serial("P0 announcement modal contract", () => {
  test("undismissed user sees one dialog and reload preserves it before confirmation", async ({ page }) => {
    const seedState = await loginAsExtraHumanInBrowser(page);
    await page.goto(`/s/${seedState.server.slug}`);
    await expect(page.getByTestId("announcement-modal")).toBeVisible();
    await expect(page.getByTestId("announcement-title")).toHaveText(seedState.announcement.title);
    await expect(page.getByTestId("announcement-page-body")).toContainText("Announcement markdown body.");
    await expect(page.getByTestId("announcement-next")).toHaveCount(0);
    await expect(page.getByTestId("announcement-page-indicator")).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("announcement-modal")).toBeVisible();
  });

  test("Owner (pre-dismissed) never sees the modal", async ({ browser }) => {
    // The shared auth.json storage state is the playwright owner. Use it
    // straight here — the seed pre-inserted a dismissal row for them.
    const seedState = await waitForSeedState();
    const ctx = await browser.newContext({ storageState: AUTH_STATE_PATH });
    try {
      const page = await ctx.newPage();
      await page.goto(`/s/${seedState.server.slug}`);
      await expect(page.getByTestId("message-scroller")).toBeVisible();
      await expect(page.getByTestId("announcement-modal")).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });

  test("Enter dismisses once and reload does not resurface the announcement", async ({ page }) => {
    const seedState = await loginAsExtraHumanInBrowser(page);
    await page.goto(`/s/${seedState.server.slug}`);
    const modal = page.getByTestId("announcement-modal");
    await expect(modal).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(modal).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("announcement-modal")).toHaveCount(0);
  });
});
