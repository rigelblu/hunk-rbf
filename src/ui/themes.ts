import type { ThemeMode } from "@opentui/core";
import type { CustomThemeConfig, CustomThemeRegistry } from "../core/types";
import {
  blendHex,
  contrastRatio,
  ensureMinimumContrast,
  hexColorDistance,
  relativeLuminance,
} from "./lib/color";
import {
  BUNDLED_SHIKI_THEME_IDS,
  resolveLegacyThemeId,
  getBundledShikiThemeBackground,
  getBundledShikiThemeDiffColors,
  getBundledShikiThemeForeground,
  type BundledShikiThemeDiffColors,
  type BundledShikiThemeId,
} from "./lib/shikiThemes";
import { withLazySyntaxStyle } from "./themes/syntax";
import type { AppTheme, SyntaxColors, ThemeBase, ThemeRenderSurfaces } from "./themes/types";

export type { AppTheme, SyntaxColors, ThemeBase, ThemeRenderSurfaces } from "./themes/types";

export const TRANSPARENT_BACKGROUND = "transparent";
export const DEFAULT_DARK_THEME_ID = "github-dark-default";
export const DEFAULT_LIGHT_THEME_ID = "github-light-default";

const MIN_GUTTER_CONTRAST = 4.5;
const MIN_DIFF_SIGN_CONTRAST = 3;
const MIN_WORD_DIFF_BG_DISTANCE = 28;
const WORD_DIFF_BLEND_STEP = 0.005;
const WORD_DIFF_MAX_BLEND = 0.2;
const SEMANTIC_DIFF_ROW_TINT = { light: 0.16, dark: 0.12 } as const;
const SEMANTIC_DIFF_CONTENT_TINT = { light: 0.18, dark: 0.28 } as const;

const FALLBACK_DIFF_COLORS = {
  dark: { added: "#5ecc71", removed: "#ff6762", modified: "#69b1ff" },
  light: { added: "#0dbe4e", removed: "#ff2e3f", modified: "#009fff" },
} as const;

/** Return a high-contrast foreground layered over an arbitrary editor surface. */
function readableForeground(preferred: string | undefined, background: string) {
  if (preferred && contrastRatio(preferred, background) >= MIN_GUTTER_CONTRAST) {
    return preferred;
  }

  return relativeLuminance(background) > 0.45 ? "#000000" : "#ffffff";
}

/** Return a readable dim foreground for gutters layered over an arbitrary editor surface. */
function readableDimForeground(preferred: string, background: string) {
  if (contrastRatio(preferred, background) >= MIN_GUTTER_CONTRAST) {
    return preferred;
  }

  return relativeLuminance(background) > 0.45
    ? blendHex("#000000", background, 0.62)
    : blendHex("#ffffff", background, 0.62);
}

/** Return a semantic diff marker color that remains legible on a theme editor surface. */
function readableDiffSign(preferred: string, background: string) {
  return ensureMinimumContrast(preferred, background, MIN_DIFF_SIGN_CONTRAST);
}

/** Build Hunk's fallback semantic syntax palette for non-Shiki custom highlighting. */
function buildSyntaxColors(codeForeground: string): SyntaxColors {
  return {
    default: codeForeground,
    keyword: codeForeground,
    string: codeForeground,
    comment: codeForeground,
    number: codeForeground,
    function: codeForeground,
    property: codeForeground,
    type: codeForeground,
    variable: codeForeground,
    operator: codeForeground,
    punctuation: codeForeground,
  };
}

/** Return the strongest tinted background that keeps foreground text readable. */
function readableTintedBackground(
  tintColor: string,
  background: string,
  foreground: string,
  preferredAmount: number,
) {
  for (let amount = preferredAmount; amount >= 0.02; amount -= 0.02) {
    const candidate = blendHex(tintColor, background, amount);
    if (contrastRatio(foreground, candidate) >= MIN_GUTTER_CONTRAST) {
      return candidate;
    }
  }

  return background;
}

/** Strengthen one built-in word-diff surface before it becomes resolved theme data. */
function readableWordDiffBackground(contentBg: string, lineBg: string, signColor: string) {
  if (hexColorDistance(contentBg, lineBg) >= MIN_WORD_DIFF_BG_DISTANCE) {
    return contentBg;
  }

  let strongestCandidate = lineBg;
  const maxSteps = Math.floor(WORD_DIFF_MAX_BLEND / WORD_DIFF_BLEND_STEP);
  for (let step = 1; step <= maxSteps; step += 1) {
    const candidate = blendHex(signColor, lineBg, step * WORD_DIFF_BLEND_STEP);
    strongestCandidate = candidate;
    if (hexColorDistance(candidate, lineBg) >= MIN_WORD_DIFF_BG_DISTANCE) {
      return candidate;
    }
  }

  return strongestCandidate;
}

