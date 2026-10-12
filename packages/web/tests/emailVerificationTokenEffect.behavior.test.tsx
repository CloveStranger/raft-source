import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, waitFor } from "@testing-library/react";
import { TestIntlProvider, renderWithIntl as render } from "./helpers/intl";
import EmailVerificationPage from "../src/components/auth/EmailVerificationPage";
import { useAuthStore } from "../src/store/authStore";

/**
 * task #709 (Josh's review): the auto-verify effect must fire only when
 * `initialToken` changes. A locale switch produces a new `formatMessage`
 * identity — before the useEffectEvent fix, that cascaded into a new
 * `handleVerify` identity and re-ran the effect, re-verifying an
 * already-consumed token (success screen flipping to a failure banner).
 */

const initialAuthState = useAuthStore.getInitialState();

afterEach(() => {
  cleanup();
  useAuthStore.setState(initialAuthState, true);
});

test("a locale switch does not re-verify an already-consumed token", async () => {
  let verifyCalls = 0;
  useAuthStore.setState({
    ...initialAuthState,
    verifyEmail: async () => {
      verifyCalls += 1;
    },
    resendVerification: async () => {},
    logout: async () => {},
    user: null,
    initialized: true,
  } as never);

  const { rerender } = render(<EmailVerificationPage initialToken="token-abc" />);
  await waitFor(() => assert.equal(verifyCalls, 1));

  // New IntlProvider (different locale ⇒ new formatMessage identity): the
  // effect must NOT fire again.
  rerender(
    <TestIntlProvider locale="zh-cn">
      <EmailVerificationPage initialToken="token-abc" />
    </TestIntlProvider>,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(verifyCalls, 1);
});
