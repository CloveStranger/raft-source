import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "raft-ui";

const STANDARD_LINK_PROTOCOLS = new Set(["http", "https", "mailto"]);

/**
 * True when an href carries a non-standard scheme (obsidian:// and friends)
 * that hands off to an external application instead of navigating in the
 * browser. Scheme-relative and scheme-less hrefs are ordinary links.
 */
export function isCustomProtocolHref(href: string | undefined | null): href is string {
  if (!href) return false;
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href);
  if (!match) return false;
  return !STANDARD_LINK_PROTOCOLS.has(match[1].toLowerCase());
}

/**
 * Message-body link with a custom protocol (obsidian:// and friends — the
 * sanitize allowlist in `markdownSanitizeSchema.ts` decides which schemes can
 * reach this point). Clicking asks for confirmation naming the protocol and
 * target before handing the URL to the OS handler (task #734); http/https/
 * mailto links never render through this component.
 */
export function CustomProtocolLink({ href, children }: { href: string; children?: ReactNode }) {
  const { formatMessage } = useIntl();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const protocol = href.slice(0, href.indexOf(":")).toLowerCase();

  const handleConfirmOpen = useCallback(() => {
    window.open(href, "_blank", "noopener,noreferrer");
    setConfirmOpen(false);
  }, [href]);

  return (
    <>
      <a
        href={href}
        className="text-blue-700 dark:text-blue-300 underline decoration-2 underline-offset-2 hover:text-brutal-pink select-text"
        onClick={(event) => {
          event.preventDefault();
          setConfirmOpen(true);
        }}
      >
        {children}
      </a>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent data-testid="custom-protocol-link-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{formatMessage({ id: "message.messageItem.customProtocolLink.title" })}</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogBody>
            {formatMessage({ id: "message.messageItem.customProtocolLink.body" }, { protocol })}
            <span className="mt-1 block break-all font-mono text-[0.875em]">{href}</span>
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">{formatMessage({ id: "message.messageItem.customProtocolLink.cancel" })}</AlertDialogCancel>
            <AlertDialogAction size="sm" onClick={handleConfirmOpen}>
              {formatMessage({ id: "message.messageItem.customProtocolLink.confirm" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
