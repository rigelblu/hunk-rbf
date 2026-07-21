/**
 * Paints split and unified diff code cells through React and OpenTUI.
 * Canonical code-row and styled-span plans continue to own geometry and wrapping.
 */
import { Fragment, isValidElement, memo, type ReactNode } from "react";
import { parseColor, StyledText, type TextChunk } from "@opentui/core";
import { TRANSPARENT_BACKGROUND, type AppTheme, type ThemeRenderSurfaces } from "../themes";
import type { CodeCellLayoutPlan, CodeRowLayoutPlan } from "./codeRowLayout";
import type { DiffRow, RenderSpan, SplitLineCell, UnifiedLineCell } from "./diffRows";
import {
  applyLineHighlightsToSpans,
  lineHighlightPaintKey,
  type LineHighlightPaintIndex,
} from "./lineHighlightPaint";
import {
  lineHighlightToneStyle,
  splitCellPalette,
  splitGutterText,
  unifiedCellPalette,
  unifiedGutterText,
} from "./rowStyle";
import { resolveSpanColors } from "./spanColors";
import { sanitizeTerminalSpans } from "../../lib/terminalText";
import { measureTextWidth, sliceTextByWidth } from "../lib/text";
import { sliceSpansWindow, wrapSpans } from "./styledSpanLayout";
import type { CopySelectedCellRange } from "../lib/diffSpatial";

/** Describes a row highlight passed from review selection policy into cell painting. */
export interface CodeCellHighlight {
  bg: (baseBg: string) => string;
  /** Global columns to blend; absent blends the gutter alone. */
  colRange?: CopySelectedCellRange;
}

/** Selects the complete content window while preserving wrapped direct-chunk compatibility. */
export const FULL_CODE_CELL_COL_RANGE: CopySelectedCellRange = {
  startCol: 0,
  endCol: Number.MAX_SAFE_INTEGER,
};

interface CellPrefix {
  text: string;
  fg: string;
  bg: string;
}

/** The span fields that decide painted colors. */
type SpanPaint = Pick<RenderSpan, "fg" | "bg" | "transformFg">;

/** Padding carries no colors of its own, so it paints with the cell fallbacks. */
const PADDING_PAINT: SpanPaint = {};

const styledTextColorCache = new Map<string, ReturnType<typeof parseColor>>();
const addNoteSpacerContentCache = new Map<string, StyledText>();

/** Resolve one OpenTUI color while reusing immutable parsed theme values. */
function styledTextColor(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  let parsed = styledTextColorCache.get(value);
  if (!parsed) {
    parsed = parseColor(value);
    styledTextColorCache.set(value, parsed);
  }
  return parsed;
}

/**
 * Resolve one span's final colors against the background the terminal will draw.
 *
 * Highlights blend over the opaque surface, so a transparent row never blends through black, and
 * syntax text is measured against that opaque background before paint-only effects apply.
 */
function finalSpanColors(
  span: SpanPaint,
  fallbackColor: string,
  fallbackBg: string,
  opaqueFallbackBg: string,
  highlightBg?: (baseBg: string) => string,
) {
  const opaqueBaseBg = !span.bg || span.bg === TRANSPARENT_BACKGROUND ? opaqueFallbackBg : span.bg;
  const emittedBackground = highlightBg ? highlightBg(opaqueBaseBg) : (span.bg ?? fallbackBg);
  const colors = resolveSpanColors(
    span.fg ?? fallbackColor,
    emittedBackground,
    highlightBg ? emittedBackground : opaqueBaseBg,
  );
  // Clamp before dimming, so an extension's dim mark may fall below 4.5:1.
  return span.transformFg
    ? { ...colors, foreground: span.transformFg(colors.foreground, emittedBackground) }
    : colors;
}

/** Convert a React span fragment into OpenTUI's direct styled-text run list. */
function styledTextFromSpanNodes(nodes: ReactNode[]) {
  const chunks: TextChunk[] = [];
  const collect = (node: ReactNode, fg?: string, bg?: string) => {
    if (node === null || node === undefined || typeof node === "boolean") {
      return;
    }
    if (typeof node === "string" || typeof node === "number") {
      chunks.push({
        __isChunk: true,
        text: String(node),
        fg: styledTextColor(fg),
        bg: styledTextColor(bg),
      });
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) {
        collect(child, fg, bg);
      }
      return;
    }
    if (!isValidElement<{ children?: ReactNode; fg?: string; bg?: string }>(node)) {
      return;
    }
    if (node.type === Fragment) {
      collect(node.props.children, fg, bg);
      return;
    }
    if (node.type === "span") {
      collect(node.props.children, node.props.fg ?? fg, node.props.bg ?? bg);
    }
  };

  collect(nodes);
  return new StyledText(chunks);
}

/** Append a fixed-width inline span plan directly to StyledText chunks. */
function appendFixedInlineChunks(
  chunks: TextChunk[],
  spans: RenderSpan[],
  width: number,
  fallbackColor: string,
  fallbackBg: string,
  opaqueFallbackBg: string,
  highlightBg?: (baseBg: string) => string,
) {
  const { spans: trimmed, usedWidth } = sliceSpansWindow(spans, 0, width);
  const paddingAmount = Math.max(0, width - usedWidth);
  const lastSpan = trimmed.at(-1);
  let paddingMerged = false;
  if (
    paddingAmount > 0 &&
    lastSpan &&
    (lastSpan.fg ?? fallbackColor) === fallbackColor &&
    (lastSpan.bg ?? fallbackBg) === fallbackBg
  ) {
    lastSpan.text += " ".repeat(paddingAmount);
    paddingMerged = true;
  }

  for (const span of trimmed) {
    const colors = finalSpanColors(span, fallbackColor, fallbackBg, opaqueFallbackBg, highlightBg);
    chunks.push({
      __isChunk: true,
      text: span.text,
      fg: styledTextColor(colors.foreground),
      bg: styledTextColor(colors.emittedBackground),
    });
  }
  if (!paddingMerged && paddingAmount > 0) {
    const colors = finalSpanColors(
      PADDING_PAINT,
      fallbackColor,
      fallbackBg,
      opaqueFallbackBg,
      highlightBg,
    );
    chunks.push({
      __isChunk: true,
      text: " ".repeat(paddingAmount),
      fg: styledTextColor(colors.foreground),
      bg: styledTextColor(colors.emittedBackground),
    });
  }
}

