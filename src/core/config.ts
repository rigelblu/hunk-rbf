import fs from "node:fs";
import { join } from "node:path";
import { BUNDLED_SHIKI_THEME_IDS } from "../ui/lib/shikiThemes";
import { normalizeBuiltInThemeId } from "../ui/themes";
import { resolveGlobalConfigPath } from "./paths";
import { detectVcs, findVcsRepoRootCandidate, getDefaultVcsAdapter, isVcsId } from "./vcs";
import type {
  CliInput,
  ConfiguredCliInput,
  ConfiguredCommonOptions,
  CustomSyntaxColorsConfig,
  CustomThemeConfig,
  CustomThemeRegistry,
  LayoutMode,
  PersistedViewPreferences,
  ThemePairPreference,
  ThemePreference,
  VcsMode,
} from "./types";

const BUILT_IN_THEME_IDS = BUNDLED_SHIKI_THEME_IDS;
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const CUSTOM_THEME_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const RESERVED_CUSTOM_THEME_IDS = new Set(["system", "auto", "custom"]);
const CUSTOM_THEME_COLOR_KEYS = [
  "background",
  "panel",
  "panelAlt",
  "border",
  "accent",
  "accentMuted",
  "text",
  "muted",
  "addedBg",
  "removedBg",
  "movedAddedBg",
  "movedRemovedBg",
  "contextBg",
  "addedContentBg",
  "removedContentBg",
  "contextContentBg",
  "addedSignColor",
  "removedSignColor",
  "lineNumberBg",
  "lineNumberFg",
  "selectedHunk",
  "badgeAdded",
  "badgeRemoved",
  "badgeNeutral",
  "fileNew",
  "fileDeleted",
  "fileRenamed",
  "fileModified",
  "fileUntracked",
  "noteBorder",
  "noteBackground",
  "noteTitleBackground",
  "noteTitleText",
] as const;
const CUSTOM_SYNTAX_COLOR_KEYS = [
  "default",
  "keyword",
  "string",
  "comment",
  "number",
  "function",
  "property",
  "type",
  "variable",
  "operator",
  "punctuation",
] as const;
const CUSTOM_THEME_KEYS = new Set<string>(["base", "label", "syntax", ...CUSTOM_THEME_COLOR_KEYS]);
const CUSTOM_SYNTAX_KEYS = new Set<string>(CUSTOM_SYNTAX_COLOR_KEYS);

const DEFAULT_VIEW_PREFERENCES: PersistedViewPreferences = {
  mode: "auto",
  showLineNumbers: true,
  wrapLines: false,
  showHunkHeaders: true,
  showMenuBar: true,
  showAgentNotes: false,
  copyDecorations: false,
};

interface ConfigResolutionOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

interface HunkConfigResolution {
  input: ConfiguredCliInput;
  customThemes?: CustomThemeRegistry;
  globalConfigPath?: string;
  repoConfigPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accept only the layout names Hunk already supports. */
function normalizeLayoutMode(value: unknown): LayoutMode | undefined {
  return value === "auto" || value === "split" || value === "stack" ? value : undefined;
}

/** Accept only the VCS backends Hunk can load directly. */
function normalizeVcsMode(value: unknown): VcsMode | undefined {
  return isVcsId(value) ? value : undefined;
}

/** Accept only plain booleans from config files. */
function normalizeBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

/** Accept only plain strings from config files. */
function normalizeString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Read one non-empty theme id used by a paired preference. */
function normalizeThemePairMember(value: unknown, keyPath: "theme.light" | "theme.dark") {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${keyPath} to be a non-empty theme id.`);
  }

  return value;
}

/** Read one fixed scalar or complete atomic light/dark theme preference. */
function normalizeThemePreference(value: unknown): ThemePreference | undefined {
  const scalar = normalizeString(value);
  if (scalar !== undefined) {
    return scalar;
  }

  if (value === undefined || value === "") {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error("Expected theme to be a non-empty string or a light/dark TOML object.");
  }

  const unsupportedKey = Object.keys(value).find((key) => key !== "light" && key !== "dark");
  if (unsupportedKey) {
    throw new Error(
      `Unsupported theme.${unsupportedKey}; paired themes currently contain only theme.light and theme.dark.`,
    );
  }

  const pair: ThemePairPreference = {
    light: normalizeThemePairMember(value.light, "theme.light"),
    dark: normalizeThemePairMember(value.dark, "theme.dark"),
  };
  return pair;
}

/** Accept only #rrggbb theme colors and report the failing TOML key path. */
function normalizeThemeColor(value: unknown, keyPath: string) {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !HEX_COLOR_PATTERN.test(value)) {
    throw new Error(`Expected ${keyPath} to be a hex color like #112233.`);
  }

