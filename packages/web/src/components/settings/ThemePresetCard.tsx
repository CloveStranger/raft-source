import { Check } from "lucide-react";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import { Card, CardContent, CardDescription, CardTitle, RadioGroupItem } from "raft-ui";
import type { AppThemePreset } from "../../theme/appTheme";
import type { ThemeOption } from "./AppearanceThemePicker";

export function ThemePresetCard({
  option,
  selected,
  onSelect,
}: {
  option: ThemeOption;
  selected: boolean;
  onSelect: (preset: AppThemePreset) => void;
}) {
  const { formatMessage } = useIntl();
  const handleClick = useCallback(() => onSelect(option.value), [onSelect, option.value]);
  const label = formatMessage({ id: option.labelId });
  const previewMode = option.mode === "system" ? "light" : option.mode;

  return (
    <div
      className="group min-w-0 focus-within:outline-none"
      data-testid={`appearance-theme-${option.value}`}
    >
      <RadioGroupItem
        appearance="none"
        value={option.value}
        aria-label={label}
        className="peer"
      />
      <Card
        onClick={handleClick}
        className="h-full transition-[opacity,box-shadow,transform] group-hover:-translate-y-px group-hover:opacity-100 peer-focus-visible:ring-2 peer-focus-visible:ring-line-strong peer-data-checked:ring-2 peer-data-checked:ring-accent-strong theme-brutal:peer-data-checked:ring-soft-signal"
      >
        <CardContent className="space-y-2 p-3">
          <div
            data-theme={option.family}
            className={`${previewMode} relative h-16 overflow-hidden rounded-md border border-line-muted bg-layer-canvas p-2`}
            aria-hidden="true"
          >
            <div className="h-full rounded border border-line-muted bg-layer-panel p-2 shadow-raft-xs">
              <div className="h-1.5 w-3/5 rounded-full bg-foreground-muted/35" />
              <div className="mt-2 flex items-center gap-1.5">
                <div
                  className={`size-3 rounded-sm ${
                    option.family === "brutal" ? "bg-primary-400" : "bg-primary-soft"
                  }`}
                />
                <div className="h-1.5 flex-1 rounded-full bg-fill-muted" />
                <div
                  className={`h-3 w-7 rounded-sm ${
                    option.family === "brutal" ? "bg-accent-400" : "bg-accent-soft"
                  }`}
                />
              </div>
            </div>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <CardTitle className="min-w-0 flex-1 truncate text-sm">{label}</CardTitle>
            {selected ? (
              <Check
                size={14}
                className="shrink-0 text-accent-strong theme-brutal:text-primary-500"
                aria-hidden="true"
              />
            ) : null}
          </div>
          <CardDescription className="min-h-4 text-[11px]">
            {selected
              ? formatMessage({ id: "settings.appearance.savedOnDevice" })
              : null}
          </CardDescription>
        </CardContent>
      </Card>
    </div>
  );
}
