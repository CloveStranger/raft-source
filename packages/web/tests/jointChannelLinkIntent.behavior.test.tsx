import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import JointChannelLinkIntent from "../src/components/channel/JointChannelLinkIntent";
import { useServerStore } from "../src/store/serverStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { TestIntlProvider } from "./helpers/intl";
function Receipt() { const { search, hash } = useLocation(); return <output data-testid="intent-location">{search}{hash}</output>; }
function mount(role?: "owner" | "member") {
  const server = role ? { id: "s1", slug: "s1", name: "Server", role, plan: "pro" } : null;
  useServerStore.setState({ current: server, servers: server ? [server] : [], members: [] } as never);
  useAuthStore.setState({ user: { id: "u1", name: "User" }, initialized: true } as never);
  return render(<MemoryRouter initialEntries={["/server/home?other=retained&dialog=create-joint-channel#anchor"]}><TestIntlProvider><JointChannelLinkIntent /><Receipt /></TestIntlProvider></MemoryRouter>);
}
afterEach(() => { cleanup(); useServerStore.setState({ current: null, servers: [], members: [] }); useAuthStore.setState({ user: null }); useChannelStore.setState(useChannelStore.getInitialState(), true); });
test("owner link opens the existing form without creating a channel, and cancel does not replay", async () => {
  const create = vi.spyOn(useChannelStore.getState(), "createChannel"); mount("owner");
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Create Joint Channel" })));
  assert.equal(create.mock.calls.length, 0);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.ok(screen.queryByRole("button", { name: "Create Joint Channel" }) === null));
  assert.equal(screen.getByTestId("intent-location").textContent, "?other=retained#anchor");
});
test.each([undefined, "member" as const])("missing server or permission silently consumes the dialog intent (%s)", async (role) => {
  mount(role); await waitFor(() => assert.equal(screen.getByTestId("intent-location").textContent, "?other=retained#anchor"));
  assert.ok(screen.queryByRole("button", { name: "Create Joint Channel" }) === null);
  assert.ok(screen.queryByRole("alert") === null);
});
