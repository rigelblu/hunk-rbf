import { DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID } from "../ui/themes";
import type {
  CliInput,
  ConfiguredCliInput,
  TerminalThemeMode,
  ThemePairPreference,
  ThemePreference,
} from "./types";

/** Return whether one configured theme preference is an explicit light/dark pair. */
export function isThemePairPreference(
  preference: ThemePreference | undefined,
): preference is ThemePairPreference {
  return typeof preference === "object" && preference !== null;
}

/** Return whether one preference follows the active system or terminal appearance. */
export function themePreferenceFollowsAppearance(preference: ThemePreference | undefined) {
  return preference === "system" || preference === "auto" || isThemePairPreference(preference);
}

/** Reduce an appearance-aware preference to the one scalar theme used by loaders and renderers. */
export function resolveThemePreference(
  preference: ThemePreference | undefined,
  mode: TerminalThemeMode | null | undefined,
) {
  if (isThemePairPreference(preference)) {
    return mode === "light" ? preference.light : preference.dark;
  }

  if (preference === "system" || preference === "auto") {
    return mode === "light" ? DEFAULT_LIGHT_THEME_ID : DEFAULT_DARK_THEME_ID;
  }

  return preference;
}

/** Resolve configured preference data into the scalar theme contract used at runtime. */
export function resolveConfiguredThemeInput(
  input: ConfiguredCliInput,
  mode: TerminalThemeMode | null | undefined,
): CliInput {
  const theme = resolveThemePreference(input.options.theme, mode);
  if (theme === input.options.theme) {
    return input as CliInput;
  }

  return {
    ...input,
    options: {
      ...input.options,
      theme,
    },
  } as CliInput;
}
