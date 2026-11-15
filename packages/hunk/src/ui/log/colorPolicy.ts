import type { ThemeMode } from "@opentui/core";
import {
  ANSI_COLOR_INDEX,
  FALLBACK_TERMINAL_COLORS,
  getDetectedTerminalColors,
  TERMINAL_THEME_ID,
} from "../../core/theme/terminalColors";
import { ensureMinimumContrast } from "../lib/color";
import type { HistoryColorMode } from "../../core/run/commandInputs";
import type { AppTheme } from "../themes";
import { resolveHistoryColor } from "../history/staticProjection";

export interface InteractiveLogPalette {
  timeline: string;
  dayHeading: string;
  author: string;
  separator: string;
  relativeTime: string;
  decoration: string;
  commitId: string;
  copyAction: string;
  graphLanes: readonly string[];
}

/** Map history roles onto the active Hunk theme's semantic palette. */
export function resolveInteractiveLogPalette(theme: AppTheme): InteractiveLogPalette {
  return {
    timeline: theme.noteBorder,
    dayHeading: theme.fileRenamed,
    author: theme.addedSignColor,
    separator: theme.lineNumberFg,
    relativeTime: theme.muted,
    decoration: theme.addedSignColor,
    commitId: theme.fileRenamed,
    copyAction: theme.copyAction,
    graphLanes: [
      theme.accent,
      theme.addedSignColor,
      theme.removedSignColor,
      theme.fileRenamed,
      theme.noteBorder,
    ],
  };
}

/** Keep full Squash role words readable against their actual row without badge fills. */
export function resolveSquashRolePalette(
  theme: AppTheme,
  role: "from" | "into",
  rowBackground: string,
  color = true,
): { fg: string; bg?: string } {
  if (!color) return { fg: theme.text };
  const detected = theme.id === TERMINAL_THEME_ID ? getDetectedTerminalColors() : undefined;
  const fallback = FALLBACK_TERMINAL_COLORS[theme.appearance];
  const accent =
    role === "from"
      ? theme.id === TERMINAL_THEME_ID
        ? (detected?.palette[ANSI_COLOR_INDEX.yellow] ?? fallback.palette[ANSI_COLOR_INDEX.yellow])
        : theme.accent
      : (detected?.palette[ANSI_COLOR_INDEX.cyan] ?? fallback.palette[ANSI_COLOR_INDEX.cyan]);
  return { fg: ensureMinimumContrast(accent, rowBackground, 4.5) };
}

/** Resolve whether interactive history may apply the selected Hunk palette. */
export function interactiveLogUsesColor(
  mode: HistoryColorMode,
  env: NodeJS.ProcessEnv,
  stdoutIsTTY = true,
) {
  return resolveHistoryColor({ mode, env, stdoutIsTTY });
}

/** Replace theme-specific chrome colors with a stable monochrome terminal palette. */
export function monochromeLogTheme(theme: AppTheme, terminalMode: ThemeMode): AppTheme {
  const light = terminalMode === "light";
  const background = light ? "#ffffff" : "#000000";
  const foreground = light ? "#000000" : "#ffffff";
  const selection = light ? "#d0d0d0" : "#404040";
  return {
    ...theme,
    id: "terminal-monochrome",
    label: "Terminal monochrome",
    appearance: light ? "light" : "dark",
    background,
    panel: background,
    panelAlt: background,
    border: foreground,
    accent: foreground,
    accentMuted: selection,
    copyAction: foreground,
    text: foreground,
    muted: foreground,
    addedBg: background,
    removedBg: background,
    movedAddedBg: background,
    movedRemovedBg: background,
    contextBg: background,
    addedContentBg: background,
    removedContentBg: background,
    // The spread keeps a custom theme's alpha word overlays, which would repaint words in color.
    addedContentOverlay: undefined,
    removedContentOverlay: undefined,
    contextContentBg: background,
    addedSignColor: foreground,
    removedSignColor: foreground,
    lineNumberBg: background,
    lineNumberFg: foreground,
    selectedHunk: selection,
    badgeAdded: foreground,
    badgeRemoved: foreground,
    badgeNeutral: foreground,
    fileNew: foreground,
    fileDeleted: foreground,
    fileRenamed: foreground,
    fileModified: foreground,
    fileUntracked: foreground,
    noteBorder: foreground,
    noteBackground: background,
    noteTitleBackground: selection,
    noteTitleText: foreground,
    syntaxColors: Object.fromEntries(
      Object.keys(theme.syntaxColors).map((key) => [key, foreground]),
    ) as AppTheme["syntaxColors"],
    syntaxScopeOverrides: undefined,
  };
}