/** Keep semantic status colors readable on sidebar and menu surfaces. */
function readableChromeColor(preferred: string, panel: string, panelAlt: string) {
  if (
    contrastRatio(preferred, panel) >= MIN_GUTTER_CONTRAST &&
    contrastRatio(preferred, panelAlt) >= MIN_GUTTER_CONTRAST
  ) {
    return preferred;
  }

  const lightPanel = relativeLuminance(panelAlt) > 0.45;
  const anchor = lightPanel ? "#000000" : "#ffffff";
  for (const amount of [0.35, 0.5, 0.65, 0.8, 1]) {
    const candidate = blendHex(anchor, preferred, amount);
    if (
      contrastRatio(candidate, panel) >= MIN_GUTTER_CONTRAST &&
      contrastRatio(candidate, panelAlt) >= MIN_GUTTER_CONTRAST
    ) {
      return candidate;
    }
  }

  return anchor;
}

/** Derive one complete Hunk theme from one bundled Shiki editor theme. */
function buildShikiTheme(themeId: BundledShikiThemeId): AppTheme {
  const editorBackground = getBundledShikiThemeBackground(themeId) ?? "#0d1117";
  const editorForeground = getBundledShikiThemeForeground(themeId);
  const diffColors = getBundledShikiThemeDiffColors(themeId);
  const isLightSurface = relativeLuminance(editorBackground) > 0.45;
  const fallbackDiffColors = FALLBACK_DIFF_COLORS[isLightSurface ? "light" : "dark"];
  const rowTint = isLightSurface ? 0.12 : 0.2;
  const contentTint = isLightSurface ? 0.18 : 0.28;
  const selectedTint = isLightSurface ? 0.18 : 0.25;
  const codeForeground = readableForeground(editorForeground, editorBackground);
  const neutralPanel = blendHex(codeForeground, editorBackground, isLightSurface ? 0.04 : 0.08);
  const neutralPanelAlt = blendHex(codeForeground, editorBackground, isLightSurface ? 0.08 : 0.12);
  const neutralBorder = blendHex(codeForeground, editorBackground, isLightSurface ? 0.15 : 0.18);
  const textForeground = readableForeground(editorForeground ?? codeForeground, neutralPanelAlt);
  const lineNumberForeground = readableDimForeground(
    blendHex(textForeground, editorBackground, 0.56),
    editorBackground,
  );
  const mutedForeground = readableDimForeground(
    blendHex(textForeground, editorBackground, 0.56),
    neutralPanelAlt,
  );
  const addedSignColor = readableDiffSign(
    diffColors?.added ?? fallbackDiffColors.added,
    editorBackground,
  );
  const removedSignColor = readableDiffSign(
    diffColors?.removed ?? fallbackDiffColors.removed,
    editorBackground,
  );
  const modifiedColor = readableDiffSign(
    diffColors?.modified ?? fallbackDiffColors.modified,
    editorBackground,
  );
  const addedBg = readableTintedBackground(
    addedSignColor,
    editorBackground,
    textForeground,
    rowTint,
  );
  const removedBg = readableTintedBackground(
    removedSignColor,
    editorBackground,
    textForeground,
    rowTint,
  );
  const movedBg = readableTintedBackground(
    modifiedColor,
    editorBackground,
    textForeground,
    rowTint,
  );
  const addedContentBg = readableWordDiffBackground(
    readableTintedBackground(addedSignColor, editorBackground, textForeground, contentTint),
    addedBg,
    addedSignColor,
  );
  const removedContentBg = readableWordDiffBackground(
    readableTintedBackground(removedSignColor, editorBackground, textForeground, contentTint),
    removedBg,
    removedSignColor,
  );
  const accentMuted = readableTintedBackground(
    modifiedColor,
    editorBackground,
    textForeground,
    selectedTint,
  );
  const syntaxColors = buildSyntaxColors(textForeground);
  const badgeAdded = readableChromeColor(addedSignColor, neutralPanel, neutralPanelAlt);
  const badgeRemoved = readableChromeColor(removedSignColor, neutralPanel, neutralPanelAlt);
  const badgeModified = readableChromeColor(modifiedColor, neutralPanel, neutralPanelAlt);
  const themeBase: ThemeBase = {
    id: themeId,
    label: themeId,
    appearance: isLightSurface ? "light" : "dark",
    background: editorBackground,
    panel: neutralPanel,
    panelAlt: neutralPanelAlt,
    border: neutralBorder,
    accent: modifiedColor,
    accentMuted,
    text: textForeground,
    muted: mutedForeground,
    contextBg: editorBackground,
    contextContentBg: editorBackground,
    addedBg,
    removedBg,
    movedAddedBg: movedBg,
    movedRemovedBg: movedBg,
    addedContentBg,
    removedContentBg,
    addedSignColor,
    removedSignColor,
    lineNumberBg: editorBackground,
    lineNumberFg: lineNumberForeground,
    selectedHunk: blendHex(modifiedColor, editorBackground, selectedTint),
    noteBackground: neutralPanel,
    noteBorder: modifiedColor,
    noteTitleBackground: neutralPanel,
    noteTitleText: textForeground,
    badgeAdded,
    badgeRemoved,
    badgeNeutral: mutedForeground,
    fileNew: badgeAdded,
    fileDeleted: badgeRemoved,
    fileRenamed: badgeModified,
    fileModified: badgeModified,
    fileUntracked: badgeAdded,
    syntaxTheme: themeId,
  };

  return withLazySyntaxStyle(themeBase, syntaxColors);
}