/** Append one horizontally windowed nowrap cell directly to OpenTUI styled-text chunks. */
function appendPlainInlineChunks(
  chunks: TextChunk[],
  spans: RenderSpan[],
  width: number,
  horizontalOffset: number,
  fallbackColor: string,
  fallbackBg: string,
  opaqueFallbackBg: string,
) {
  const { spans: trimmed, usedWidth } = sliceSpansWindow(
    sanitizeTerminalSpans(spans),
    horizontalOffset,
    width,
  );
  const paddingAmount = Math.max(0, width - usedWidth);
  const lastSpan = trimmed.at(-1);
  let paddingMerged = false;
  if (
    paddingAmount > 0 &&
    lastSpan &&
    (lastSpan.fg ?? fallbackColor) === fallbackColor &&
    (lastSpan.bg ?? fallbackBg) === fallbackBg
  ) {
    lastSpan.text += " ".repeat(paddingAmount);
    paddingMerged = true;
  }

  for (const span of trimmed) {
    const colors = finalSpanColors(span, fallbackColor, fallbackBg, opaqueFallbackBg);
    chunks.push({
      __isChunk: true,
      text: span.text,
      fg: styledTextColor(colors.foreground),
      bg: styledTextColor(colors.emittedBackground),
    });
  }
  if (!paddingMerged && paddingAmount > 0) {
    const colors = finalSpanColors(PADDING_PAINT, fallbackColor, fallbackBg, opaqueFallbackBg);
    chunks.push({
      __isChunk: true,
      text: " ".repeat(paddingAmount),
      fg: styledTextColor(colors.foreground),
      bg: styledTextColor(colors.emittedBackground),
    });
  }
}

/** Append one unhighlighted split cell without constructing React span fibers. */
function appendPlainSplitCellChunks(
  chunks: TextChunk[],
  cell: SplitLineCell,
  geometry: CodeCellLayoutPlan,
  lineNumberDigits: number,
  showLineNumbers: boolean,
  themeSurfaces: ThemeRenderSurfaces,
  contentOffset: number,
  prefix: CellPrefix,
) {
  const { emittedTheme: theme, opaqueTheme } = themeSurfaces;
  const palette = splitCellPalette(cell.kind, theme, cell.moveKind);
  const opaquePalette = splitCellPalette(cell.kind, opaqueTheme, cell.moveKind);
  chunks.push(
    {
      __isChunk: true,
      text: prefix.text,
      fg: styledTextColor(prefix.fg),
      bg: styledTextColor(prefix.bg),
    },
    {
      __isChunk: true,
      text: splitGutterText(cell, lineNumberDigits, showLineNumbers).padEnd(geometry.gutterWidth),
      fg: styledTextColor(palette.numberColor),
      bg: styledTextColor(palette.gutterBg),
    },
  );
  appendPlainInlineChunks(
    chunks,
    cell.spans,
    geometry.contentWidth,
    contentOffset,
    theme.syntaxColors.default,
    palette.contentBg,
    opaquePalette.contentBg,
  );
}

/** Append one unhighlighted unified cell without constructing React span fibers. */
function appendPlainUnifiedCellChunks(
  chunks: TextChunk[],
  cell: UnifiedLineCell,
  geometry: CodeCellLayoutPlan,
  lineNumberDigits: number,
  showLineNumbers: boolean,
  themeSurfaces: ThemeRenderSurfaces,
  contentOffset: number,
  prefix: CellPrefix,
) {
  const { emittedTheme: theme, opaqueTheme } = themeSurfaces;
  const palette = unifiedCellPalette(cell.kind, theme, cell.moveKind);
  const opaquePalette = unifiedCellPalette(cell.kind, opaqueTheme, cell.moveKind);
  chunks.push(
    {
      __isChunk: true,
      text: prefix.text,
      fg: styledTextColor(prefix.fg),
      bg: styledTextColor(prefix.bg),
    },
    {
      __isChunk: true,
      text: unifiedGutterText(cell, lineNumberDigits, showLineNumbers).padEnd(geometry.gutterWidth),
      fg: styledTextColor(palette.numberColor),
      bg: styledTextColor(palette.gutterBg),
    },
  );
  appendPlainInlineChunks(
    chunks,
    cell.spans,
    geometry.contentWidth,
    contentOffset,
    theme.syntaxColors.default,
    palette.contentBg,
    opaquePalette.contentBg,
  );
}

/** Report whether a wrapped highlight can paint existing chunks without slicing token spans. */
function isChunkCompatibleWrappedHighlight(highlight: CodeCellHighlight | undefined) {
  return !highlight?.colRange || highlight.colRange === FULL_CODE_CELL_COL_RANGE;
}

/** Whether a highlight paints cell chrome as well as source-text columns. */
function highlightsWholeCell(highlight: CodeCellHighlight | undefined) {
  return Boolean(
    highlight && (!highlight.colRange || highlight.colRange === FULL_CODE_CELL_COL_RANGE),
  );
}

/** Append one wrapped cell without constructing intermediate React span elements. */
function appendWrappedCellChunks(
  chunks: TextChunk[],
  line: WrappedCellLine,
  palette: { numberColor: string; gutterBg: string; contentBg: string },
  opaquePalette: { gutterBg: string; contentBg: string },
  contentWidth: number,
  themeSurfaces: ThemeRenderSurfaces,
  prefix: { text: string; fg: string; bg: string },
  highlight?: CodeCellHighlight,
) {
  const { emittedTheme: theme, opaqueTheme } = themeSurfaces;
  const contentHighlightBg =
    highlight?.colRange === FULL_CODE_CELL_COL_RANGE ? highlight.bg : undefined;
  chunks.push(
    {
      __isChunk: true,
      text: prefix.text,
      fg: styledTextColor(prefix.fg),
      bg: styledTextColor(highlight ? highlight.bg(opaqueTheme.panel) : prefix.bg),
    },
    {
      __isChunk: true,
      text: line.gutterText,
      fg: styledTextColor(palette.numberColor),
      bg: styledTextColor(highlight ? highlight.bg(opaquePalette.gutterBg) : palette.gutterBg),
    },
  );
  appendFixedInlineChunks(
    chunks,
    line.spans,
    contentWidth,
    theme.syntaxColors.default,
    palette.contentBg,
    opaquePalette.contentBg,
    contentHighlightBg,
  );
}

