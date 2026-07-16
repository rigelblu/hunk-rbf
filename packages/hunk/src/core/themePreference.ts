import {
  BUNDLED_SHIKI_THEME_IDS,
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
} from "./theme/catalog";
import type { TerminalThemeMode } from "./theme/detection";
import type { CliInput, CommonOptions } from "./run/commandInputs";

const BUNDLED_THEME_IDS_FOR_MESSAGES: readonly string[] = BUNDLED_SHIKI_THEME_IDS;

export interface ThemePairPreference {
  light: string;
  dark: string;
}

export type ThemePreference = string | ThemePairPreference;
export type ConfiguredCommonOptions = Omit<CommonOptions, "theme"> & {
  theme?: ThemePreference;
};
type WithConfiguredTheme<Input> = Input extends { options: CommonOptions }
  ? Omit<Input, "options"> & { options: ConfiguredCommonOptions }
  : never;
export type ConfiguredCliInput = WithConfiguredTheme<CliInput>;

/** Accept a scalar theme id or a complete light/dark theme pair. */
export function normalizeThemePreference(value: unknown): ThemePreference | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (value === undefined || value === "") {
    return undefined;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected theme to be a non-empty string or a light/dark TOML object.");
  }

  const pair = value as Record<string, unknown>;
  const unsupportedKey = Object.keys(pair).find((key) => key !== "light" && key !== "dark");
  if (unsupportedKey) {
    throw new Error(
      `Unsupported theme.${unsupportedKey}; paired themes currently contain only theme.light and theme.dark.`,
    );
  }

  return {
    light: normalizeThemePairMember(pair.light, "theme.light"),
    dark: normalizeThemePairMember(pair.dark, "theme.dark"),
  };
}

/** Validate one built-in theme id used by an appearance-aware pair. */
function normalizeThemePairMember(value: unknown, keyPath: "theme.light" | "theme.dark") {
  if (
    typeof value !== "string" ||
    !BUNDLED_SHIKI_THEME_IDS.includes(value as (typeof BUNDLED_SHIKI_THEME_IDS)[number])
  ) {
    throw new Error(
      `Expected ${keyPath} to be a built-in theme id. Known themes: ${BUNDLED_THEME_IDS_FOR_MESSAGES.join(", ")}.`,
    );
  }

  return value;
}

/** Return whether one configured theme preference is an explicit light/dark pair. */
export function isThemePairPreference(
  preference: ThemePreference | undefined,
): preference is ThemePairPreference {
  return typeof preference === "object" && preference !== null;
}

/** Return whether one preference needs the controlling terminal's startup appearance. */
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
