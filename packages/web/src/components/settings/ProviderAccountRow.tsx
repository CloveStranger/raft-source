import { Button } from "raft-ui";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import type { AuthProvider } from "../../hooks/useAuthProviders";
import { SocialProviderIcon } from "./SettingsPanel";

export function ProviderAccountRow({
  provider,
  identity,
  linking,
  onConnect,
  onRequestDisconnect,
}: {
  provider: AuthProvider;
  identity: { providerEmail: string | null } | undefined;
  linking: boolean;
  onConnect: (provider: AuthProvider) => void;
  onRequestDisconnect: (provider: AuthProvider) => void;
}) {
  const { formatMessage } = useIntl();
  const handleConnect = useCallback(() => onConnect(provider), [onConnect, provider]);
  const handleRequestDisconnect = useCallback(() => onRequestDisconnect(provider), [onRequestDisconnect, provider]);

  return (
    <div
      role="group"
      aria-label={formatMessage({ id: "settings.account.providerAccountAria" }, { label: provider.label })}
      className="relative flex items-start justify-between gap-3 border border-line-muted theme-brutal:border-2 theme-brutal:border-black/30 bg-layer-panel theme-brutal:bg-white p-3 text-left transition-colors hover:border-line-strong hover:shadow-raft-sm theme-brutal:hover:border-black theme-brutal:hover:shadow-brutal-sm"
    >
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2 text-xs">
          <SocialProviderIcon providerId={provider.id} />
          <span className="font-bold text-foreground-strong theme-brutal:text-black">{provider.label}</span>
        </div>
        <div className="truncate text-xs text-foreground-muted theme-brutal:text-black/50">
          {identity?.providerEmail
            ? formatMessage({ id: "settings.account.connectedAs" }, { email: identity.providerEmail })
            : formatMessage({ id: "settings.account.notConnected" })}
        </div>
      </div>
      {!identity && (
        <Button
          variant="outline" size="sm"
          type="button"
          onClick={handleConnect}
          disabled={linking}
          className="shrink-0"
        >
          {linking ? formatMessage({ id: "settings.account.connecting" }) : formatMessage({ id: "settings.account.connect" })}
        </Button>
      )}
      {identity && (
        <Button
          variant="outline" size="sm"
          type="button"
          onClick={handleRequestDisconnect}
          aria-label={formatMessage({ id: "settings.account.disconnectAria" }, { label: provider.label })}
          className="shrink-0"
        >
          {formatMessage({ id: "settings.account.disconnect" })}
        </Button>
      )}
    </div>
  );
}
