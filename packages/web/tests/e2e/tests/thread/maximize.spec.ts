import { expect, test } from "@playwright/test";
import { waitForSeedState } from "../../fixtures/seedState";

test("Maximize folds the channel, restores its width, and retains the thread", async ({ page }) => {
  const seed = await waitForSeedState();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/s/${seed.server.slug}/channel/${seed.channel.id}?thread=${seed.channel.id}:${seed.messages.focusMessageId}`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("thread-overflow-trigger").waitFor({ timeout: 60_000 });
  const side = page.getByTestId("thread-side-column");
  const main = page.locator(".thread-main-column");
  await expect(main).toBeVisible();
  const root = await side.locator('[data-slot="thread-panel-root"]').elementHandle();
  expect(root).not.toBeNull();
  const scroller = main.getByTestId("message-scroller");
  await scroller.evaluate((node) => { node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight - 300); node.dispatchEvent(new Event("scroll")); });
  await page.waitForTimeout(250);
  const originalScroll = await scroller.evaluate((node) => node.scrollTop);
  const originalWidth = (await side.boundingBox())!.width;
  const persistedWidth = await page.evaluate(() => localStorage.getItem("slock:threadPanelWidth"));
  await page.getByTestId("thread-overflow-trigger").click();
  await expect(page.getByRole("menuitem").first()).toHaveText("Focus mode");
  await page.getByTestId("thread-overflow-maximize").click();
  await expect(main).toBeHidden();
  expect((await side.locator('[data-slot="thread-panel-root"]').boundingBox())!.width).toBeGreaterThan(originalWidth);
  expect((await side.boundingBox())!.width).toBe(originalWidth);
  await page.getByTestId("thread-overflow-trigger").click();
  await expect(page.getByRole("menuitem").first()).toHaveText("Standard mode");
  await page.getByTestId("thread-overflow-maximize").click();
  await expect(main).toBeVisible();
  expect((await side.boundingBox())!.width).toBe(originalWidth);
  await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBe(originalScroll);
  expect(await side.locator('[data-slot="thread-panel-root"]').evaluate((node, original) => node === original, root)).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem("slock:threadPanelWidth"))).toBe(persistedWidth);
  await page.getByTestId("thread-overflow-trigger").click();
  await page.getByTestId("thread-overflow-maximize").click();
  await page.getByTestId("thread-parent-avatar").click();
  const profile = page.getByTestId("profile-panel");
  await expect(profile).toBeVisible();
  await expect(page.getByTestId("thread-layout-container")).toHaveAttribute("data-thread-maximized", "false");
  expect(await profile.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  })).toBe(true);

});

test("phone thread menu omits the channel layout action", async ({ page }) => {
  const seed = await waitForSeedState();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/s/${seed.server.slug}/channel/${seed.channel.id}?thread=${seed.channel.id}:${seed.messages.focusMessageId}`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("thread-overflow-trigger").waitFor({ timeout: 60_000 });
  await page.getByTestId("thread-overflow-trigger").click();
  await expect(page.getByTestId("thread-overflow-menu")).toBeVisible();
  await expect(page.getByTestId("thread-overflow-maximize")).toHaveCount(0);
});
