import { useMemo } from "react";
import { useIntl } from "react-intl";

import AccountIdentitySetupPage from "../components/auth/AccountIdentitySetupPage";
import RegisterPage from "../components/auth/RegisterPage";
import { accountBootstrapPreviewUser } from "../dev/accountBootstrapPreviewFixtures";
import type { AuthProvider } from "../hooks/useAuthProviders";

function ignoreSwitchToLogin() {}

async function completePreview() {}

export default function AccountBootstrapPreviewPage() {
  const { formatMessage } = useIntl();
  const previewProviders = useMemo<AuthProvider[]>(
    () => [
      { id: "google", label: formatMessage({ id: "brand.google" }), enabled: true },
      { id: "github", label: formatMessage({ id: "brand.github" }), enabled: true },
      { id: "apple", label: formatMessage({ id: "brand.apple" }), enabled: true },
    ],
    [formatMessage],
  );
  const view = new URLSearchParams(window.location.search).get("view") ?? "create";
  if (view === "create") {
    return (
      <RegisterPage
        onSwitchToLogin={ignoreSwitchToLogin}
        previewProviders={previewProviders}
      />
    );
  }

  const provider = view === "google"
    ? "google"
    : view === "github"
      ? "github"
      : view === "apple"
        ? "apple"
        : null;
  return (
    <AccountIdentitySetupPage
      previewUser={accountBootstrapPreviewUser(provider)}
      onPreviewComplete={completePreview}
    />
  );
}
