import { useCallback } from "react";
import type { GrantableApp } from "./AgentAppAccessTab";

export function GrantableAppOption({
  app,
  selected,
  onChoose,
}: {
  app: GrantableApp;
  selected: boolean;
  onChoose: (app: GrantableApp) => void;
}) {
  const handleClick = useCallback(() => onChoose(app), [onChoose, app]);
  return (
    <button
      type="button"
      onClick={handleClick}
      aria-pressed={selected}
      className={`border-2 p-2.5 text-left ${selected ? "border-accent bg-accent-soft theme-brutal:border-black theme-brutal:bg-brutal-lime/20" : "border-line-muted bg-layer-panel theme-brutal:border-black/15 theme-brutal:bg-white"}`}
    >
      <span className="block text-xs font-black text-foreground-strong">{app.name}</span>
      {app.description && <span className="mt-0.5 block text-[11px] text-foreground-muted">{app.description}</span>}
    </button>
  );
}
