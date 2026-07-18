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

/** Require one non-empty theme id before the complete configured catalog is available. */
function normalizeThemePairMember(value: unknown, keyPath: "theme.light" | "theme.dark") {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${keyPath} to be a built-in or loaded custom theme id.`);
  }

  return value;
}

/** Validate a pair after config-defined custom theme ids have been collected. */
export function validateThemePairPreference(
  preference: ThemePreference | undefined,
  customThemeIds: Iterable<string>,
) {
  if (!isThemePairPreference(preference)) {
    return;
  }

  const knownIds = new Set<string>([...BUNDLED_THEME_IDS_FOR_MESSAGES, ...customThemeIds]);
  for (const key of ["light", "dark"] as const) {
    if (!knownIds.has(preference[key])) {
      throw new Error(
        `Expected theme.${key} to resolve to a built-in or loaded custom theme id. Known themes: ${[...knownIds].join(", ")}.`,
      );
    }
  }
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