export const THEMES: AppTheme[] = BUNDLED_SHIKI_THEME_IDS.map((themeId) =>
  buildShikiTheme(themeId),
);

/** Return the built-in theme by id so config-defined themes can inherit from it. */
function builtInThemeById(themeId: string | undefined) {
  const resolvedThemeId = resolveLegacyThemeId(themeId);
  return THEMES.find((theme) => theme.id === resolvedThemeId);
}

/** Return the explicit built-in fallback theme used across startup and missing ids. */
function fallbackTheme(themeMode?: ThemeMode | null) {
  const fallbackId = themeMode === "light" ? DEFAULT_LIGHT_THEME_ID : DEFAULT_DARK_THEME_ID;
  return builtInThemeById(fallbackId) ?? THEMES[0]!;
}

/** Build one config-defined custom theme by inheriting from a Shiki-backed base palette. */
function buildCustomTheme(id: string, customTheme: CustomThemeConfig) {
  const baseTheme = builtInThemeById(customTheme.base) ?? fallbackTheme();
  const contextBg = customTheme.contextBg ?? baseTheme.contextBg;
  const rowTint = SEMANTIC_DIFF_ROW_TINT[baseTheme.appearance];
  const contentTint = SEMANTIC_DIFF_CONTENT_TINT[baseTheme.appearance];
  const addedBg =
    customTheme.addedBg ??
    (customTheme.diffAddedColor
      ? blendHex(customTheme.diffAddedColor, contextBg, rowTint)
      : baseTheme.addedBg);
  const removedBg =
    customTheme.removedBg ??
    (customTheme.diffRemovedColor
      ? blendHex(customTheme.diffRemovedColor, contextBg, rowTint)
      : baseTheme.removedBg);
  const themeBase: ThemeBase = {
    ...baseTheme,
    id,
    label: customTheme.label ?? id,
    background: customTheme.background ?? baseTheme.background,
    panel: customTheme.panel ?? baseTheme.panel,
    panelAlt: customTheme.panelAlt ?? baseTheme.panelAlt,
    border: customTheme.border ?? baseTheme.border,
    accent: customTheme.accent ?? baseTheme.accent,
    accentMuted: customTheme.accentMuted ?? baseTheme.accentMuted,
    text: customTheme.text ?? baseTheme.text,
    muted: customTheme.muted ?? baseTheme.muted,
    addedBg,
    removedBg,
    movedAddedBg: customTheme.movedAddedBg ?? baseTheme.movedAddedBg,
    movedRemovedBg: customTheme.movedRemovedBg ?? baseTheme.movedRemovedBg,
    contextBg,
    addedContentBg:
      customTheme.addedContentBg ??
      (customTheme.diffAddedColor
        ? blendHex(customTheme.diffAddedColor, addedBg, contentTint)
        : baseTheme.addedContentBg),
    removedContentBg:
      customTheme.removedContentBg ??
      (customTheme.diffRemovedColor
        ? blendHex(customTheme.diffRemovedColor, removedBg, contentTint)
        : baseTheme.removedContentBg),
    contextContentBg: customTheme.contextContentBg ?? baseTheme.contextContentBg,
    addedSignColor:
      customTheme.addedSignColor ??
      (customTheme.diffAddedColor
        ? readableDiffSign(customTheme.diffAddedColor, addedBg)
        : baseTheme.addedSignColor),
    removedSignColor:
      customTheme.removedSignColor ??
      (customTheme.diffRemovedColor
        ? readableDiffSign(customTheme.diffRemovedColor, removedBg)
        : baseTheme.removedSignColor),
    lineNumberBg: customTheme.lineNumberBg ?? baseTheme.lineNumberBg,
    lineNumberFg: customTheme.lineNumberFg ?? baseTheme.lineNumberFg,
    selectedHunk: customTheme.selectedHunk ?? baseTheme.selectedHunk,
    badgeAdded: customTheme.badgeAdded ?? baseTheme.badgeAdded,
    badgeRemoved: customTheme.badgeRemoved ?? baseTheme.badgeRemoved,
    badgeNeutral: customTheme.badgeNeutral ?? baseTheme.badgeNeutral,
    fileNew: customTheme.fileNew ?? baseTheme.fileNew,
    fileDeleted: customTheme.fileDeleted ?? baseTheme.fileDeleted,
    fileRenamed: customTheme.fileRenamed ?? baseTheme.fileRenamed,
    fileModified: customTheme.fileModified ?? baseTheme.fileModified,
    fileUntracked: customTheme.fileUntracked ?? baseTheme.fileUntracked,
    noteBorder: customTheme.noteBorder ?? baseTheme.noteBorder,
    noteBackground: customTheme.noteBackground ?? baseTheme.noteBackground,
    noteTitleBackground: customTheme.noteTitleBackground ?? baseTheme.noteTitleBackground,
    noteTitleText: customTheme.noteTitleText ?? baseTheme.noteTitleText,
    // Explicit syntax color overrides should use Hunk's semantic remap path rather than the
    // inherited Shiki theme, otherwise the overrides would never affect highlighted code.
    syntaxTheme: customTheme.syntax ? undefined : baseTheme.syntaxTheme,
  };

  return withLazySyntaxStyle(themeBase, {
    ...baseTheme.syntaxColors,
    ...customTheme.syntax,
  });
}

