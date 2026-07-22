import { compositeHexOverlay, ensureMinimumContrast } from "../lib/color";
import { TRANSPARENT_BACKGROUND } from "../themes";

export const MIN_HIGHLIGHT_CONTRAST = 4.5;

export interface ResolvedSpanColors {
  foreground: string;
  emittedBackground: string;
  contrastBackground: string;
}

export interface ResolvedSpanBackgrounds {
  emittedBackground: string;
  contrastBackground: string;
}

/** Resolve an optional word overlay over the actual opaque row before terminal emission. */
export function resolveSpanBackgrounds(
  spanBackground: string | undefined,
  spanOverlay: string | undefined,
  emittedRowBackground: string,
  opaqueRowBackground: string,
): ResolvedSpanBackgrounds {
  if (spanOverlay) {
    const resolvedOverlay = compositeHexOverlay(spanOverlay, opaqueRowBackground);
    if (resolvedOverlay) {
      return {
        emittedBackground: resolvedOverlay,
        contrastBackground: resolvedOverlay,
      };
    }
  }

  const emittedBackground = spanBackground ?? emittedRowBackground;
  return {
    emittedBackground,
    contrastBackground:
      !spanBackground || spanBackground === TRANSPARENT_BACKGROUND
        ? opaqueRowBackground
        : spanBackground,
  };
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