  return value.toLowerCase();
}

/** Accept only built-in theme ids for config-defined custom themes. */
function normalizeCustomThemeBase(value: unknown, keyPath: string) {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(
      `Expected ${keyPath}.base to be a built-in theme id. Known themes: ${BUILT_IN_THEME_IDS.join(", ")}.`,
    );
  }

  const resolvedThemeId = normalizeBuiltInThemeId(value);
  if (!resolvedThemeId) {
    throw new Error(
      `Expected ${keyPath}.base to be a built-in theme id. Known themes: ${BUILT_IN_THEME_IDS.join(", ")}.`,
    );
  }

  return resolvedThemeId;
}

/** Read the nested syntax color overrides from a [custom_theme.syntax] TOML table. */
function readCustomSyntaxColors(
  source: Record<string, unknown>,
  keyPath: string,
): CustomSyntaxColorsConfig | undefined {
  const unsupportedKey = Object.keys(source).find((key) => !CUSTOM_SYNTAX_KEYS.has(key));
  if (unsupportedKey) {
    throw new Error(`Unsupported ${keyPath}.syntax.${unsupportedKey}.`);
  }
  const syntax: CustomSyntaxColorsConfig = {};

  for (const key of CUSTOM_SYNTAX_COLOR_KEYS) {
    const value = normalizeThemeColor(source[key], `${keyPath}.syntax.${key}`);
    if (value !== undefined) {
      syntax[key] = value;
    }
  }

  return Object.keys(syntax).length > 0 ? syntax : undefined;
}

/** Read one config-defined custom theme palette with source-accurate error paths. */
function readCustomThemeDefinition(
  customThemeSource: Record<string, unknown>,
  keyPath: string,
): CustomThemeConfig {
  const unsupportedKey = Object.keys(customThemeSource).find((key) => !CUSTOM_THEME_KEYS.has(key));
  if (unsupportedKey) {
    throw new Error(`Unsupported ${keyPath}.${unsupportedKey}.`);
  }
  const syntaxSource = customThemeSource.syntax;
  if (syntaxSource !== undefined && !isRecord(syntaxSource)) {
    throw new Error(`Expected ${keyPath}.syntax to contain a TOML table.`);
  }

  const customTheme: CustomThemeConfig = {
    base: normalizeCustomThemeBase(customThemeSource.base, keyPath),
  };
  const label = normalizeString(customThemeSource.label);
  if (label !== undefined) {
    customTheme.label = label;
  }

  for (const key of CUSTOM_THEME_COLOR_KEYS) {
    const value = normalizeThemeColor(customThemeSource[key], `${keyPath}.${key}`);
    if (value !== undefined) {
      customTheme[key] = value;
    }
  }

  if (isRecord(syntaxSource)) {
    const syntax = readCustomSyntaxColors(syntaxSource, keyPath);
    if (syntax) {
      customTheme.syntax = syntax;
    }
  }

  return customTheme;
}

/** Validate a named custom id whose object-key order is used by the selector. */
function normalizeCustomThemeId(id: string) {
  if (!CUSTOM_THEME_ID_PATTERN.test(id)) {
    throw new Error(
      `Expected custom theme id ${JSON.stringify(id)} to match ${CUSTOM_THEME_ID_PATTERN.source}.`,
    );
  }
  if (RESERVED_CUSTOM_THEME_IDS.has(id) || normalizeBuiltInThemeId(id)) {
    throw new Error(`Custom theme id ${JSON.stringify(id)} is reserved or built in.`);
  }
  return id;
}

/** Read legacy and named definitions into the one registry consumed at runtime. */
function readCustomThemes(source: Record<string, unknown>): CustomThemeRegistry {
  const registry = Object.create(null) as CustomThemeRegistry;
  if (isRecord(source.custom_theme)) {
    registry.custom = readCustomThemeDefinition(source.custom_theme, "custom_theme");
  }

  if (source.custom_themes === undefined) {
    return registry;
  }
  if (!isRecord(source.custom_themes)) {
    throw new Error("Expected custom_themes to contain a TOML table.");
  }

  for (const [rawId, definition] of Object.entries(source.custom_themes)) {
    const id = normalizeCustomThemeId(rawId);
    if (!isRecord(definition)) {
      throw new Error(`Expected custom_themes.${id} to contain a TOML table.`);
    }
    registry[id] = readCustomThemeDefinition(definition, `custom_themes.${id}`);
  }
  return registry;
}

