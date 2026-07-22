import type { ThemeMode } from "@opentui/core";
import { LEGACY_CUSTOM_THEME_ID } from "../core/theme/customThemes";
import { resolveSyntaxScopeOverrides } from "../core/theme/legacySyntaxScopes";
import type { NamedCustomThemeConfig } from "../extension-api/types";
import {
  blendHex,
  compositeHexOverlay,
  contrastRatio,
  ensureMinimumContrast,
  hexColorDistance,
  relativeLuminance,
} from "./lib/color";
import {
  BUNDLED_SHIKI_THEME_IDS,
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
  resolveBundledShikiThemeId,
  getBundledShikiThemeBackground,
  getBundledShikiThemeDiffColors,
  getBundledShikiThemeForeground,
  type BundledShikiThemeId,
} from "../core/theme/catalog";
import type { AppTheme, SyntaxColors, ThemeBase, ThemeRenderSurfaces } from "./themes/types";

export type { AppTheme, ThemeRenderSurfaces } from "./themes/types";
export { DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID } from "../core/theme/catalog";

export const TRANSPARENT_BACKGROUND = "transparent";

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

/** Strengthen a word-diff surface until it remains distinct from its row. */
function readableWordDiffBackground(
  contentBg: string,
  lineBg: string,
  signColor: string,
  foreground: string,
) {
  if (hexColorDistance(contentBg, lineBg) >= MIN_WORD_DIFF_BG_DISTANCE) {
    return contentBg;
  }

  const maxSteps = Math.floor(WORD_DIFF_MAX_BLEND / WORD_DIFF_BLEND_STEP);
  for (let step = 1; step <= maxSteps; step += 1) {
    const candidate = blendHex(signColor, lineBg, step * WORD_DIFF_BLEND_STEP);
    if (
      hexColorDistance(candidate, lineBg) >= MIN_WORD_DIFF_BG_DISTANCE &&
      contrastRatio(foreground, candidate) >= MIN_GUTTER_CONTRAST
    ) {
      return candidate;
    }
  }

  return contentBg;
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
    textForeground,
  );
  const removedContentBg = readableWordDiffBackground(
    readableTintedBackground(removedSignColor, editorBackground, textForeground, contentTint),
    removedBg,
    removedSignColor,
    textForeground,
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

  return { ...themeBase, syntaxColors };
}

export const THEMES: AppTheme[] = BUNDLED_SHIKI_THEME_IDS.map((themeId) =>
  buildShikiTheme(themeId),
);

/** Return the built-in theme by id so config-defined themes can inherit from it. */
function builtInThemeById(themeId: string | undefined) {
  const resolvedThemeId = resolveBundledShikiThemeId(themeId);
  return THEMES.find((theme) => theme.id === resolvedThemeId);
}

/** Return the explicit built-in fallback theme used across startup and missing ids. */
function fallbackTheme(themeMode?: ThemeMode | null) {
  const fallbackId = themeMode === "light" ? DEFAULT_LIGHT_THEME_ID : DEFAULT_DARK_THEME_ID;
  return builtInThemeById(fallbackId) ?? THEMES[0]!;
}

/** Build one named custom theme by inheriting from a Shiki-backed base palette. */
function buildCustomTheme(customTheme: NamedCustomThemeConfig) {
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
  const addedContentOverlay =
    customTheme.addedContentBg?.length === 9 ? customTheme.addedContentBg : undefined;
  const removedContentOverlay =
    customTheme.removedContentBg?.length === 9 ? customTheme.removedContentBg : undefined;
  const addedContentBg = addedContentOverlay
    ? (compositeHexOverlay(addedContentOverlay, addedBg) ?? addedBg)
    : (customTheme.addedContentBg ??
      (customTheme.diffAddedColor
        ? blendHex(customTheme.diffAddedColor, addedBg, contentTint)
        : baseTheme.addedContentBg));
  const removedContentBg = removedContentOverlay
    ? (compositeHexOverlay(removedContentOverlay, removedBg) ?? removedBg)
    : (customTheme.removedContentBg ??
      (customTheme.diffRemovedColor
        ? blendHex(customTheme.diffRemovedColor, removedBg, contentTint)
        : baseTheme.removedContentBg));
  const themeBase: ThemeBase = {
    ...baseTheme,
    id: customTheme.id,
    // The original single-slot `[custom_theme]` theme keeps the label it has always shown;
    // named themes fall back to their own id, exactly like the bundled themes do.
    label:
      customTheme.label ?? (customTheme.id === LEGACY_CUSTOM_THEME_ID ? "Custom" : customTheme.id),
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
    addedContentBg,
    removedContentBg,
    addedContentOverlay,
    removedContentOverlay,
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
    // Keep the source-accurate base theme and pass exact TextMate selectors through unchanged.
    // The diff highlighter registers that derived palette with Pierre by content hash.
    syntaxTheme: baseTheme.syntaxTheme,
    // TOML config is normalized at parse time; repeat the adapter here for direct API callers.
    syntaxScopeOverrides: resolveSyntaxScopeOverrides(customTheme.syntax, customTheme.syntaxScopes),
  };

  return { ...themeBase, syntaxColors: baseTheme.syntaxColors };
}

/**
 * Return every selectable theme id: bundled themes first, then custom themes in
 * the order the session resolved them.
 */
export function availableThemeIds(customThemes: readonly NamedCustomThemeConfig[] = []): string[] {
  return [...THEMES.map((theme) => theme.id), ...customThemes.map((theme) => theme.id)];
}

/**
 * Return selectable themes in menu and cycle order.
 *
 * The custom themes are expected to be one already-merged list (config themes
 * before extension themes, ids deduped) so this stays a pure projection.
 */
export function availableThemes(customThemes: readonly NamedCustomThemeConfig[] = []): AppTheme[] {
  return customThemes.length > 0
    ? [...THEMES, ...customThemes.map((customTheme) => buildCustomTheme(customTheme))]
    : THEMES;
}

/**
 * Resolve a named theme, including terminal-background auto mode and custom themes.
 *
 * Custom themes are matched before bundled ids so a custom theme that reuses a
 * deprecated built-in alias still resolves to what the user actually defined.
 */
export function resolveTheme(
  requested: string | undefined,
  themeMode: ThemeMode | null,
  customThemes: readonly NamedCustomThemeConfig[] = [],
) {
  if (requested === "system" || requested === "auto") {
    return fallbackTheme(themeMode);
  }

  const customTheme = requested ? customThemes.find((theme) => theme.id === requested) : undefined;
  if (customTheme) {
    return buildCustomTheme(customTheme);
  }

  const exact = builtInThemeById(requested);
  if (exact) {
    return exact;
  }

  return fallbackTheme(themeMode);
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

/** Preserve opaque colors beside the optionally transparent terminal surfaces. */
export function themeRenderSurfaces(
  theme: AppTheme,
  transparentBackground: boolean,
): ThemeRenderSurfaces {
  return {
    emittedTheme: transparentBackground ? withTransparentSurfaces(theme) : theme,
    opaqueTheme: theme,
  };
}
