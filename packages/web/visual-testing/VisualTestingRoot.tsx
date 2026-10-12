import type { ReactNode } from "react";
import { ThemeProvider, TooltipProvider } from "raft-ui";
import { BrowserRouter } from "react-router-dom";

import { IntlProviderWrapper } from "../src/i18n/IntlProviderWrapper";
import { LocaleProvider } from "../src/i18n/LocaleProvider";
import { AppThemeContext } from "../src/hooks/useAppTheme";
import type { AppThemeContextValue } from "../src/hooks/useAppTheme";
import { preferencesFromPreset } from "../src/theme/appTheme";
import type { AppThemePreset } from "../src/theme/appTheme";

// The visual-testing root pins the theme; setters are inert.
function ignoreThemeChange() {}

function fixedThemeContext(preset: AppThemePreset): AppThemeContextValue {
  return {
    preset,
    preferences: preferencesFromPreset(preset),
    resolvedMode: "light",
    setPreferences: ignoreThemeChange,
    setMode: ignoreThemeChange,
    setThemeForMode: ignoreThemeChange,
    setPreset: ignoreThemeChange,
  };
}

const FIXED_THEME_CONTEXTS = {
  brutal: fixedThemeContext("brutal"),
  elegant: fixedThemeContext("elegant-light"),
};

export function VisualTestingRoot({
  children,
  defaultTheme,
}: {
  children: ReactNode;
  defaultTheme: "brutal" | "elegant";
}) {
  return (
    <ThemeProvider defaultTheme={defaultTheme} defaultMode="light">
      <AppThemeContext.Provider value={FIXED_THEME_CONTEXTS[defaultTheme]}>
        <TooltipProvider>
          <BrowserRouter>
            <LocaleProvider>
              <IntlProviderWrapper>{children}</IntlProviderWrapper>
            </LocaleProvider>
          </BrowserRouter>
        </TooltipProvider>
      </AppThemeContext.Provider>
    </ThemeProvider>
  );
}