/** Render a fixed-width inline span sequence for one diff cell. */
function renderInlineSpans(
  spans: RenderSpan[],
  width: number,
  fallbackColor: string,
  fallbackBg: string,
  opaqueFallbackBg: string,
  keyPrefix: string,
  horizontalOffset = 0,
  highlightBg?: (baseBg: string) => string,
  selectionColRange?: { start: number; end: number },
  spansAreSanitized = false,
) {
  const { spans: trimmed, usedWidth } = sliceSpansWindow(
    spansAreSanitized ? spans : sanitizeTerminalSpans(spans),
    horizontalOffset,
    width,
  );
  // A whole-row cursor covers this complete rendered window, so it can recolor each existing span
  // directly. Treating it like a partial copy selection would remeasure and split every token — a
  // particularly expensive duplicate width pass for long wrapped CJK lines.
  const fullHighlightBg =
    highlightBg &&
    selectionColRange &&
    selectionColRange.start <= 0 &&
    selectionColRange.end >= width
      ? highlightBg
      : undefined;
  const needsBlending = !fullHighlightBg && highlightBg && selectionColRange;
  const paddingAmount = Math.max(0, width - usedWidth);
  let paddingMerged = false;
  const lastSpan = trimmed.at(-1);
  if (
    !needsBlending &&
    paddingAmount > 0 &&
    lastSpan &&
    (lastSpan.fg ?? fallbackColor) === fallbackColor &&
    (lastSpan.bg ?? fallbackBg) === fallbackBg
  ) {
    // sliceSpansWindow always returns owned span objects, so padding can share the final native node.
    lastSpan.text += " ".repeat(paddingAmount);
    paddingMerged = true;
  }

  // Build the final element list by splitting spans at selection boundaries so the highlight
  // applies at character-level precision rather than whole-token granularity.
  const elements: ReactNode[] = [];
  let colPos = 0;
  let elementIndex = 0;

  for (const span of trimmed) {
    if (!needsBlending) {
      const colors = finalSpanColors(
        span,
        fallbackColor,
        fallbackBg,
        opaqueFallbackBg,
        fullHighlightBg,
      );
      elements.push(
        <span
          key={`${keyPrefix}:${elementIndex++}`}
          fg={colors.foreground}
          bg={colors.emittedBackground}
        >
          {span.text}
        </span>,
      );
      continue;
    }

    const spanWidth = measureTextWidth(span.text);
    const spanStart = colPos;
    const spanEnd = colPos + spanWidth;
    colPos = spanEnd;
    const baseColors = finalSpanColors(span, fallbackColor, fallbackBg, opaqueFallbackBg);

    if (spanEnd <= selectionColRange.start || spanStart >= selectionColRange.end) {
      // Span is entirely outside the selection — render with original styling.
      elements.push(
        <span
          key={`${keyPrefix}:${elementIndex++}`}
          fg={baseColors.foreground}
          bg={baseColors.emittedBackground}
        >
          {span.text}
        </span>,
      );
      continue;
    }

    // Compute the split offsets within this span's text.
    const localSelStart = Math.max(0, selectionColRange.start - spanStart);
    const localSelEnd = Math.min(spanWidth, selectionColRange.end - spanStart);

    if (localSelStart >= localSelEnd) {
      // No overlap after clamping — render original.
      elements.push(
        <span
          key={`${keyPrefix}:${elementIndex++}`}
          fg={baseColors.foreground}
          bg={baseColors.emittedBackground}
        >
          {span.text}
        </span>,
      );
      continue;
    }

    // Split the span at selection boundaries for character-level precision.
    const prefix = sliceTextByWidth(span.text, 0, localSelStart).text;
    const selected = sliceTextByWidth(span.text, localSelStart, localSelEnd - localSelStart).text;
    const suffix = sliceTextByWidth(span.text, localSelEnd, spanWidth - localSelEnd).text;

    if (prefix) {
      elements.push(
        <span
          key={`${keyPrefix}:${elementIndex++}`}
          fg={baseColors.foreground}
          bg={baseColors.emittedBackground}
        >
          {prefix}
        </span>,
      );
    }
    if (selected) {
      const selectedColors = finalSpanColors(
        span,
        fallbackColor,
        fallbackBg,
        opaqueFallbackBg,
        highlightBg,
      );
      elements.push(
        <span
          key={`${keyPrefix}:${elementIndex++}`}
          fg={selectedColors.foreground}
          bg={selectedColors.emittedBackground}
        >
          {selected}
        </span>,
      );
    }
    if (suffix) {
      elements.push(
        <span
          key={`${keyPrefix}:${elementIndex++}`}
          fg={baseColors.foreground}
          bg={baseColors.emittedBackground}
        >
          {suffix}
        </span>,
      );
    }
  }

  // Trailing padding after all spans.
  if (needsBlending) {
    // Compute how much of the padding falls within the selection.
    // The padding starts at colPos (which is now the terminal-cell width consumed by
    // the rendered spans) and extends to `width`.
    const padStart = colPos;
    const padEnd = colPos + Math.max(0, width - usedWidth);
    if (paddingAmount > 0) {
      const paddingColors = finalSpanColors(
        PADDING_PAINT,
        fallbackColor,
        fallbackBg,
        opaqueFallbackBg,
      );
      if (padStart < selectionColRange.end && padEnd > selectionColRange.start) {
        // Split padding into outside/before, selected, and after.
        const beforeSel = Math.max(0, selectionColRange.start - padStart);
        const inSel =
          Math.min(paddingAmount, selectionColRange.end - padStart) - Math.max(0, beforeSel);
        const afterSel = paddingAmount - beforeSel - Math.max(0, inSel);

        if (beforeSel > 0) {
          elements.push(
            <span
              key={`${keyPrefix}:pad-before`}
              fg={paddingColors.foreground}
              bg={paddingColors.emittedBackground}
            >
              {" ".repeat(beforeSel)}
            </span>,
          );
        }
        if (inSel > 0) {
          const selectedPaddingColors = finalSpanColors(
            PADDING_PAINT,
            fallbackColor,
            fallbackBg,
            opaqueFallbackBg,
            highlightBg,
          );
          elements.push(
            <span
              key={`${keyPrefix}:pad-sel`}
              fg={selectedPaddingColors.foreground}
              bg={selectedPaddingColors.emittedBackground}
            >
              {" ".repeat(inSel)}
            </span>,
          );
        }
        if (afterSel > 0) {
          elements.push(
            <span
              key={`${keyPrefix}:pad-after`}
              fg={paddingColors.foreground}
              bg={paddingColors.emittedBackground}
            >
              {" ".repeat(afterSel)}
            </span>,
          );
        }
      } else {
        elements.push(
          <span
            key={`${keyPrefix}:pad`}
            fg={paddingColors.foreground}
            bg={paddingColors.emittedBackground}
          >
            {" ".repeat(paddingAmount)}
          </span>,
        );
      }
    }
  } else if (!paddingMerged && paddingAmount > 0) {
    // Keep a separate padding span when the final content style differs from the cell fallback.
    const paddingColors = finalSpanColors(
      PADDING_PAINT,
      fallbackColor,
      fallbackBg,
      opaqueFallbackBg,
      fullHighlightBg,
    );
    elements.push(
      <span
        key={`${keyPrefix}:pad`}
        fg={paddingColors.foreground}
        bg={paddingColors.emittedBackground}
      >
        {" ".repeat(paddingAmount)}
      </span>,
    );
  }

  return <>{elements}</>;
}

