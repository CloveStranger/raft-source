import { Card } from "raft-ui";
import type { Server } from "../../store/serverStore";
import { useCallback } from "react";

export function ServerOptionCard({
  server,
  switchPending,
  onSelect,
}: {
  server: Server;
  switchPending: boolean;
  onSelect: (server: Server) => void;
}) {
  const handleClick = useCallback(() => {
    onSelect(server);
  }, [onSelect, server]);
  return (
    <Card
      variant="option"
      render={<button type="button" onClick={handleClick} disabled={switchPending} className="w-full text-left" />}
      className="gap-0 p-3"
      data-testid="server-selector-option"
    >
      <div className="font-bold text-foreground-strong">{server.name}</div>
      <div className="text-sm font-normal text-foreground-muted">/{server.slug}</div>
    </Card>
  );
}
