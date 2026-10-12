import { Button } from "raft-ui";
import { Check, Plus } from "lucide-react";
import type { IntlShape } from "react-intl";
import type { ManagedMcpRecommendation } from "@botiverse/raft-shared";
import SurfaceListItem from "../ui/SurfaceListItem";
import { useCallback } from "react";

type McpRecommendationItemProps = {
  recommendation: ManagedMcpRecommendation;
  added: boolean;
  beginRecommendation: (recommendation: ManagedMcpRecommendation) => void;
  formatMessage: IntlShape["formatMessage"];
};

export function McpRecommendationItem({
  recommendation,
  added,
  beginRecommendation,
  formatMessage,
}: McpRecommendationItemProps) {
  const handleSelect = useCallback(() => {
    beginRecommendation(recommendation);
  }, [beginRecommendation, recommendation]);
  return (
    <SurfaceListItem interactive={false}>
  <div className="flex items-center justify-between gap-3">
    <div className="min-w-0">
      <p className="text-sm font-bold text-foreground-strong theme-brutal:text-black">{recommendation.name}</p>
      <p className="mt-1 text-sm text-foreground-muted theme-brutal:text-black/60">{recommendation.description}</p>
    </div>
    <Button
      variant="outline"
      size="sm"
      disabled={added}
      onClick={handleSelect}
    >
      {added ? <Check size={13} /> : <Plus size={13} />}
      {formatMessage({ id: added ? "agent.mcp.added" : "agent.mcp.add" })}
    </Button>
  </div>

    </SurfaceListItem>
  );
}