interface WrappedCellLine {
  gutterText: string;
  spans: RenderSpan[];
}

interface WrappedCellLayout {
  gutterWidth: number;
  contentWidth: number;
  palette: ReturnType<typeof splitCellPalette> | ReturnType<typeof unifiedCellPalette>;
  /** The same palette on opaque surfaces, where highlight blends and contrast start. */
  opaquePalette: ReturnType<typeof splitCellPalette> | ReturnType<typeof unifiedCellPalette>;
  lines: WrappedCellLine[];
}

/** Build wrapped split-cell gutter/content lines while keeping continuation gutters blank. */
function buildWrappedSplitCell(
  cell: SplitLineCell,
  geometry: CodeCellLayoutPlan,
  lineNumberDigits: number,
  showLineNumbers: boolean,
  themeSurfaces: ThemeRenderSurfaces,
) {
  const palette = splitCellPalette(cell.kind, themeSurfaces.emittedTheme, cell.moveKind);
  const opaquePalette = splitCellPalette(cell.kind, themeSurfaces.opaqueTheme, cell.moveKind);
  const firstGutterText = splitGutterText(cell, lineNumberDigits, showLineNumbers).padEnd(
    geometry.gutterWidth,
  );
  const wrappedSpans = wrapSpans(cell.spans, geometry.contentWidth);

  return {
    gutterWidth: geometry.gutterWidth,
    contentWidth: geometry.contentWidth,
    palette,
    opaquePalette,
    lines: wrappedSpans.map((spans, index) => ({
      gutterText: index === 0 ? firstGutterText : " ".repeat(geometry.gutterWidth),
      spans,
    })),
  } satisfies WrappedCellLayout;
}

/** Build wrapped unified-cell gutter/content lines while keeping continuation gutters blank. */
function buildWrappedUnifiedCell(
  cell: UnifiedLineCell,
  geometry: CodeCellLayoutPlan,
  lineNumberDigits: number,
  showLineNumbers: boolean,
  themeSurfaces: ThemeRenderSurfaces,
) {
  const palette = unifiedCellPalette(cell.kind, themeSurfaces.emittedTheme, cell.moveKind);
  const opaquePalette = unifiedCellPalette(cell.kind, themeSurfaces.opaqueTheme, cell.moveKind);
  const firstGutterText = unifiedGutterText(cell, lineNumberDigits, showLineNumbers).padEnd(
    geometry.gutterWidth,
  );
  const wrappedSpans = wrapSpans(cell.spans, geometry.contentWidth);

  return {
    gutterWidth: geometry.gutterWidth,
    contentWidth: geometry.contentWidth,
    palette,
    opaquePalette,
    lines: wrappedSpans.map((spans, index) => ({
      gutterText: index === 0 ? firstGutterText : " ".repeat(geometry.gutterWidth),
      spans,
    })),
  } satisfies WrappedCellLayout;
}

/**
 * Apply a highlight blend to a cell palette's gutter bg only.
 *
 * The content bg is intentionally left untouched here so renderInlineSpans can apply the same
 * blend uniformly across every rendered span (including syntax-emphasis spans that supply their
 * own bg). Pre-blending contentBg would cause the fallback path to double-blend.
 */
function applyHighlightPalette<P extends { gutterBg: string; contentBg: string }>(
  palette: P,
  opaquePalette: P,
  highlightBg: (baseBg: string) => string,
): P {
  return {
    ...palette,
    gutterBg: highlightBg(opaquePalette.gutterBg),
  };
}

/** Apply a highlight blend to a prefix descriptor. */
function applyHighlightPrefix<P extends { bg: string }>(
  prefix: P,
  opaqueBackground: string,
  highlightBg: (baseBg: string) => string,
): P {
  return {
    ...prefix,
    bg: highlightBg(opaqueBackground),
  };
}

/** Convert an inclusive global selection into a half-open content-local range. */
function contentLocalHighlightRange(
  range: CopySelectedCellRange | undefined,
  globalContentStart: number,
  contentWidth: number,
) {
  if (!range || range.endCol < globalContentStart) return undefined;
  const start = Math.max(0, range.startCol - globalContentStart);
  const end = Math.min(contentWidth, Math.max(0, range.endCol - globalContentStart + 1));
  return start < end ? { start, end } : undefined;
}

