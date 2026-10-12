import { useCallback } from "react";
import { Link } from "lucide-react";
import { ReferenceChip } from "./ReferenceChip";

/** Permalink chip for quoted-message links in markdown bodies — a real
    component so its click handler can be a useCallback (task #709). */
export function PermalinkReferenceChip({
  href,
  quotedMessageUnavailable,
  channelLabel,
  onOpenPermalink,
}: {
  href: string;
  quotedMessageUnavailable: boolean;
  channelLabel: string;
  onOpenPermalink?: (href: string) => void;
}) {
  const handleClick = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    onOpenPermalink?.(href);
  }, [onOpenPermalink, href]);
  return (
    <ReferenceChip
      as={quotedMessageUnavailable ? "span" : "a"}
      href={quotedMessageUnavailable ? undefined : href}
      onClick={quotedMessageUnavailable ? undefined : handleClick}
      title={quotedMessageUnavailable ? undefined : href}
      icon={Link}
      variant="link"
      label={channelLabel}
      trailing={quotedMessageUnavailable ? undefined : (
        <span className="text-[10px] font-normal leading-none text-foreground-placeholder theme-brutal:text-black/50">msg</span>
      )}
    />
  );
}
