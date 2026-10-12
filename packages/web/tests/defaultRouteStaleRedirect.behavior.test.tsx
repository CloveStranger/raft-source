import assert from "node:assert/strict";
import { act } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import { __testInternals } from "../src/components/layout/MainLayout";
import { useChannelStore } from "../src/store/channelStore";
import { useServerStore } from "../src/store/serverStore";

// Switching servers twice quickly (desktop ⌘⇧] / ⌘1, or two switcher clicks)
// bounced users back to the first server: BrowserRouter pushes history at once
// but renders the new location in a transition, so DefaultRoute could still
// render for /s/<a> once a's channels loaded and `replace` the NEWER entry with
// a's default channel. The redirect must only fire while history is still the
// location it rendered for.

const DefaultRoute = __testInternals.DefaultRoute;
const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: query === "(min-width: 768px)", media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  useServerStore.setState({ current: { id: "server-two", slug: "two", name: "Two", role: "owner" } } as never);
  useChannelStore.setState({ channels: [], loading: true } as never);
});

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
  useServerStore.setState(useServerStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  window.history.replaceState(null, "", "/");
});

const channel = { id: "c1", serverId: "server-two", name: "general", type: "regular" };

test("a server landing redirects to its first channel once channels load", async () => {
  window.history.replaceState(null, "", "/s/two");
  render(<BrowserRouter><DefaultRoute /></BrowserRouter>);
  await act(async () => { useChannelStore.setState({ channels: [channel], loading: false } as never); });
  await waitFor(() => assert.equal(window.location.pathname, "/s/two/channel/c1"));
});

test("a late landing redirect never overwrites a newer navigation", async () => {
  window.history.replaceState(null, "", "/s/two");
  render(<BrowserRouter><DefaultRoute /></BrowserRouter>);
  // The user already moved on: history has the newer entry, the router has not
  // rendered it yet (BrowserRouter only re-renders on its own navigations).
  window.history.pushState(null, "", "/s/one/channel/x");
  await act(async () => { useChannelStore.setState({ channels: [channel], loading: false } as never); });
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  assert.equal(window.location.pathname, "/s/one/channel/x", "the stale redirect replaced the newer history entry");
});