/** Merge partial custom theme layers while keeping nested syntax overrides field-based. */
function mergeCustomTheme(
  base: CustomThemeConfig | undefined,
  overrides: CustomThemeConfig | undefined,
): CustomThemeConfig | undefined {
  if (!base) {
    return overrides;
  }
  if (!overrides) {
    return base;
  }

  return {
    ...base,
    ...overrides,
    base: overrides.base ?? base.base ?? "github-dark-default",
    label: overrides.label ?? base.label,
    syntax:
      base.syntax || overrides.syntax
        ? {
            ...base.syntax,
            ...overrides.syntax,
          }
        : undefined,
  };
}

/** Merge registry layers without changing the first-definition selector order. */
function mergeCustomThemes(
  base: CustomThemeRegistry,
  overrides: CustomThemeRegistry,
): CustomThemeRegistry {
  const merged = Object.assign(Object.create(null), base) as CustomThemeRegistry;
  for (const [id, definition] of Object.entries(overrides)) {
    const existing = Object.hasOwn(merged, id) ? merged[id] : undefined;
    merged[id] = mergeCustomTheme(existing, definition) ?? definition;
  }
  return merged;
}

/** Validate a final paired preference once named custom ids are available. */
function validateThemePair(theme: ThemePreference | undefined, customThemes: CustomThemeRegistry) {
  if (!isRecord(theme)) {
    return;
  }
  const knownIds = new Set<string>([...BUILT_IN_THEME_IDS, ...Object.keys(customThemes)]);
  for (const key of ["light", "dark"] as const) {
    const id = theme[key];
    if (typeof id !== "string" || !knownIds.has(id)) {
      throw new Error(
        `Expected theme.${key} to resolve to a built-in or loaded custom theme id. Known themes: ${[...knownIds].join(", ")}.`,
      );
    }
  }
}

/** Read the view preferences stored at one TOML object level. */
function readConfigPreferences(source: Record<string, unknown>): ConfiguredCommonOptions {
  return {
    mode: normalizeLayoutMode(source.mode),
    vcs: normalizeVcsMode(source.vcs),
    theme: normalizeThemePreference(source.theme),
    watch: normalizeBoolean(source.watch),
    excludeUntracked: normalizeBoolean(source.exclude_untracked),
    lineNumbers: normalizeBoolean(source.line_numbers),
    wrapLines: normalizeBoolean(source.wrap_lines),
    hunkHeaders: normalizeBoolean(source.hunk_headers),
    menuBar: normalizeBoolean(source.menu_bar),
    agentNotes: normalizeBoolean(source.agent_notes),
    copyDecorations: normalizeBoolean(source.copy_decorations),
    transparentBackground:
      normalizeBoolean(source.transparentBackground) ??
      normalizeBoolean(source.transparent_background),
    colorMoved: normalizeBoolean(source.color_moved),
  };
}

/** Merge partial preference layers with right-hand overrides taking precedence. */
function mergeOptions(
  base: ConfiguredCommonOptions,
  overrides: ConfiguredCommonOptions,
): ConfiguredCommonOptions {
  return {
    ...base,
    mode: overrides.mode ?? base.mode,
    vcs: overrides.vcs ?? base.vcs,
    theme: overrides.theme ?? base.theme,
    agentContext: overrides.agentContext ?? base.agentContext,
    pager: overrides.pager ?? base.pager,
    watch: overrides.watch ?? base.watch,
    excludeUntracked: overrides.excludeUntracked ?? base.excludeUntracked,
    lineNumbers: overrides.lineNumbers ?? base.lineNumbers,
    wrapLines: overrides.wrapLines ?? base.wrapLines,
    hunkHeaders: overrides.hunkHeaders ?? base.hunkHeaders,
    menuBar: overrides.menuBar ?? base.menuBar,
    agentNotes: overrides.agentNotes ?? base.agentNotes,
    copyDecorations: overrides.copyDecorations ?? base.copyDecorations,
    transparentBackground: overrides.transparentBackground ?? base.transparentBackground,
    colorMoved: overrides.colorMoved ?? base.colorMoved,
  };
}

/** Apply one parsed config object, including command/pager sections, to the current invocation. */
function resolveConfigLayer(
  source: Record<string, unknown>,
  input: CliInput,
): ConfiguredCommonOptions {
  let resolved = readConfigPreferences(source);

  const commandSection = source[input.kind];
  if (isRecord(commandSection)) {
    resolved = mergeOptions(resolved, readConfigPreferences(commandSection));
  }

  const pagerSection = source.pager;
  if (input.options.pager && isRecord(pagerSection)) {
    resolved = mergeOptions(resolved, readConfigPreferences(pagerSection));
  }

  return resolved;
}

/** Choose the VCS backend that best matches the discovered checkout. */
function detectRepoVcsMode(cwd: string): VcsMode {
  return detectVcs(cwd)?.id ?? getDefaultVcsAdapter().id;
}

