// @ts-nocheck
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import NotificationTrigger from "../src/components/layout/NotificationTrigger";
import type { NotificationEntry } from "../src/components/layout/useSystemNotifications";
import { TestIntlProvider } from "./helpers/intl";

const unread: NotificationEntry[] = [
  {
    id: "needs-attention",
    kind: "warning",
    title: "Needs attention",
    body: "Review this notification.",
  },
];

function renderTrigger(
  flavor: "rail-bottom" | "mobile-navbar",
  notifications: NotificationEntry[],
  direction: "ltr" | "rtl" = "ltr",
) {
  return render(
    <MemoryRouter>
      <TestIntlProvider>
        <div dir={direction}>
          <NotificationTrigger flavor={flavor} notifications={notifications} />
        </div>
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

function railUnreadDot(): Element | null {
  return document.querySelector('[data-testid="notification-trigger-rail"] [data-slot="app-rail-item-indicator"]');
}


test("the permanent rail Bell opens an empty drawer without an unread dot", () => {
  renderTrigger("rail-bottom", []);

  const trigger = screen.getByTestId("notification-trigger-rail");
  assert.equal(trigger.getAttribute("aria-label"), "Notification center");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(trigger.getAttribute("data-state"), "closed");
  assert.equal(trigger.getAttribute("data-has-unread"), "false");
  assert.equal(railUnreadDot(), null);
  assert.match(trigger.className, /border-transparent/);
  assert.doesNotMatch(trigger.className, /shadow-brutal-sm/);

  fireEvent.click(trigger);

  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.equal(trigger.getAttribute("data-state"), "open");
  assert.match(trigger.className, /border-black/);
  assert.match(trigger.className, /shadow-brutal-sm/);
  assert.ok(screen.getByRole("dialog", { name: "Notification center" }));
  assert.ok(screen.getByText("No notifications right now"));
  assert.ok(screen.getByText("You'll see things here that need your attention."));
});

test("the rail Bell icon follows the rail item icon recipe (size + state-following color)", () => {
  // task #720: cindyz flagged the Bell icon itself looking different from the
  // other rail icons. Siblings are 16px foreground-icon (brightening on item
  // hover) in elegant and 18px foreground-strong in brutal; the Bell used to
  // be a hardcoded 18px foreground-muted/black that never changed state.
  try {
    renderTrigger("rail-bottom", []);
    const svg = document.querySelector('[data-testid="notification-trigger-rail"] svg');
    assert.ok(svg, "the Bell icon renders");
    assert.match(svg.getAttribute("class") ?? "", /text-\[var\(--foreground-icon\)\]/, "elegant color comes from the rail recipe var");
    assert.match(svg.getAttribute("class") ?? "", /group-hover:text-\[var\(--foreground-strong\)\]/, "color follows the button's hover state");
    assert.match(svg.getAttribute("class") ?? "", /theme-brutal:text-\[var\(--foreground-strong\)\]/, "brutal color comes from the rail recipe var");
    assert.match(svg.getAttribute("class") ?? "", /theme-brutal:size-\[18px\]/, "brutal keeps the 18px rail icon size");
    assert.match(svg.getAttribute("class") ?? "", /(^|\s)size-4(\s|$)/, "elegant uses the 16px rail icon size");
    assert.doesNotMatch(svg.getAttribute("class") ?? "", /text-black/, "no hardcoded color that ignores theme state");
  } finally {
    cleanup();
  }
});

test("unread attention and open disclosure remain independent states", () => {
  const { rerender } = renderTrigger("rail-bottom", unread);

  const trigger = screen.getByTestId("notification-trigger-rail");
  assert.equal(trigger.getAttribute("aria-label"), "Notification center (1 active)");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(trigger.getAttribute("data-state"), "closed");
  assert.equal(trigger.getAttribute("data-has-unread"), "true");
  assert.match(trigger.className, /border-transparent/);
  assert.doesNotMatch(trigger.className, /shadow-brutal-sm/);

  const dot = railUnreadDot();
  assert.ok(dot, "unread renders the shared rail indicator");
  assert.equal(dot.getAttribute("aria-hidden"), "true");
  // task #720: the rail dot must ride the rail's shared attention composite —
  // the same AppRailItemAttention (mask + indicator + sr-only title) every
  // other rail item uses, not a one-off Status dot with a hand-set offset.
  assert.match(dot.className, /-right-1/);
  assert.match(dot.className, /top-\[-2px\]/);
  const iconAnchor = dot.parentElement;
  assert.equal(iconAnchor?.classList.contains("relative"), true, "dot anchors to the Bell, not the button edge");
  assert.ok(
    iconAnchor?.querySelector('[data-slot="app-rail-item-attention-mask"]'),
    "the rail attention mask accompanies the indicator (elegant notch recipe)",
  );
  assert.ok(
    iconAnchor?.querySelector('span.sr-only'),
    "the composite keeps the sr-only unread announcement like LeftRail's dots",
  );

  fireEvent.click(trigger);
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.equal(trigger.getAttribute("data-state"), "open");
  assert.ok(screen.getByText("Needs attention"));

  rerender(
    <MemoryRouter>
      <TestIntlProvider>
        <div dir="ltr">
          <NotificationTrigger flavor="rail-bottom" notifications={[]} />
        </div>
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.equal(trigger.getAttribute("aria-expanded"), "true", "draining the last row must not close the drawer");
  assert.equal(trigger.getAttribute("data-has-unread"), "false");
  assert.equal(railUnreadDot(), null);
  assert.ok(screen.getByText("No notifications right now"));
});

test("desktop popover trigger keeps its counted aria label without also rendering a Tooltip trigger", () => {
  renderTrigger("rail-bottom", unread);

  const trigger = screen.getByTestId("notification-trigger-rail");
  assert.equal(trigger.getAttribute("aria-label"), "Notification center (1 active)");
  assert.equal(trigger.getAttribute("title"), null, "rail trigger must use raft-ui Tooltip instead of native title");
  assert.equal(trigger.getAttribute("data-slot"), "popover-trigger");
  assert.equal(trigger.hasAttribute("data-base-ui-tooltip-trigger"), false);
});

test("mobile keeps the Bell but not Help semantics, and RTL keeps the dot inside the icon anchor", () => {
  renderTrigger("mobile-navbar", unread, "rtl");

  const trigger = screen.getByTestId("notification-trigger-mobile");
  const dot = screen.getByTestId("notification-trigger-mobile-unread-dot");
  assert.equal(trigger.getAttribute("data-state"), "closed");
  assert.equal(trigger.getAttribute("data-has-unread"), "true");
  assert.match(trigger.className, /size-8/);
  assert.match(dot.className, /-end-1/);
  assert.doesNotMatch(dot.className, /-(?:left|right)-/);
  assert.equal(dot.parentElement?.parentElement, trigger, "dot remains inside the viewport-safe button box");

  fireEvent.click(trigger);
  assert.ok(screen.getByRole("dialog", { name: "Notification center" }));
});

test("server-backed seen state clears the dot without hiding the active card", () => {
  const onSeen = vi.fn();
  const notification: NotificationEntry = {
    id: "usage-limit:activation-1",
    kind: "warning",
    title: "Codex usage limit reached",
    body: "One agent may pause.",
    unread: false,
    onSeen,
  };
  renderTrigger("rail-bottom", [notification]);

  const trigger = screen.getByTestId("notification-trigger-rail");
  assert.equal(trigger.getAttribute("data-has-unread"), "false");
  assert.equal(railUnreadDot(), null);
  fireEvent.click(trigger);
  assert.ok(screen.getByText("Codex usage limit reached"), "seen does not mean resolved or dismissed");
  assert.equal(onSeen.mock.calls.length, 0, "a previously seen activation does not rewrite its receipt");
});

test("opening the center writes the unseen activation receipt", () => {
  const onSeen = vi.fn();
  renderTrigger("rail-bottom", [{
    id: "usage-limit:activation-2",
    kind: "warning",
    title: "Claude usage limit reached",
    body: "Two agents may pause.",
    unread: true,
    onSeen,
  }]);

  fireEvent.click(screen.getByTestId("notification-trigger-rail"));
  assert.equal(onSeen.mock.calls.length, 1);
});
