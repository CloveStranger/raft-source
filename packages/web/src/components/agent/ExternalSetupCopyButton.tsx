import { useCallback } from "react";
import type { ReactNode } from "react";
import { Button } from "raft-ui";

export function ExternalSetupCopyButton({
  text,
  target,
  onCopy,
  children,
}: {
  text: string;
  target: string;
  onCopy: (text: string, target: string) => Promise<void>;
  children: ReactNode;
}) {
  const handleClick = useCallback(() => void onCopy(text, target), [onCopy, text, target]);
  return (
    <Button variant="outline" size="sm"
      type="button"
      onClick={handleClick}
      className=""
    >
      {children}
    </Button>
  );
}