/** Parse one TOML config file into a plain object. */
function readTomlRecord(path: string) {
  if (!fs.existsSync(path)) {
    return {};
  }

  const parsed = Bun.TOML.parse(fs.readFileSync(path, "utf8"));
  if (!isRecord(parsed)) {
    throw new Error(`Expected ${path} to contain a TOML object.`);
  }

  return parsed;
}

/** Resolve CLI input against global and repo-local config files. */
export function resolveConfiguredCliInput(
  input: CliInput,
  { cwd = process.cwd(), env = process.env }: ConfigResolutionOptions = {},
): HunkConfigResolution {
  const repoRoot = findVcsRepoRootCandidate(cwd);
  const repoConfigPath = repoRoot ? join(repoRoot, ".hunk", "config.toml") : undefined;
  const userConfigPath = resolveGlobalConfigPath(env);
  let resolvedCustomThemes = Object.create(null) as CustomThemeRegistry;

  let resolvedOptions: ConfiguredCommonOptions = {
    mode: DEFAULT_VIEW_PREFERENCES.mode,
    vcs: detectRepoVcsMode(cwd),
    // Keep the built-in theme default explicit so stdin-backed startup paths do not depend on
    // renderer theme-mode detection for their initial palette.
    theme: "github-dark-default",
    agentContext: input.options.agentContext,
    pager: input.options.pager ?? false,
    watch: input.options.watch ?? false,
    excludeUntracked: false,
    lineNumbers: DEFAULT_VIEW_PREFERENCES.showLineNumbers,
    wrapLines: DEFAULT_VIEW_PREFERENCES.wrapLines,
    hunkHeaders: DEFAULT_VIEW_PREFERENCES.showHunkHeaders,
    menuBar: DEFAULT_VIEW_PREFERENCES.showMenuBar,
    agentNotes: DEFAULT_VIEW_PREFERENCES.showAgentNotes,
    copyDecorations: DEFAULT_VIEW_PREFERENCES.copyDecorations,
    transparentBackground: false,
  };

  if (userConfigPath) {
    const userConfig = readTomlRecord(userConfigPath);
    resolvedOptions = mergeOptions(resolvedOptions, resolveConfigLayer(userConfig, input));
    resolvedCustomThemes = mergeCustomThemes(resolvedCustomThemes, readCustomThemes(userConfig));
  }

  if (repoConfigPath) {
    const repoConfig = readTomlRecord(repoConfigPath);
    resolvedOptions = mergeOptions(resolvedOptions, resolveConfigLayer(repoConfig, input));
    resolvedCustomThemes = mergeCustomThemes(resolvedCustomThemes, readCustomThemes(repoConfig));
  }

  resolvedOptions = mergeOptions(resolvedOptions, input.options);
  resolvedOptions = {
    ...resolvedOptions,
    agentContext: input.options.agentContext,
    pager: input.options.pager ?? false,
    watch: input.options.watch ?? resolvedOptions.watch ?? false,
    excludeUntracked: resolvedOptions.excludeUntracked ?? false,
    theme: resolvedOptions.theme,
    vcs: resolvedOptions.vcs ?? getDefaultVcsAdapter().id,
    mode: resolvedOptions.mode ?? DEFAULT_VIEW_PREFERENCES.mode,
    lineNumbers: resolvedOptions.lineNumbers ?? DEFAULT_VIEW_PREFERENCES.showLineNumbers,
    wrapLines: resolvedOptions.wrapLines ?? DEFAULT_VIEW_PREFERENCES.wrapLines,
    hunkHeaders: resolvedOptions.hunkHeaders ?? DEFAULT_VIEW_PREFERENCES.showHunkHeaders,
    menuBar: resolvedOptions.menuBar ?? DEFAULT_VIEW_PREFERENCES.showMenuBar,
    agentNotes: resolvedOptions.agentNotes ?? DEFAULT_VIEW_PREFERENCES.showAgentNotes,
    copyDecorations: resolvedOptions.copyDecorations ?? DEFAULT_VIEW_PREFERENCES.copyDecorations,
    transparentBackground: resolvedOptions.transparentBackground ?? false,
    colorMoved: resolvedOptions.colorMoved,
  };

  validateThemePair(resolvedOptions.theme, resolvedCustomThemes);

  if (resolvedOptions.theme === "custom" && !resolvedCustomThemes.custom) {
    throw new Error('Expected a [custom_theme] table when config selects theme = "custom".');
  }

  return {
    input: {
      ...input,
      options: resolvedOptions,
    } as ConfiguredCliInput,
    customThemes: Object.keys(resolvedCustomThemes).length > 0 ? resolvedCustomThemes : undefined,
    globalConfigPath: userConfigPath,
    repoConfigPath,
  };
}
