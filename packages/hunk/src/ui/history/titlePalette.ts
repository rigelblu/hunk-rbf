import {
  ANSI_COLOR_INDEX,
  FALLBACK_TERMINAL_COLORS,
  getDetectedTerminalColors,
  TERMINAL_THEME_ID,
} from "../../core/theme/terminalColors";
import { ensureMinimumContrast } from "../lib/color";
import type { AppTheme } from "../themes";
import type { HistoryTitleRole } from "./title";

/** Resolve yellow label roles against the actual normal or selected history background. */
export function resolveHistoryTitlePalette(
  theme: AppTheme,
  background = theme.background,
  color = true,
): Record<HistoryTitleRole, string> {
  if (!color) {
    return { empty: theme.text, undescribed: theme.text, text: theme.text };
  }
  const fallback = FALLBACK_TERMINAL_COLORS[theme.appearance];
  const detected = theme.id === TERMINAL_THEME_ID ? getDetectedTerminalColors() : undefined;
  const yellow =
    detected?.palette[ANSI_COLOR_INDEX.yellow] ?? fallback.palette[ANSI_COLOR_INDEX.yellow];
  return {
    empty: ensureMinimumContrast(yellow, background),
    undescribed: ensureMinimumContrast(yellow, background),
    text: theme.text,
  };
}