/** Render selection-invariant split-cell content behind its independently painted rail. */
const SplitCellContent = memo(function SplitCellContent({
  cell,
  gutterWidth,
  contentWidth,
  lineNumberDigits,
  showLineNumbers,
  themeSurfaces,
  keyPrefix,
  contentOffset,
  prefixWidth,
  highlight,
  paneOffset,
}: {
  cell: SplitLineCell;
  gutterWidth: number;
  contentWidth: number;
  lineNumberDigits: number;
  showLineNumbers: boolean;
  themeSurfaces: ThemeRenderSurfaces;
  keyPrefix: string;
  contentOffset: number;
  prefixWidth: number;
  highlight?: CodeCellHighlight;
  paneOffset: number;
}) {
  const { emittedTheme: theme, opaqueTheme } = themeSurfaces;
  const basePalette = splitCellPalette(cell.kind, theme, cell.moveKind);
  const opaquePalette = splitCellPalette(cell.kind, opaqueTheme, cell.moveKind);
  const palette = highlightsWholeCell(highlight)
    ? applyHighlightPalette(basePalette, opaquePalette, highlight!.bg)
    : basePalette;
  const gutterText = splitGutterText(cell, lineNumberDigits, showLineNumbers).padEnd(gutterWidth);
  const globalContentStart = paneOffset + prefixWidth + gutterWidth;
  const localColRange = contentLocalHighlightRange(
    highlight?.colRange,
    globalContentStart,
    contentWidth,
  );

  return (
    <>
      <span key={`${keyPrefix}:gutter`} fg={palette.numberColor} bg={palette.gutterBg}>
        {gutterText}
      </span>
      {renderInlineSpans(
        cell.spans,
        contentWidth,
        theme.syntaxColors.default,
        palette.contentBg,
        opaquePalette.contentBg,
        `${keyPrefix}:content`,
        contentOffset,
        highlight?.bg,
        localColRange,
      )}
    </>
  );
});

/** Render one split-view cell while letting a rail-only selection change skip its code spans. */
function renderSplitCell(
  cell: SplitLineCell,
  geometry: CodeCellLayoutPlan,
  lineNumberDigits: number,
  showLineNumbers: boolean,
  themeSurfaces: ThemeRenderSurfaces,
  keyPrefix: string,
  contentOffset = 0,
  prefix?: {
    text: string;
    fg: string;
    bg: string;
  },
  highlight?: CodeCellHighlight,
  paneOffset = 0,
) {
  const resolvedPrefix =
    highlightsWholeCell(highlight) && prefix
      ? applyHighlightPrefix(prefix, themeSurfaces.opaqueTheme.panel, highlight!.bg)
      : prefix;
  const prefixWidth = resolvedPrefix?.text.length ?? 0;

  return (
    <>
      {resolvedPrefix ? (
        <span key={`${keyPrefix}:prefix`} fg={resolvedPrefix.fg} bg={resolvedPrefix.bg}>
          {resolvedPrefix.text}
        </span>
      ) : null}
      <SplitCellContent
        key={`${keyPrefix}:body`}
        cell={cell}
        gutterWidth={geometry.gutterWidth}
        contentWidth={geometry.contentWidth}
        lineNumberDigits={lineNumberDigits}
        showLineNumbers={showLineNumbers}
        themeSurfaces={themeSurfaces}
        keyPrefix={keyPrefix}
        contentOffset={contentOffset}
        prefixWidth={prefixWidth}
        highlight={highlight}
        paneOffset={paneOffset}
      />
    </>
  );
}

/** Render selection-invariant unified-cell content behind its independently painted rail. */
const UnifiedCellContent = memo(function UnifiedCellContent({
  cell,
  gutterWidth,
  contentWidth,
  lineNumberDigits,
  showLineNumbers,
  themeSurfaces,
  keyPrefix,
  contentOffset,
  prefixWidth,
  highlight,
}: {
  cell: UnifiedLineCell;
  gutterWidth: number;
  contentWidth: number;
  lineNumberDigits: number;
  showLineNumbers: boolean;
  themeSurfaces: ThemeRenderSurfaces;
  keyPrefix: string;
  contentOffset: number;
  prefixWidth: number;
  highlight?: CodeCellHighlight;
}) {
  const { emittedTheme: theme, opaqueTheme } = themeSurfaces;
  const basePalette = unifiedCellPalette(cell.kind, theme, cell.moveKind);
  const opaquePalette = unifiedCellPalette(cell.kind, opaqueTheme, cell.moveKind);
  const palette = highlightsWholeCell(highlight)
    ? applyHighlightPalette(basePalette, opaquePalette, highlight!.bg)
    : basePalette;
  const globalContentStart = prefixWidth + gutterWidth;
  const localColRange = contentLocalHighlightRange(
    highlight?.colRange,
    globalContentStart,
    contentWidth,
  );

  return (
    <>
      <span key={`${keyPrefix}:gutter`} fg={palette.numberColor} bg={palette.gutterBg}>
        {unifiedGutterText(cell, lineNumberDigits, showLineNumbers).padEnd(gutterWidth)}
      </span>
      {renderInlineSpans(
        cell.spans,
        contentWidth,
        theme.syntaxColors.default,
        palette.contentBg,
        opaquePalette.contentBg,
        `${keyPrefix}:content`,
        contentOffset,
        highlight?.bg,
        localColRange,
      )}
    </>
  );
});

/** Render one unified-view cell while letting a rail-only selection change skip its code spans. */
function renderUnifiedCell(
  cell: UnifiedLineCell,
  geometry: CodeCellLayoutPlan,
  lineNumberDigits: number,
  showLineNumbers: boolean,
  themeSurfaces: ThemeRenderSurfaces,
  keyPrefix: string,
  contentOffset = 0,
  prefix?: {
    text: string;
    fg: string;
    bg: string;
  },
  highlight?: CodeCellHighlight,
) {
  const resolvedPrefix =
    highlightsWholeCell(highlight) && prefix
      ? applyHighlightPrefix(prefix, themeSurfaces.opaqueTheme.panel, highlight!.bg)
      : prefix;
  const prefixWidth = resolvedPrefix?.text.length ?? 0;

  return (
    <>
      {resolvedPrefix ? (
        <span key={`${keyPrefix}:prefix`} fg={resolvedPrefix.fg} bg={resolvedPrefix.bg}>
          {resolvedPrefix.text}
        </span>
      ) : null}
      <UnifiedCellContent
        key={`${keyPrefix}:body`}
        cell={cell}
        gutterWidth={geometry.gutterWidth}
        contentWidth={geometry.contentWidth}
        lineNumberDigits={lineNumberDigits}
        showLineNumbers={showLineNumbers}
        themeSurfaces={themeSurfaces}
        keyPrefix={keyPrefix}
        contentOffset={contentOffset}
        prefixWidth={prefixWidth}
        highlight={highlight}
      />
    </>
  );
}

