/** One parsed RGB triplet from a #rrggbb hex color. */
interface RgbColor {
  r: number;
  g: number;
  b: number;
}

const HEX_COLOR_PATTERN = /^#?[0-9a-f]{6}$/i;
const MAX_MINIMUM_CONTRAST_CACHE_ENTRIES = 2_048;
const minimumContrastCache = new Map<string, string | null>();

/** Keep foreground-pair memoization bounded for long-lived review sessions. */
function cacheMinimumContrast(key: string, value: string | null) {
  minimumContrastCache.set(key, value);
  while (minimumContrastCache.size > MAX_MINIMUM_CONTRAST_CACHE_ENTRIES) {
    const oldest = minimumContrastCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    minimumContrastCache.delete(oldest);
  }
}

/** Parse a #rrggbb color into RGB components. Falls back to black for invalid input. */
function hexToRgb(hex: string): RgbColor {
  const normalized = HEX_COLOR_PATTERN.test(hex) ? hex.replace(/^#/, "") : "000000";
  const value = parseInt(normalized, 16);
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
  };
}

/** Blend one foreground color toward a background color at a fixed ratio. */
export function blendHex(fg: string, bg: string, ratio: number) {
  const foreground = hexToRgb(fg);
  const background = hexToRgb(bg);
  const mix = (front: number, back: number) =>
    Math.max(0, Math.min(255, Math.round(back + (front - back) * ratio)));

  return `#${(
    (mix(foreground.r, background.r) << 16) |
    (mix(foreground.g, background.g) << 8) |
    mix(foreground.b, background.b)
  )
    .toString(16)
    .padStart(6, "0")}`;
}

/** Convert one sRGB channel into linear-light space for WCAG contrast math. */
function linearizedChannel(channel: number) {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** Return the WCAG relative luminance for a #rrggbb color. */
export function relativeLuminance(hex: string) {
  const color = hexToRgb(hex);
  return (
    0.2126 * linearizedChannel(color.r) +
    0.7152 * linearizedChannel(color.g) +
    0.0722 * linearizedChannel(color.b)
  );
}

/** Return the WCAG contrast ratio between two #rrggbb colors. */
export function contrastRatio(foreground: string, background: string) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Minimally blend a foreground toward black or white until it reaches a WCAG contrast target.
 *
 * Passing colors stay byte-for-byte unchanged. Failing pairs use deterministic one-percent sRGB
 * steps. A null cache entry records that the caller's original spelling already passes.
 */
export function ensureMinimumContrast(foreground: string, background: string, minimum = 4.5) {
  if (
    !HEX_COLOR_PATTERN.test(foreground) ||
    !HEX_COLOR_PATTERN.test(background) ||
    !Number.isFinite(minimum) ||
    minimum <= 1
  ) {
    return foreground;
  }

  const cacheKey = `${foreground.toLowerCase()}:${background.toLowerCase()}:${minimum}`;
  const cached = minimumContrastCache.get(cacheKey);
  if (cached !== undefined || minimumContrastCache.has(cacheKey)) {
    return cached ?? foreground;
  }

  const initialRatio = contrastRatio(foreground, background);
  if (initialRatio >= minimum) {
    cacheMinimumContrast(cacheKey, null);
    return foreground;
  }

  let strongest = foreground;
  let strongestRatio = initialRatio;

  for (let step = 1; step <= 100; step += 1) {
    const amount = step / 100;
    const towardBlack = blendHex("#000000", foreground, amount);
    const towardWhite = blendHex("#ffffff", foreground, amount);
    const blackRatio = contrastRatio(towardBlack, background);
    const whiteRatio = contrastRatio(towardWhite, background);

    if (blackRatio >= minimum || whiteRatio >= minimum) {
      const adjusted =
        blackRatio >= minimum && blackRatio >= whiteRatio ? towardBlack : towardWhite;
      cacheMinimumContrast(cacheKey, adjusted);
      return adjusted;
    }

    if (blackRatio > strongestRatio) {
      strongest = towardBlack;
      strongestRatio = blackRatio;
    }
    if (whiteRatio > strongestRatio) {
      strongest = towardWhite;
      strongestRatio = whiteRatio;
    }
  }

  cacheMinimumContrast(cacheKey, strongest);
  return strongest;
}

/** Measure how visually separated two #rrggbb colors are using channel deltas. */
export function hexColorDistance(left: string, right: string) {
  const a = hexToRgb(left);
  const b = hexToRgb(right);
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
}
