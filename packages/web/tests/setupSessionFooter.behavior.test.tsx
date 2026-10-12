import "./helpers/domSetup";

import assert from "node:assert/strict";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import SetupSessionFooter from "../src/components/onboarding/SetupSessionFooter";
import { useServerStore } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

const render: typeof rtlRender = (ui, options) =>
  rtlRender(ui, { wrapper: TestIntlProvider, ...options });

const originalClearCurrent = useServerStore.getState().clearCurrent;
const originalDeleteServer = useServerStore.getState().deleteServer;

function seedServer(role: "owner" | "admin") {
  useServerStore.setState({
    current: { id: "server-1", name: "Acme", slug: "acme", role } as never,
    members: [],
  });
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
  useServerStore.setState({ clearCurrent: originalClearCurrent, deleteServer: originalDeleteServer, current: null, members: [] });
});

test("setup escape link navigates to the Choose server page without logging out", () => {
  let clearCurrentCalls = 0;
  useServerStore.setState({
    clearCurrent: () => {
      clearCurrentCalls += 1;
    },
  });

  window.history.replaceState({}, "", "/s/test/setup");
  render(<SetupSessionFooter />);

  fireEvent.click(screen.getByTestId("setup-switch-server"));
  assert.equal(clearCurrentCalls, 1);
  assert.equal(window.location.pathname, "/servers");
  assert.equal(screen.queryByTestId("setup-log-out"), null);
});

test("setup escape link is disabled with the owning setup action", () => {
  render(<SetupSessionFooter disabled />);

  assert.equal((screen.getByTestId("setup-switch-server") as HTMLButtonElement).disabled, true);
  assert.equal(screen.queryByTestId("setup-start-over"), null);
});

// task #141: a server stuck in setup (e.g. before its first computer) could not
// be deleted — Delete lived only in Settings, under the blocking setup modal.
test("the owner can delete the server from setup, behind the same slug confirmation", async () => {
  let deleteCalls = 0;
  seedServer("owner");
  useServerStore.setState({ deleteServer: async () => { deleteCalls += 1; } });
  render(<SetupSessionFooter />);

  fireEvent.click(screen.getByTestId("setup-delete-server"));
  const confirm = await screen.findByTestId("server-delete-confirm-button");
  assert.equal((confirm as HTMLButtonElement).disabled, true, "confirm stays disabled until the slug is typed");
  fireEvent.change(screen.getByTestId("server-delete-slug-input"), { target: { value: "acme" } });
  assert.equal((confirm as HTMLButtonElement).disabled, false);
  fireEvent.click(confirm);
  await waitFor(() => assert.equal(deleteCalls, 1));
});

test("only the owner gets the delete escape (the API refuses everyone else)", () => {
  seedServer("admin");
  render(<SetupSessionFooter />);
  assert.ok(screen.queryByTestId("setup-delete-server") === null);
  assert.ok(screen.getByTestId("setup-switch-server"));
});
