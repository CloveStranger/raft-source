import { useCallback } from "react";
import { useIntl } from "react-intl";
import {
  RadioGroup,
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlLabel,
  useTheme,
} from "raft-ui";
import { presetFromTheme } from "../../theme/appTheme";
import type {
  AppAppearanceMode,
  AppResolvedMode,
  AppThemeId,
  AppThemePreferences,
  AppThemePreset,
} from "../../theme/appTheme";
import { ThemeModeGroup } from "./ThemeModeGroup";
import { ThemePresetCard } from "./ThemePresetCard";
export type { AppThemePreset } from "../../theme/appTheme";

export interface AppearanceThemePickerProps {
  /** Canonical controlled value used by the product Settings contract. */
  preset?: AppThemePreset;
  onChange?: (preset: AppThemePreset) => void;
  /** Controlled preset. When omitted, the app-level RUI provider owns it. */
  value?: AppThemePreset;
  onValueChange?: (preset: AppThemePreset) => void;
  /** Reserved compatibility surface; the current product UI intentionally shows three cards. */
  includeSystemCard?: boolean;
  /** New two-axis product contract. When supplied, the picker renders mode and
   * per-mode theme choices instead of the legacy mixed preset radios. */
  preferences?: AppThemePreferences;
  resolvedMode?: AppResolvedMode;
  onModeChange?: (mode: AppAppearanceMode) => void;
  onThemeForModeChange?: (mode: AppResolvedMode, themeId: AppThemeId) => void;
}

export type ThemeOption = {
  value: AppThemePreset;
  labelId:
    | "settings.appearance.themeBrutal"
    | "settings.appearance.themeElegant"
    | "settings.appearance.themeElegantDark"
    | "settings.appearance.themeElegantSystem";
  family: "brutal" | "elegant";
  mode: "light" | "dark" | "system";
};

const BASE_OPTIONS: readonly ThemeOption[] = [
  {
    value: "brutal",
    labelId: "settings.appearance.themeBrutal",
    family: "brutal",
    mode: "light",
  },
  {
    value: "elegant-light",
    labelId: "settings.appearance.themeElegant",
    family: "elegant",
    mode: "light",
  },
  {
    value: "elegant-dark",
    labelId: "settings.appearance.themeElegantDark",
    family: "elegant",
    mode: "dark",
  },
] as const;
// The three user-facing accessible names are Brutal, Elegant, and Elegant dark.

const SYSTEM_OPTION: ThemeOption = {
  value: "elegant-system",
  labelId: "settings.appearance.themeElegantSystem",
  family: "elegant",
  mode: "system",
};

function selectPreset(
  preset: AppThemePreset,
  setTheme: ReturnType<typeof useTheme>["setTheme"],
) {
  if (preset === "brutal") {
    setTheme("brutal");
    return;
  }
  const mode = preset === "elegant-dark" ? "dark" : preset === "elegant-system" ? "system" : "light";
  setTheme("elegant", { mode });
}

export function AppearanceThemePicker({
  preset,
  onChange,
  value,
  onValueChange,
  includeSystemCard = false,
  preferences,
  resolvedMode,
  onModeChange,
  onThemeForModeChange,
}: AppearanceThemePickerProps) {
  const { formatMessage } = useIntl();
  const { theme, mode, setTheme } = useTheme();
  const activePreset = preset ?? value ?? presetFromTheme(theme, mode);
  const options = includeSystemCard ? [...BASE_OPTIONS, SYSTEM_OPTION] : BASE_OPTIONS;

  const handleValueChange = useCallback(
    (nextValue: string) => {
      const nextPreset = nextValue as AppThemePreset;
      (onChange ?? onValueChange)?.(nextPreset);
      if (preset === undefined && value === undefined) selectPreset(nextPreset, setTheme);
    },
    [onChange, onValueChange, preset, value, setTheme],
  );

  if (preferences && resolvedMode && onModeChange && onThemeForModeChange) {
    const modeOptions: readonly AppAppearanceMode[] = ["light", "dark", "system"];
    const modeLabels: Record<AppAppearanceMode, string> = {
      light: formatMessage({ id: "settings.appearance.modeLight" }),
      dark: formatMessage({ id: "settings.appearance.modeDark" }),
      system: formatMessage({ id: "settings.appearance.modeSystem" }),
    };
    const themeModes: readonly AppResolvedMode[] = ["light", "dark"];
    return (
      <div className="space-y-4" data-testid="appearance-theme-picker">
        <div className="space-y-2">
          <div className="text-xs font-bold uppercase tracking-widest text-foreground-muted">
            {formatMessage({ id: "settings.appearance.modeTitle" })}
          </div>
          <SegmentedControl<AppAppearanceMode>
            value={preferences.mode}
            onValueChange={onModeChange}
            aria-label={formatMessage({ id: "settings.appearance.modeAria" })}
            className="w-fit max-w-full"
          >
            {modeOptions.map((mode) => (
              <SegmentedControlItem key={mode} value={mode} data-testid={`appearance-mode-${mode}`}>
                <SegmentedControlLabel>{modeLabels[mode]}</SegmentedControlLabel>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
          <p className="text-xs text-foreground-muted">
            {formatMessage({ id: "settings.appearance.modeDescription" })}
          </p>
        </div>
        {themeModes.map((themeMode) => (
          <ThemeModeGroup
            key={themeMode}
            themeMode={themeMode}
            themeId={themeMode === "light" ? preferences.lightThemeId : preferences.darkThemeId}
            isEffective={resolvedMode === themeMode}
            onThemeForModeChange={onThemeForModeChange}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="appearance-theme-picker">
      <RadioGroup
        value={activePreset}
        onValueChange={handleValueChange}
        className={`grid gap-2 ${includeSystemCard ? "sm:grid-cols-2 xl:grid-cols-4" : "sm:grid-cols-3"}`}
        aria-label={formatMessage({ id: "settings.appearance.themeAria" })}
      >
        {options.map((option) => (
          <ThemePresetCard
            key={option.value}
            option={option}
            selected={activePreset === option.value}
            onSelect={handleValueChange}
          />
        ))}
      </RadioGroup>
    </div>
  );
}

export default AppearanceThemePicker;
