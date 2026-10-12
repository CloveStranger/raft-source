import { Button } from "raft-ui";
import Tooltip from "../ui/Tooltip";
import { useCallback } from "react";
import { Check, Copy, X } from "lucide-react";
import { useIntl } from "react-intl";
import { buildJoinLinkUrl } from "./SettingsPanel";
import type { JoinLinkRecord } from "./SettingsPanel";

export function JoinLinkRow({
  link,
  copied,
  formatShortDateTime,
  onCopy,
  onRequestRevoke,
}: {
  link: JoinLinkRecord;
  copied: boolean;
  formatShortDateTime: (value: string) => string;
  onCopy: (linkId: string, token: string) => void;
  onRequestRevoke: (link: JoinLinkRecord) => void;
}) {
  const { formatMessage } = useIntl();
  const handleCopy = useCallback(() => onCopy(link.id, link.token), [link.id, link.token, onCopy]);
  const handleRequestRevoke = useCallback(() => onRequestRevoke(link), [link, onRequestRevoke]);

  return (
    <div className="border border-line-muted theme-brutal:border-2 theme-brutal:border-black/30 px-3 py-2.5 space-y-1.5">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 border border-line-muted bg-layer-panel theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white px-2 py-1 font-mono text-[11px] truncate select-all">
          {buildJoinLinkUrl(link.token)}
        </div>
        <Tooltip content={formatMessage({ id: "settings.joinLinks.copyLink" })}>
        <Button
          variant="outline" size="icon-sm" type="button"
          onClick={handleCopy}
          className="shrink-0"
          aria-label={formatMessage({ id: "settings.joinLinks.copyLink" })}
          data-slot="button"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </Button>
        </Tooltip>
        <Tooltip content={formatMessage({ id: "settings.joinLinks.revokeLink" })}>
        <Button
          variant="outline" size="icon-sm" type="button"
          onClick={handleRequestRevoke}
          className="shrink-0"
          aria-label={formatMessage({ id: "settings.joinLinks.revokeLink" })}
          data-slot="button"
        >
          <X size={14} />
        </Button>
        </Tooltip>
      </div>
      <div className="text-[11px] text-foreground-muted theme-brutal:text-black/50 font-mono">
        {link.maxUses != null
          ? formatMessage({ id: "settings.joinLinks.usesWithMax" }, { used: link.useCount, max: link.maxUses })
          : formatMessage({ id: "settings.joinLinks.uses" }, { used: link.useCount })}
        {" · "}
        {link.expiresAt
          ? formatMessage({ id: "settings.joinLinks.expires" }, { when: formatShortDateTime(link.expiresAt) })
          : formatMessage({ id: "settings.joinLinks.noExpiry" })}
      </div>
    </div>
  );
}
