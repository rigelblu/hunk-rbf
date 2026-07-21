import { ensureMinimumContrast } from "../lib/color";

export const MIN_HIGHLIGHT_CONTRAST = 4.5;

export interface ResolvedSpanColors {
  foreground: string;
  emittedBackground: string;
  contrastBackground: string;
}

/** Resolve one final terminal span after its emitted and opaque backgrounds are known. */
export function resolveSpanColors(
  foreground: string,
  emittedBackground: string,
  contrastBackground: string,
): ResolvedSpanColors {
  return {
    foreground: ensureMinimumContrast(foreground, contrastBackground, MIN_HIGHLIGHT_CONTRAST),
    emittedBackground,
    contrastBackground,
  };
}