/** Render one already-wrapped split cell line with its persistent rail/separator prefix. */
function renderWrappedSplitCellLine(
  line: WrappedCellLine,
  palette: ReturnType<typeof splitCellPalette>,
  opaquePalette: ReturnType<typeof splitCellPalette>,
  contentWidth: number,
  themeSurfaces: ThemeRenderSurfaces,
  keyPrefix: string,
  prefix: {
    text: string;
    fg: string;
    bg: string;
  },
  highlight?: CodeCellHighlight,
  paneOffset = 0,
) {
  const { emittedTheme: theme, opaqueTheme } = themeSurfaces;
  const wholeCellHighlight = highlightsWholeCell(highlight);
  const resolvedPalette = wholeCellHighlight
    ? applyHighlightPalette(palette, opaquePalette, highlight!.bg)
    : palette;
  const resolvedPrefix = wholeCellHighlight
    ? applyHighlightPrefix(prefix, opaqueTheme.panel, highlight!.bg)
    : prefix;

  const prefixWidth = prefix.text.length;
  const gutterWidth = line.gutterText.length;
  const globalContentStart = paneOffset + prefixWidth + gutterWidth;
  const localColRange = contentLocalHighlightRange(
    highlight?.colRange,
    globalContentStart,
    contentWidth,
  );

  return (
    <>
      <span key={`${keyPrefix}:prefix`} fg={resolvedPrefix.fg} bg={resolvedPrefix.bg}>
        {resolvedPrefix.text}
      </span>
      <span
        key={`${keyPrefix}:gutter`}
        fg={resolvedPalette.numberColor}
        bg={resolvedPalette.gutterBg}
      >
        {line.gutterText}
      </span>
      {renderInlineSpans(
        line.spans,
        contentWidth,
        theme.syntaxColors.default,
        resolvedPalette.contentBg,
        opaquePalette.contentBg,
        `${keyPrefix}:content`,
        0,
        highlight?.bg,
        localColRange,
        true,
      )}
    </>
  );
}

/** Render one already-wrapped unified cell line with its persistent rail prefix. */
function renderWrappedUnifiedCellLine(
  line: WrappedCellLine,
  palette: ReturnType<typeof unifiedCellPalette>,
  opaquePalette: ReturnType<typeof unifiedCellPalette>,
  contentWidth: number,
  themeSurfaces: ThemeRenderSurfaces,
  keyPrefix: string,
  prefix: {
    text: string;
    fg: string;
    bg: string;
  },
  highlight?: CodeCellHighlight,
) {
  const { emittedTheme: theme, opaqueTheme } = themeSurfaces;
  const wholeCellHighlight = highlightsWholeCell(highlight);
  const resolvedPalette = wholeCellHighlight
    ? applyHighlightPalette(palette, opaquePalette, highlight!.bg)
    : palette;
  const resolvedPrefix = wholeCellHighlight
    ? applyHighlightPrefix(prefix, opaqueTheme.panel, highlight!.bg)
    : prefix;

  const prefixWidth = prefix.text.length;
  const gutterWidth = line.gutterText.length;
  const globalContentStart = prefixWidth + gutterWidth;
  const localColRange = contentLocalHighlightRange(
    highlight?.colRange,
    globalContentStart,
    contentWidth,
  );

  return (
    <>
      <span key={`${keyPrefix}:prefix`} fg={resolvedPrefix.fg} bg={resolvedPrefix.bg}>
        {resolvedPrefix.text}
      </span>
      <span
        key={`${keyPrefix}:gutter`}
        fg={resolvedPalette.numberColor}
        bg={resolvedPalette.gutterBg}
      >
        {line.gutterText}
      </span>
      {renderInlineSpans(
        line.spans,
        contentWidth,
        theme.syntaxColors.default,
        resolvedPalette.contentBg,
        opaquePalette.contentBg,
        `${keyPrefix}:content`,
        0,
        highlight?.bg,
        localColRange,
        true,
      )}
    </>
  );
}

/** Repaint one split cell's spans over its geometry-neutral extension highlight ranges. */
function withSplitCellLineHighlights(
  cell: SplitLineCell,
  side: "old" | "new",
  lineHighlights: LineHighlightPaintIndex,
  theme: AppTheme,
): SplitLineCell {
  if (cell.kind === "empty" || cell.lineNumber === undefined) {
    return cell;
  }
  const ranges = lineHighlights.get(lineHighlightPaintKey(side, cell.lineNumber));
  if (!ranges) {
    return cell;
  }
  const contentBg = splitCellPalette(cell.kind, theme, cell.moveKind).contentBg;
  return {
    ...cell,
    spans: applyLineHighlightsToSpans(cell.spans, ranges, (tone) =>
      lineHighlightToneStyle(tone, contentBg, theme),
    ),
  };
}

/**
 * Apply extension line highlights to one row's cells before rendering.
 *
 * Paint-time by design: text is never changed, so the returned row measures
 * and wraps identically to the original, and the shared row plan, geometry,
 * and highlighted-diff caches never see highlights at all. Cells are copied
 * because their span arrays are shared cached objects.
 */
function withRowLineHighlights(
  row: DiffRow,
  lineHighlights: LineHighlightPaintIndex | undefined,
  theme: AppTheme,
): DiffRow {
  if (!lineHighlights || lineHighlights.size === 0) {
    return row;
  }

  if (row.type === "split-line") {
    const left = withSplitCellLineHighlights(row.left, "old", lineHighlights, theme);
    const right = withSplitCellLineHighlights(row.right, "new", lineHighlights, theme);
    return left === row.left && right === row.right ? row : { ...row, left, right };
  }

  if (row.type === "unified-line") {
    const cell = row.cell;
    // Context cells carry both numbers pointing at one merged range list, so
    // consulting the new side first never hides an old-side mark.
    const ranges =
      (cell.newLineNumber !== undefined
        ? lineHighlights.get(lineHighlightPaintKey("new", cell.newLineNumber))
        : undefined) ??
      (cell.oldLineNumber !== undefined
        ? lineHighlights.get(lineHighlightPaintKey("old", cell.oldLineNumber))
        : undefined);
    if (!ranges) {
      return row;
    }
    const contentBg = unifiedCellPalette(cell.kind, theme, cell.moveKind).contentBg;
    return {
      ...row,
      cell: {
        ...cell,
        spans: applyLineHighlightsToSpans(cell.spans, ranges, (tone) =>
          lineHighlightToneStyle(tone, contentBg, theme),
        ),
      },
    };
  }

  return row;
}

