import { Check } from "lucide-react";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import { RadioGroup, RadioGroupItem } from "raft-ui";
import { APP_THEME_REGISTRY } from "../../theme/appTheme";
import type { AppResolvedMode, AppThemeId } from "../../theme/appTheme";

export function ThemeModeGroup({
  themeMode,
  themeId,
  isEffective,
  onThemeForModeChange,
}: {
  themeMode: AppResolvedMode;
  themeId: AppThemeId;
  isEffective: boolean;
  onThemeForModeChange: (mode: AppResolvedMode, themeId: AppThemeId) => void;
}) {
  const { formatMessage } = useIntl();
  const handleValueChange = useCallback(
    (value: string) => onThemeForModeChange(themeMode, value as AppThemeId),
    [onThemeForModeChange, themeMode],
  );
  const groupLabel = formatMessage({
    id: themeMode === "light"
      ? "settings.appearance.lightThemeTitle"
      : "settings.appearance.darkThemeTitle",
  });
  const options = Object.values(APP_THEME_REGISTRY).filter((definition) =>
    definition.supportedModes.includes(themeMode),
  );
  return (
    <div className="space-y-2" data-testid={`appearance-theme-group-${themeMode}`}>
      <div className="flex items-center gap-2">
        <div className="text-sm font-bold text-foreground-strong">
          {groupLabel}
        </div>
        {isEffective ? (
          <span className="rounded-full bg-primary-soft px-2 py-0.5 text-[10px] font-bold text-primary-strong">
            {formatMessage({ id: "settings.appearance.currentTheme" })}
          </span>
        ) : null}
      </div>
      <RadioGroup
        value={themeId}
        onValueChange={handleValueChange}
        aria-label={groupLabel}
        className="grid gap-2 sm:grid-cols-2"
      >
        {options.map((option) => {
          const selected = themeId === option.id;
          const label = formatMessage({
            id: option.id === "brutal"
              ? "settings.appearance.themeBrutal"
              : "settings.appearance.themeElegant",
          });
          const isBrutal = option.id === "brutal";
          // The heavy ring marks the SELECTION, not the card's family: an
          // unselected Brutal card must not sit in a permanent heavy black
          // frame (Artea, 2026-09-17). It still needs a quiet boundary of
          // its own, so the unselected state keeps Brutal's 2px geometry
          // in the neutral line colour instead of dropping the frame
          // entirely. Border width never changes, so selecting cannot
          // shift the layout.
          const cardClass = isBrutal
            ? `border-2 bg-layer-panel ${
                selected ? "border-line-strong shadow-raft-md" : "border-line-muted shadow-none"
              }`
            : `rounded-lg border-[0.5px] bg-layer-panel shadow-none ${
                selected
                  ? "border-accent-strong theme-brutal:border-soft-signal"
                  : "border-line-muted"
              }`;
          return (
            <div
              key={option.id}
              className="group min-w-0 focus-within:outline-none"
            >
              <RadioGroupItem
                appearance="none"
                value={option.id}
                aria-label={label}
                className="peer"
                data-testid={`appearance-${themeMode}-theme-${option.id}`}
              />
              <div
                data-theme={option.family}
                className={`${themeMode} text-left transition-[box-shadow,transform] group-hover:-translate-y-px peer-focus-visible:ring-2 peer-focus-visible:ring-accent-strong theme-brutal:peer-focus-visible:ring-soft-signal ${cardClass}`}
                onClick={() => onThemeForModeChange(themeMode, option.id)}
              >
                <div className="p-3">
                  {/* The preview carries the card's own theme scope, so its
                      geometry must follow that family: square corners and a
                      hard shadow inside the Brutal card, soft radii inside
                      Elegant. We select the classes in JS based on option.id (isBrutal)
                      rather than relying on CSS theme-brutal descendant matching,
                      which would match when html data-theme="brutal" is an ancestor. */}
                  <div
                    className={`relative h-16 overflow-hidden bg-layer-canvas p-2 ${
                      isBrutal
                        ? "rounded-none border-2 border-line-strong"
                        : "rounded-md border border-line-muted"
                    }`}
                    aria-hidden="true"
                  >
                    <div
                      className={`h-full bg-layer-panel p-2 ${
                        isBrutal
                          ? "rounded-none border-2 border-black shadow-brutal-xs"
                          : "rounded border border-line-muted shadow-raft-xs"
                      }`}
                    >
                      <div
                        className={`h-1.5 w-3/5 bg-foreground-muted/35 ${
                          isBrutal ? "rounded-none" : "rounded-full"
                        }`}
                      />
                      <div className="mt-2 flex items-center gap-1.5">
                        <div
                          className={`size-3 ${
                            isBrutal ? "rounded-none bg-primary-400" : "rounded-sm bg-primary-soft"
                          }`}
                        />
                        <div
                          className={`h-1.5 flex-1 bg-fill-muted ${
                            isBrutal ? "rounded-none" : "rounded-full"
                          }`}
                        />
                        <div
                          className={`h-3 w-7 ${
                            isBrutal ? "rounded-none bg-accent-400" : "rounded-sm bg-accent-soft"
                          }`}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground-strong">{label}</span>
                    {selected ? (
                      <Check
                        size={14}
                        className={`shrink-0 ${isBrutal ? "text-primary-500" : "text-accent-strong"}`}
                        aria-hidden="true"
                      />
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </RadioGroup>
    </div>
  );
}
