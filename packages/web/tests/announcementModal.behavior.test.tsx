import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import api from "../src/api/client";
import AnnouncementModal from "../src/components/AnnouncementModal";
import { useAnnouncementStore } from "../src/store/announcementStore";
import { TestIntlProvider } from "./helpers/intl";

const announcement = {
  id: "10000000-0000-4000-8000-000000000001", title: "Product update", pages: [{ body: "**New** content" }],
  publishedAt: "2026-07-27T00:00:00.000Z", startsAt: "2026-07-27T00:00:00.000Z", endsAt: null, locale: "en" as const,
};
function RouteReceipt() { const location = useLocation(); return <output data-testid="route">{location.pathname}{location.search}</output>; }
function mount(locale: "en" | "zh-cn" = "en", suppressed = false) {
  return render(<MemoryRouter initialEntries={["/server/home"]}><TestIntlProvider locale={locale}><textarea aria-label="Background composer" /><AnnouncementModal suppressed={suppressed} /><RouteReceipt /></TestIntlProvider></MemoryRouter>);
}
afterEach(() => { cleanup(); useAnnouncementStore.getState().reset(); vi.restoreAllMocks(); });

test("onboarding suppression retains the pending announcement without opening a dialog", () => {
  useAnnouncementStore.setState({ pending: [announcement], loaded: true }); mount("en", true);
  assert.ok(screen.queryByTestId("announcement-modal") === null);
  assert.equal(useAnnouncementStore.getState().pending[0]?.id, announcement.id);
});
test("single dialog uses localized actions and no pagination", () => {
  useAnnouncementStore.setState({ pending: [announcement], loaded: true }); mount("zh-cn");
  assert.ok(screen.getByRole("button", { name: "关闭" })); assert.ok(screen.getByRole("button", { name: "知道了" }));
  assert.ok(screen.queryByTestId("announcement-page-indicator") === null);
  assert.ok(screen.queryByTestId("announcement-next") === null);
  assert.doesNotMatch(document.body.textContent ?? "", /common\.announcement\./);
});
test("Enter confirms once and does not reach the background composer", async () => {
  const post = vi.spyOn(api, "post").mockResolvedValue({ data: {} });
  useAnnouncementStore.setState({ pending: [announcement], loaded: true }); mount();
  const composer = screen.getByRole("textbox", { hidden: true }); const background = vi.fn(); composer.addEventListener("keydown", background);
  await act(async () => { fireEvent.keyDown(composer, { key: "Enter" }); fireEvent.keyDown(composer, { key: "Enter" }); });
  assert.equal(background.mock.calls.length, 0); assert.equal(post.mock.calls.length, 1);
  assert.ok(screen.queryByTestId("announcement-modal") === null);
});
test("IME Enter leaves the dialog undismissed", () => {
  const post = vi.spyOn(api, "post").mockResolvedValue({ data: {} });
  useAnnouncementStore.setState({ pending: [announcement], loaded: true }); mount();
  fireEvent.keyDown(window, { key: "Enter", isComposing: true }); assert.equal(post.mock.calls.length, 0);
  assert.ok(screen.getByTestId("announcement-modal"));
});
test("external CTA opens synchronously and records account dismissal", async () => {
  const post = vi.spyOn(api, "post").mockResolvedValue({ data: {} }); const open = vi.spyOn(window, "open").mockReturnValue(null);
  useAnnouncementStore.setState({ pending: [{ ...announcement, label: "Release", cta: { label: "Read more", href: "https://example.com/update" } }], loaded: true }); mount();
  assert.equal(screen.getByText("Release").textContent, "Release"); assert.ok(screen.getByRole("button", { name: "Got it" }));
  fireEvent.click(screen.getByRole("button", { name: "Read more" }));
  assert.deepEqual(open.mock.calls[0], ["https://example.com/update", "_blank", "noopener,noreferrer"]);
  await waitFor(() => assert.equal(post.mock.calls.length, 1));
});
test("internal CTA retains the current path for a feature-owned dialog intent", async () => {
  vi.spyOn(api, "post").mockResolvedValue({ data: {} });
  useAnnouncementStore.setState({ pending: [{ ...announcement, cta: { label: "Create channel", href: "?dialog=create-joint-channel" } }], loaded: true }); mount();
  fireEvent.click(screen.getByRole("button", { name: "Create channel" }));
  await waitFor(() => assert.equal(screen.getByTestId("route").textContent, "/server/home?dialog=create-joint-channel"));
  assert.ok(screen.queryByTestId("announcement-modal") === null);
});
test("secondary confirmation dismisses without opening the CTA", async () => {
  const post = vi.spyOn(api, "post").mockResolvedValue({ data: {} }); const open = vi.spyOn(window, "open").mockReturnValue(null);
  useAnnouncementStore.setState({ pending: [{ ...announcement, cta: { label: "Read more", href: "https://example.com" } }], loaded: true }); mount();
  fireEvent.click(screen.getByRole("button", { name: "Got it" }));
  await waitFor(() => assert.equal(post.mock.calls.length, 1)); assert.equal(open.mock.calls.length, 0);
});
test("an image is served through the publication-gated image endpoint with localized alt text", () => {
  useAnnouncementStore.setState({ pending: [{ ...announcement, image: { assetId: announcement.id, alt: "Channel diagram" } }], loaded: true }); mount();
  const image = screen.getByRole("img", { name: "Channel diagram" }); assert.match(image.getAttribute("src") ?? "", new RegExp(`/announcements/images/${announcement.id}$`));
});
