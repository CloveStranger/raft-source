import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { useServerStore } from "../../store/serverStore";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import DeleteServerConfirmDialog from "../settings/DeleteServerConfirmDialog";
import TextLink from "../ui/TextLink";

/**
 * Shared escape links for every blocking server-setup surface. Setup may make
 * you finish before chatting, but it must never lock the owner out of
 * abandoning the server: Delete otherwise lives only in Settings, which the
 * blocking setup modal covers (task #141 — a server stuck before its first
 * computer could not be deleted at all).
 */
export default function SetupSessionFooter({ disabled = false }: { disabled?: boolean }) {
  const { formatMessage } = useIntl();
  const clearCurrent = useServerStore((state) => state.clearCurrent);
  const { isOwner } = useServerPermissions();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const handleSwitchServer = useCallback(() => {
    clearCurrent();
    window.history.pushState({}, "", "/servers");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, [clearCurrent]);
  const handleOpenDelete = useCallback(() => setShowDeleteConfirm(true), []);
  const handleCloseDelete = useCallback(() => setShowDeleteConfirm(false), []);

  return (
    <div className="flex items-center gap-4 text-sm" data-testid="setup-session-footer">
      <TextLink
        variant="muted"
        onClick={handleSwitchServer}
        disabled={disabled}
        data-testid="setup-switch-server"
      >
        {formatMessage({ id: "layout.onboarding.switchServer" })}
      </TextLink>
      {isOwner ? (
        <TextLink
          variant="muted"
          onClick={handleOpenDelete}
          disabled={disabled}
          data-testid="setup-delete-server"
        >
          {formatMessage({ id: "layout.onboarding.deleteServer" })}
        </TextLink>
      ) : null}
      {/* Nested above the setup modal that hosts this footer (as its reset confirm). */}
      {showDeleteConfirm ? <DeleteServerConfirmDialog layer={2} onClose={handleCloseDelete} /> : null}
    </div>
  );
}
