import { useState, useCallback } from "react";
import { Input, Button, TextSans } from "raft-ui";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";
import { useAuthStore } from "../../store/authStore";
import type { SocialAuthProviderId } from "../../hooks/useAuthProviders";
import { useAuthProviders } from "../../hooks/useAuthProviders";
import { buildSocialAuthStartUrl, getCurrentReturnTo, getExternalBrowserLoginUrl, isEmbeddedBrowser } from "../../utils/socialAuth";
import AuthPageFrame, { AuthPageIntro } from "./AuthPageFrame";
import TextLink from "../ui/TextLink";
import Banner from "../ui/Banner";
import FormField from "../ui/FormField";
import { AUTH_MESSAGE_IDS, authServerErrorMessage, isValidEmailFormat } from "./authErrors";
import OpenInBrowserSignInGuide from "./OpenInBrowserSignInGuide";
import SocialProviderButton from "./SocialProviderButton";

interface LoginPageProps {
  onSwitchToRegister?: () => void;
  onForgotPassword: () => void;
}

export default function LoginPage({ onSwitchToRegister, onForgotPassword }: LoginPageProps) {
  const { formatMessage } = useIntl();
  const login = useAuthStore((s) => s.login);
  const loading = useAuthStore((s) => s.loading);
  const { enabledProviders } = useAuthProviders();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [showOpenInBrowserGuide, setShowOpenInBrowserGuide] = useState(false);

  const handleSocialLogin = useCallback((providerId: SocialAuthProviderId) => {
    if (isEmbeddedBrowser()) {
      setShowOpenInBrowserGuide(true);
      return;
    }
    window.location.href = buildSocialAuthStartUrl(providerId, getCurrentReturnTo());
  }, []);

  const handleBackFromGuide = useCallback(() => {
    setShowOpenInBrowserGuide(false);
  }, []);

  const handleEmailChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setEmail(e.target.value);
    if (fieldErrors.email) setFieldErrors((current) => ({ ...current, email: undefined }));
  }, [fieldErrors.email]);

  const handlePasswordChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setPassword(e.target.value);
    if (fieldErrors.password) setFieldErrors((current) => ({ ...current, password: undefined }));
  }, [fieldErrors.password]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setFieldErrors({});
    if (!isValidEmailFormat(email)) {
      setFieldErrors({ email: formatMessage({ id: AUTH_MESSAGE_IDS.invalidEmail }) });
      return;
    }
    if (!password) {
      setFieldErrors({ password: formatMessage({ id: AUTH_MESSAGE_IDS.passwordRequired }) });
      return;
    }
    try {
      await login(email, password);
    } catch (err: any) {
      setError(authServerErrorMessage(err, formatMessage({ id: "pages.login.failed" }), formatMessage));
    }
  };

  if (showOpenInBrowserGuide) {
    return (
      <OpenInBrowserSignInGuide
        loginUrl={getExternalBrowserLoginUrl()}
        onBack={handleBackFromGuide}
      />
    );
  }

  return (
    <AuthPageFrame>
      <div className="w-full">
        <AuthPageIntro title={formatMessage({ id: "pages.login.title" })} />

        {error && (
          <Banner intent="warning" className="mb-4 font-bold">{error}</Banner>
        )}

        <form onSubmit={handleSubmit} className="space-y-4" autoComplete="on" noValidate>
          <FormField label={formatMessage({ id: "pages.login.emailLabel" })} labelStyle="plain" error={fieldErrors.email} htmlFor="login-email">
            <Input
              id="login-email"
              name="username"
              type="email"
              autoComplete="username"
              value={email}
              onChange={handleEmailChange}
              data-invalid={fieldErrors.email ? true : undefined}
              required
            />
          </FormField>
          <FormField
            label={formatMessage({ id: "pages.login.passwordLabel" })}
            labelStyle="plain"
            labelAction={(
              <TextLink variant="muted" className="text-sm" onClick={onForgotPassword}>
                {formatMessage({ id: "pages.login.forgotPassword" })}
              </TextLink>
            )}
            error={fieldErrors.password}
            htmlFor="login-password"
          >
            <Input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={handlePasswordChange}
              data-invalid={fieldErrors.password ? true : undefined}
              required
            />
          </FormField>
          <Button
            type="submit"
            disabled={loading}
            size="lg"
            variant="accent"
            className="w-full"
          >
            {loading
            ? formatMessage({ id: "pages.login.signingIn" })
            : formatMessage({ id: "pages.login.submit" })}
          </Button>
        </form>

        {enabledProviders.length > 0 && (
          <>
            <div className="my-4 flex items-center gap-3">
              <div className="h-0.5 flex-1 bg-line-strong theme-brutal:bg-black" />
              <span className="text-xs font-bold uppercase tracking-widest text-foreground-muted theme-brutal:text-black/45">
                {formatMessage({ id: "pages.login.or" })}
              </span>
              <div className="h-0.5 flex-1 bg-line-strong theme-brutal:bg-black" />
            </div>
            <div className="space-y-2">
              {enabledProviders.map((provider) => (
                <SocialProviderButton
                  key={provider.id}
                  providerId={provider.id}
                  label={provider.label}
                  onClick={handleSocialLogin}
                />
              ))}
            </div>
          </>
        )}

        {onSwitchToRegister && (
          <TextSans size="small" className="mt-4 text-center theme-brutal:text-black/60">
            {formatMessage(
              { id: "pages.login.noAccountPrompt" },
              {
                create: (c: ReactNode) => (
                  <TextLink key="create" variant="primary" onClick={onSwitchToRegister}>
                    {c}
                  </TextLink>
                ),
              },
            )}
          </TextSans>
        )}

        <TextSans size="caption" className="mt-6 text-center leading-5 theme-brutal:text-black/60">
          {formatMessage(
            { id: "pages.login.legalAgreement" },
            {
              terms: (c: ReactNode) => (
                <a
                  key="terms"
                  href={CURRENT_LEGAL_ACCEPTANCE.termsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-foreground-strong theme-brutal:hover:text-black"
                >
                  {c}
                </a>
              ),
              privacy: (c: ReactNode) => (
                <a
                  key="privacy"
                  href={CURRENT_LEGAL_ACCEPTANCE.privacyUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-foreground-strong theme-brutal:hover:text-black"
                >
                  {c}
                </a>
              ),
            },
          )}
        </TextSans>
      </div>
    </AuthPageFrame>
  );
}
