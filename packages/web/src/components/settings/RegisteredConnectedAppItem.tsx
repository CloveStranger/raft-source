import { Button } from "raft-ui";
import Tooltip from "../ui/Tooltip";
import { useCallback } from "react";
import { Pencil } from "lucide-react";
import { useIntl } from "react-intl";
import SurfaceListItem from "../ui/SurfaceListItem";
import { CONNECTED_APP_CATEGORY_LABEL_ID, ConnectedAppDistributionBadge, ConnectedAppLogo, ConnectedAppSummary, ConnectedAppUrlLink, canEditSourceOwnedConnectedApp, getDomainFromUrl, sourceOwnedConnectedAppStatusHint } from "./SettingsPanel";
import type { ConnectedAppsViewMode, OAuthClientRecord, ServerRegisteredApp } from "./SettingsPanel";

export function RegisteredConnectedAppItem({
  app,
  viewMode,
  canManage,
  onEdit,
}: {
  app: ServerRegisteredApp;
  viewMode: ConnectedAppsViewMode;
  canManage: boolean;
  onEdit: (client: OAuthClientRecord) => void;
}) {
  const { formatMessage } = useIntl();
  const handleEdit = useCallback(() => onEdit(app), [app, onEdit]);
  const statusHintId = sourceOwnedConnectedAppStatusHint(app.status);

  return (
    <SurfaceListItem
      interactive={false}
      className={viewMode === "grid"
 ? "flex min-h-[184px] w-full flex-col gap-3"
 : "flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <ConnectedAppLogo name={app.name} logoUrl={app.logoUrl} seed={app.defaultLogoSeed} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="min-w-0 break-words font-bold text-foreground-strong theme-brutal:text-black">{app.name}</div>
          <div className="mt-0.5 text-xs text-foreground-muted theme-brutal:text-black/50">{formatMessage({ id: CONNECTED_APP_CATEGORY_LABEL_ID[app.category] ?? "settings.connectedApps.categoryOther" })}</div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <ConnectedAppDistributionBadge status={app.status} />
          </div>
          {viewMode === "list" && (
            <ConnectedAppSummary description={app.description} />
          )}
          {viewMode === "grid" && (
            <>
              {statusHintId && (
                <Tooltip content={formatMessage({ id: statusHintId })}>
                <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-foreground-muted theme-brutal:text-black/55">
                  {formatMessage({ id: statusHintId })}
                </div>
                </Tooltip>
              )}
              <ConnectedAppUrlLink url={app.homepageUrl} label={getDomainFromUrl(app.homepageUrl)} className="mt-1" />
            </>
          )}
        </div>
      </div>
      {canManage && (
        <div className={`flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto ${viewMode === "grid" ? "mt-auto" : ""}`}>
          {canEditSourceOwnedConnectedApp(app.status) && (
            <Button
              variant="outline" size="sm" type="button" onClick={handleEdit} className="inline-flex items-center justify-center gap-1.5">
              <Pencil size={14} />
              {formatMessage({ id: "settings.connectedApps.edit" })}
            </Button>
          )}
        </div>
      )}
    </SurfaceListItem>
  );
}