interface NowrapSplitCodeCellsOptions {
  row: Extract<DiffRow, { type: "split-line" }>;
  layout: Extract<CodeRowLayoutPlan, { kind: "split" }>;
  lineNumberDigits: number;
  showLineNumbers: boolean;
  themeSurfaces: ThemeRenderSurfaces;
  horizontalOffset: number;
  leftPrefix: CellPrefix;
  rightPrefix: CellPrefix;
  leftHighlight?: CodeCellHighlight;
  rightHighlight?: CodeCellHighlight;
  guideOnNewSide: boolean;
}

/** Paint one nowrap split row, retaining the direct-chunk path when neither side is highlighted. */
function renderNowrapSplitCodeCells({
  row,
  layout,
  lineNumberDigits,
  showLineNumbers,
  themeSurfaces,
  horizontalOffset,
  leftPrefix,
  rightPrefix,
  leftHighlight,
  rightHighlight,
  guideOnNewSide,
}: NowrapSplitCodeCellsOptions) {
  const theme = themeSurfaces.emittedTheme;
  if (!leftHighlight && !rightHighlight) {
    const chunks: TextChunk[] = [];
    appendPlainSplitCellChunks(
      chunks,
      row.left,
      layout.left,
      lineNumberDigits,
      showLineNumbers,
      themeSurfaces,
      horizontalOffset,
      leftPrefix,
    );
    appendPlainSplitCellChunks(
      chunks,
      row.right,
      layout.right,
      lineNumberDigits,
      showLineNumbers,
      themeSurfaces,
      horizontalOffset,
      rightPrefix,
    );
    appendNoteGuideChunk(chunks, guideOnNewSide, theme);
    return <text key={`${row.key}:plain`} content={new StyledText(chunks)} />;
  }

  return (
    <text key={`${row.key}:painted`}>
      {renderSplitCell(
        row.left,
        layout.left,
        lineNumberDigits,
        showLineNumbers,
        themeSurfaces,
        `${row.key}:left`,
        horizontalOffset,
        leftPrefix,
        leftHighlight,
        0,
      )}
      {renderSplitCell(
        row.right,
        layout.right,
        lineNumberDigits,
        showLineNumbers,
        themeSurfaces,
        `${row.key}:right`,
        horizontalOffset,
        rightPrefix,
        rightHighlight,
        layout.left.width,
      )}
      {guideOnNewSide ? (
        <span key={`${row.key}:note-guide`} fg={theme.noteBorder}>
          │
        </span>
      ) : null}
    </text>
  );
}

interface NowrapUnifiedCodeCellOptions {
  row: Extract<DiffRow, { type: "unified-line" }>;
  layout: Extract<CodeRowLayoutPlan, { kind: "unified" }>;
  lineNumberDigits: number;
  showLineNumbers: boolean;
  themeSurfaces: ThemeRenderSurfaces;
  horizontalOffset: number;
  prefix: CellPrefix;
  highlight?: CodeCellHighlight;
  guideOnNewSide: boolean;
}

/** Paint one nowrap unified row, retaining the direct-chunk path when it is unhighlighted. */
function renderNowrapUnifiedCodeCell({
  row,
  layout,
  lineNumberDigits,
  showLineNumbers,
  themeSurfaces,
  horizontalOffset,
  prefix,
  highlight,
  guideOnNewSide,
}: NowrapUnifiedCodeCellOptions) {
  const theme = themeSurfaces.emittedTheme;
  if (!highlight) {
    const chunks: TextChunk[] = [];
    appendPlainUnifiedCellChunks(
      chunks,
      row.cell,
      layout.cell,
      lineNumberDigits,
      showLineNumbers,
      themeSurfaces,
      horizontalOffset,
      prefix,
    );
    appendNoteGuideChunk(chunks, guideOnNewSide, theme);
    return <text key={`${row.key}:plain`} content={new StyledText(chunks)} />;
  }

  return (
    <text key={`${row.key}:painted`}>
      {renderUnifiedCell(
        row.cell,
        layout.cell,
        lineNumberDigits,
        showLineNumbers,
        themeSurfaces,
        `${row.key}:unified`,
        horizontalOffset,
        prefix,
        highlight,
      )}
      {guideOnNewSide ? (
        <span key={`${row.key}:note-guide`} fg={theme.noteBorder}>
          │
        </span>
      ) : null}
    </text>
  );
}

/** Append the optional note guide to a direct OpenTUI chunk list. */
function appendNoteGuideChunk(chunks: TextChunk[], enabled: boolean, theme: AppTheme) {
  if (!enabled) return;
  chunks.push({ __isChunk: true, text: "│", fg: styledTextColor(theme.noteBorder) });
}

export interface WrappedCodeCellLineHighlights {
  left?: CodeCellHighlight;
  right?: CodeCellHighlight;
  unified?: CodeCellHighlight;
}

export interface WrappedCodeCells {
  /** Number of visual lines derived from canonical styled-span wrapping. */
  lineCount: number;
  /** Background used to fill any separately mounted add-note spacer. */
  contentBackground: string;
  /** Paint one visual line with optional line-specific selection highlights. */
  paintLine: (
    index: number,
    trailingWidth?: number,
    highlights?: WrappedCodeCellLineHighlights,
  ) => StyledText;
}

interface WrappedSplitCodeCellsOptions extends Omit<
  NowrapSplitCodeCellsOptions,
  "horizontalOffset"
> {}