/** Return built-in ids followed by config-defined ids in stable registry order. */
export function availableThemeIds(customThemes?: CustomThemeRegistry): string[] {
  return [...THEMES.map((theme) => theme.id), ...Object.keys(customThemes ?? {})];
}

/** Return selectable built-in and config-defined themes from one registry. */
export function availableThemes(customThemes?: CustomThemeRegistry): AppTheme[] {
  if (!customThemes) {
    return THEMES;
  }
  return [
    ...THEMES,
    ...Object.entries(customThemes).map(([id, definition]) => buildCustomTheme(id, definition)),
  ];
}

/** Resolve a named theme, including terminal-background auto mode and custom themes. */
export function resolveTheme(
  requested: string | undefined,
  themeMode: ThemeMode | null,
  customThemes?: CustomThemeRegistry,
) {
  if (requested === "system" || requested === "auto") {
    return fallbackTheme(themeMode);
  }

  const exact = builtInThemeById(requested);
  if (exact) {
    return exact;
  }

  const customTheme =
    requested && customThemes && Object.hasOwn(customThemes, requested)
      ? customThemes[requested]
      : undefined;
  if (requested && customTheme) {
    return buildCustomTheme(requested, customTheme);
  }

  return fallbackTheme(themeMode);
}

/** Return whether a custom theme base id can inherit from a built-in theme. */
export function isBuiltInThemeId(themeId: string) {
  return builtInThemeById(themeId) !== undefined;
}

/** Return the canonical built-in theme id, preserving legacy config compatibility. */
export function normalizeBuiltInThemeId(themeId: string) {
  return isBuiltInThemeId(themeId) ? resolveLegacyThemeId(themeId) : undefined;
}

/** Return known semantic diff colors for a bundled Shiki-backed theme. */
export function bundledThemeDiffColors(themeId: string): BundledShikiThemeDiffColors | undefined {
  return getBundledShikiThemeDiffColors(themeId);
}

/**
 * Return a copy of a theme whose neutral surfaces allow the terminal background through while
 * added/removed row tints stay painted. Both the interactive TUI and static pager hosts use
 * this so diff rows keep their semantic backgrounds on translucent terminals.
 */
export function withTransparentSurfaces(theme: AppTheme): AppTheme {
  return {
    ...theme,
    background: TRANSPARENT_BACKGROUND,
    panel: TRANSPARENT_BACKGROUND,
    panelAlt: TRANSPARENT_BACKGROUND,
    contextBg: TRANSPARENT_BACKGROUND,
    contextContentBg: TRANSPARENT_BACKGROUND,
    lineNumberBg: TRANSPARENT_BACKGROUND,
  };
}

/** Preserve an opaque theme beside the optionally transparent colors emitted to the terminal. */
export function themeRenderSurfaces(
  theme: AppTheme,
  transparentBackground: boolean,
): ThemeRenderSurfaces {
  return {
    emittedTheme: transparentBackground ? withTransparentSurfaces(theme) : theme,
    opaqueTheme: theme,
  };
}
