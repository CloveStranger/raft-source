import AvatarListRow from "../components/ui/AvatarListRow";
import AvatarSlot from "../components/ui/AvatarSlot";
import { Badge, Spinner } from "raft-ui";
import type { Server } from "../store/serverStore";
import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import type { AvailableServerClient } from "./HumanLoginSetupPage";

export function MarketplaceServerRow({
  server,
  entry,
  selected,
  installPending,
  installInFlight,
  onSelect,
}: {
  server: Server;
  entry: AvailableServerClient | undefined;
  selected: boolean;
  /** This row's server is the one being installed into. */
  installPending: boolean;
  /** Any install is in flight; rows are locked until it settles. */
  installInFlight: boolean;
  onSelect: (serverId: string) => void;
}) {
  const { formatMessage } = useIntl();
  const installed = entry?.client.availability !== "install_required" && entry != null;
  const canInstall = entry?.client.installation?.canInstall === true;
  const rowTitle = formatMessage({ id: installed
    ? "pages.humanLogin.serverInstalledReady"
    : canInstall
      ? "pages.humanLogin.serverNotInstalledCanInstall"
      : entry
        ? "pages.humanLogin.serverNotInstalledAskAdmin"
        : "pages.humanLogin.serverStatusUnavailable" });
  const serverId = server.id;
  const handleClick = useCallback(() => onSelect(serverId), [onSelect, serverId]);
  const ariaLabel = `${formatMessage({ id: "pages.humanLogin.useThisServer" })}: ${server.name}`;
  const buttonProps = useMemo(() => ({
    "data-testid": `login-server-status-${serverId}`,
    disabled: installInFlight,
    "aria-pressed": selected,
    "aria-disabled": installInFlight,
    "aria-label": ariaLabel,
    title: rowTitle,
  }), [ariaLabel, installInFlight, rowTitle, selected, serverId]);
  return (
    <AvatarListRow
      avatar={(
        <AvatarSlot
          context="surface-list"
          type="server"
          serverAvatarUrl={server.avatarUrl}
          serverInitial={server.name.slice(0, 1)}
          className="mt-1"
        />
      )}
      name={server.name}
      subtitle={server.slug}
      rightContent={installPending ? (
        <Spinner
          size="sm"
          aria-hidden="true"
          data-testid="marketplace-install-pending-row-spinner"
        />
      ) : !installed ? (
        <Badge appearance="outline" uppercase>
          {formatMessage({ id: !entry
            ? "pages.humanLogin.serverUnavailableCompact"
            : canInstall
              ? "pages.humanLogin.notInstalledCompact"
              : "pages.humanLogin.adminNeededCompact" })}
        </Badge>
      ) : null}
      align="start"
      selected={selected}
      onClick={handleClick}
      className={`min-h-14 ${installInFlight ? "opacity-60" : ""}`}
      buttonProps={buttonProps}
    />
  );
}