/** Build a wrapped split-row painter whose line count and chunks share one wrapped layout. */
function createWrappedSplitCodeCells({
  row,
  layout,
  lineNumberDigits,
  showLineNumbers,
  themeSurfaces,
  leftPrefix,
  rightPrefix,
  leftHighlight,
  rightHighlight,
  guideOnNewSide,
}: WrappedSplitCodeCellsOptions): WrappedCodeCells {
  const theme = themeSurfaces.emittedTheme;
  const leftLayout = buildWrappedSplitCell(
    row.left,
    layout.left,
    lineNumberDigits,
    showLineNumbers,
    themeSurfaces,
  );
  const rightLayout = buildWrappedSplitCell(
    row.right,
    layout.right,
    lineNumberDigits,
    showLineNumbers,
    themeSurfaces,
  );
  const lineCount = Math.max(leftLayout.lines.length, rightLayout.lines.length);

  return {
    lineCount,
    contentBackground: rightLayout.palette.contentBg,
    paintLine(index, trailingWidth = 0, highlights) {
      const resolvedLeftHighlight = highlights ? highlights.left : leftHighlight;
      const resolvedRightHighlight = highlights ? highlights.right : rightHighlight;
      const leftLine = leftLayout.lines[index] ?? {
        gutterText: " ".repeat(leftLayout.gutterWidth),
        spans: [],
      };
      const rightLine = rightLayout.lines[index] ?? {
        gutterText: " ".repeat(rightLayout.gutterWidth),
        spans: [],
      };
      let styledRow: StyledText;
      if (
        !isChunkCompatibleWrappedHighlight(resolvedLeftHighlight) ||
        !isChunkCompatibleWrappedHighlight(resolvedRightHighlight)
      ) {
        styledRow = styledTextFromSpanNodes([
          renderWrappedSplitCellLine(
            leftLine,
            leftLayout.palette,
            leftLayout.opaquePalette,
            layout.left.contentWidth,
            themeSurfaces,
            `${row.key}:left:${index}`,
            leftPrefix,
            resolvedLeftHighlight,
            0,
          ),
          renderWrappedSplitCellLine(
            rightLine,
            rightLayout.palette,
            rightLayout.opaquePalette,
            layout.right.contentWidth,
            themeSurfaces,
            `${row.key}:right:${index}`,
            rightPrefix,
            resolvedRightHighlight,
            layout.left.width,
          ),
          guideOnNewSide ? (
            <span key={`${row.key}:note-guide:${index}`} fg={theme.noteBorder}>
              │
            </span>
          ) : null,
        ]);
      } else {
        const chunks: TextChunk[] = [];
        appendWrappedCellChunks(
          chunks,
          leftLine,
          leftLayout.palette,
          leftLayout.opaquePalette,
          layout.left.contentWidth,
          themeSurfaces,
          leftPrefix,
          resolvedLeftHighlight,
        );
        appendWrappedCellChunks(
          chunks,
          rightLine,
          rightLayout.palette,
          rightLayout.opaquePalette,
          layout.right.contentWidth,
          themeSurfaces,
          rightPrefix,
          resolvedRightHighlight,
        );
        appendNoteGuideChunk(chunks, guideOnNewSide, theme);
        styledRow = new StyledText(chunks);
      }
      appendTrailingChunks(styledRow, trailingWidth, rightLayout.palette.contentBg);
      return styledRow;
    },
  };
}

interface WrappedUnifiedCodeCellOptions extends Omit<
  NowrapUnifiedCodeCellOptions,
  "horizontalOffset"
> {}

/** Build a wrapped unified-row painter whose line count and chunks share one wrapped layout. */
function createWrappedUnifiedCodeCell({
  row,
  layout,
  lineNumberDigits,
  showLineNumbers,
  themeSurfaces,
  prefix,
  highlight,
  guideOnNewSide,
}: WrappedUnifiedCodeCellOptions): WrappedCodeCells {
  const theme = themeSurfaces.emittedTheme;
  const wrapped = buildWrappedUnifiedCell(
    row.cell,
    layout.cell,
    lineNumberDigits,
    showLineNumbers,
    themeSurfaces,
  );

  return {
    lineCount: wrapped.lines.length,
    contentBackground: wrapped.palette.contentBg,
    paintLine(index, trailingWidth = 0, highlights) {
      const resolvedHighlight = highlights ? highlights.unified : highlight;
      const line = wrapped.lines[index]!;
      let styledRow: StyledText;
      if (isChunkCompatibleWrappedHighlight(resolvedHighlight)) {
        const chunks: TextChunk[] = [];
        appendWrappedCellChunks(
          chunks,
          line,
          wrapped.palette,
          wrapped.opaquePalette,
          layout.cell.contentWidth,
          themeSurfaces,
          prefix,
          resolvedHighlight,
        );
        appendNoteGuideChunk(chunks, guideOnNewSide, theme);
        styledRow = new StyledText(chunks);
      } else {
        styledRow = styledTextFromSpanNodes([
          renderWrappedUnifiedCellLine(
            line,
            wrapped.palette,
            wrapped.opaquePalette,
            layout.cell.contentWidth,
            themeSurfaces,
            `${row.key}:unified:${index}`,
            prefix,
            resolvedHighlight,
          ),
          guideOnNewSide ? (
            <span key={`${row.key}:note-guide:${index}`} fg={theme.noteBorder}>
              │
            </span>
          ) : null,
        ]);
      }
      appendTrailingChunks(styledRow, trailingWidth, wrapped.palette.contentBg);
      return styledRow;
    },
  };
}

/** Append fixed background padding to an already-painted wrapped row. */
function appendTrailingChunks(content: StyledText, width: number, background: string) {
  if (width <= 0) return;
  content.chunks.push({
    __isChunk: true,
    text: " ".repeat(width),
    bg: styledTextColor(background),
  });
}

/** Return cached OpenTUI content for an independently mounted code-cell spacer. */
function spacerContent(width: number, background: string) {
  const cacheKey = `${width}:${background}`;
  let content = addNoteSpacerContentCache.get(cacheKey);
  if (!content) {
    content = new StyledText([
      {
        __isChunk: true,
        text: " ".repeat(width),
        bg: styledTextColor(background),
      },
    ]);
    addNoteSpacerContentCache.set(cacheKey, content);
  }
  return content;
}

/** Expose the focused code-cell painting boundary used by the review-row renderer. */
export const codeCellView = {
  applyLineHighlights: withRowLineHighlights,
  createWrappedSplit: createWrappedSplitCodeCells,
  createWrappedUnified: createWrappedUnifiedCodeCell,
  renderNowrapSplit: renderNowrapSplitCodeCells,
  renderNowrapUnified: renderNowrapUnifiedCodeCell,
  spacerContent,
};
