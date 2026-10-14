import type { HistoryGraphRow } from "../../core/history/types";
import { sanitizeTerminalLine } from "../../lib/terminalText";
import {
  formatHistoryDecorations,
  renderHistoryContinuation,
  renderHistoryConvergence,
  renderHistoryGraph,
  renderHistoryCutoffs,
  renderHistoryCutoffConvergence,
} from "../history/staticProjection";
import { formatHistoryTitle } from "../history/title";
import { fitText, measureTextWidth } from "../lib/text";
import type { LogPresentation } from "./presentation";
import { formatHistoryRelativeTime, resolveHistoryAuthorLabel } from "./formatting";

export interface LogResponsiveRow {
  graph: string;
  continuation: string;
  convergence: string;
  graphWidth: number;
  cutoffs: string[];
  cutoffConvergence: string;
  leftWidth: number;
  rightWidth: number;
  columnGap: number;
  textWidth: number;
  refLine: string;
  inlineRefLine: string;
  /** Count title/metadata rows plus an optional shared spill or real join row. */
  textRowCount: 2 | 3;
  /** Include local cutoff and compaction rows in the measured commit extent. */
  commitHeight: number;
  metadataWidth: number;
  metadataGap: number;
  summaryGap: number;
  secondaryWidth: number;
  title: string;
  author: string;
  relativeTime: string;
  metadata: string;
  displayId: string;
  copyIcon: string;
  secondary: string;
}

/** Reserve the menu, breathing room and status bar before planning visible history entries. */
export function resolveLogViewportBodyHeight(height: number) {
  return Math.max(1, height - 3);
}

/** Fit a complete summary, marking omissions while retaining its leading current identity. */
function fitResponsiveDecorations(row: HistoryGraphRow, width: number) {
  let full = formatHistoryDecorations(row).trim();
  const head = row.commit.decorations.find((entry) => entry.kind === "head");
  if (head?.attachedLocalBranch) {
    const safe = (label: string) => sanitizeTerminalLine(label).replaceAll("\t", " ");
    full = full.replace(
      `${safe(head.label)} -> ${safe(head.attachedLocalBranch)}`,
      safe(head.attachedLocalBranch),
    );
  }
  if (measureTextWidth(full) <= width) return full;
  if (width >= 3) return `${fitText(full.slice(0, -1), width - 1, "…")})`;
  return fitText(full, width, "…");
}

/** Project one commit into left/right responsive columns using terminal display-cell widths. */
export function projectResponsiveLogRow({
  row,
  presentation,
  width,
  now,
}: {
  row: HistoryGraphRow;
  presentation: LogPresentation;
  width: number;
  now?: number;
}): LogResponsiveRow {
  // Filter semantic workspace metadata before fitting; ordinary refs retain their meaning.
  if (presentation.workspaceNames === false) {
    row = {
      ...row,
      commit: {
        ...row.commit,
        decorations: row.commit.decorations.filter(
          (entry) => entry.kind !== "ref" || entry.workspaceName === undefined,
        ),
      },
    };
  }
  // Keep two cells clear of the terminal edge: ambiguous-width copy glyphs must never wrap a row.
  const contentWidth = Math.max(1, width - 4);
  const rawGraph = presentation.graph
    ? renderHistoryGraph(row, !presentation.unicode)
    : presentation.unicode
      ? "│"
      : "|";
  const rawContinuation = presentation.graph
    ? renderHistoryContinuation(row, !presentation.unicode)
    : rawGraph;
  const renderedConvergence = presentation.graph
    ? renderHistoryConvergence(row, !presentation.unicode)
    : "";
  const hasConvergence = presentation.graph && row.convergences.length > 0;
  const rawConvergence = hasConvergence ? renderedConvergence : rawContinuation;
  const safeId = sanitizeTerminalLine(row.commit.displayId).replaceAll("\t", " ");
  const maxIdWidth = Math.max(
    1,
    Math.min(measureTextWidth(safeId), Math.floor(contentWidth * 0.35)),
  );
  const displayId = fitText(safeId, maxIdWidth, "…");
  const copyIcon = presentation.unicode ? "⧉" : "c";
  const idActionWidth = measureTextWidth(displayId) + 1 + measureTextWidth(copyIcon);
  const rightWidth = idActionWidth;
  const minimumGraphWidth = presentation.graph
    ? 0
    : Math.min(3, Math.max(0, contentWidth - rightWidth - 1));
  const minimumLeftWidth = Math.min(12, Math.max(1, contentWidth - rightWidth - minimumGraphWidth));
  const desiredGap = contentWidth > rightWidth + minimumLeftWidth + minimumGraphWidth ? 2 : 0;
  const maximumGraphWidth = Math.max(
    minimumGraphWidth,
    contentWidth - rightWidth - minimumLeftWidth - desiredGap,
  );
  const graphContentWidth = Math.max(0, maximumGraphWidth - 2);
  const graph = graphContentWidth > 0 ? fitText(rawGraph, graphContentWidth, "…") : "";
  const continuation =
    graphContentWidth > 0 ? fitText(rawContinuation, graphContentWidth, "…") : "";
  const convergence = graphContentWidth > 0 ? fitText(rawConvergence, graphContentWidth, "…") : "";
  const graphWidth = graph
    ? Math.min(
        maximumGraphWidth,
        Math.max(
          measureTextWidth(graph),
          measureTextWidth(continuation),
          measureTextWidth(convergence),
        ) + 2,
      )
    : 0;
  const columnGap = contentWidth > graphWidth + rightWidth ? desiredGap : 0;
  const leftWidth = Math.max(1, contentWidth - graphWidth - rightWidth - columnGap);
  const textWidth = leftWidth + columnGap + rightWidth;
  const genericRefs = formatHistoryDecorations({
    ...row,
    commit: {
      ...row.commit,
      decorations: row.commit.decorations.filter((entry) => entry.kind === "ref"),
    },
  }).trim();
  const author = presentation.author
    ? sanitizeTerminalLine(resolveHistoryAuthorLabel(row.commit)).replaceAll("\t", " ")
    : "";
  const relativeTime = presentation.date
    ? formatHistoryRelativeTime(row.commit.authoredAt, now)
    : "";
  const summaryRow = {
    ...row,
    commit: {
      ...row.commit,
      decorations: row.commit.decorations.filter((entry) => entry.kind !== "ref"),
    },
  };
  const summaryHead = summaryRow.commit.decorations.find((entry) => entry.kind === "head");
  const minimumSummaryWidth =
    !presentation.decorations || !summaryRow.commit.decorations.length
      ? 0
      : summaryHead
        ? measureTextWidth(
            `(${sanitizeTerminalLine(summaryHead.attachedLocalBranch || summaryHead.label)})`,
          )
        : 3;
  // Reserve a clock-independent budget: even the formatter's valid-Date year extremes fit16 cells.
  const desiredMetadataWidth =
    presentation.author || presentation.date
      ? Math.max(
          24,
          measureTextWidth(author) +
            (author && presentation.date ? 3 : 0) +
            (presentation.date ? 16 : 0),
        )
      : 0;
  const metadataReserve = Math.min(
    desiredMetadataWidth,
    Math.max(0, textWidth - minimumSummaryWidth - (minimumSummaryWidth ? 2 : 0)),
  );
  const secondary = presentation.decorations
    ? fitResponsiveDecorations(
        summaryRow,
        Math.max(0, textWidth - metadataReserve - (metadataReserve ? 2 : 0)),
      )
    : "";
  const secondaryWidth = measureTextWidth(secondary);
  const refs = presentation.decorations ? genericRefs.slice(1, -1) : "";
  const inlineRefLine =
    refs &&
    metadataReserve +
      (metadataReserve ? 2 : 0) +
      measureTextWidth(refs) +
      (secondary ? 2 + secondaryWidth : 0) <=
      textWidth
      ? refs
      : "";
  const refLine = refs && !inlineRefLine ? fitText(refs, textWidth, "…") : "";
  const summaryGap = inlineRefLine && secondary ? 2 : 0;
  const rowTwoRightWidth = measureTextWidth(inlineRefLine) + summaryGap + secondaryWidth;
  const metadataGap = rowTwoRightWidth ? Math.min(2, Math.max(0, textWidth - rowTwoRightWidth)) : 0;
  const metadataWidth = Math.max(0, textWidth - rowTwoRightWidth - metadataGap);
  const metadata = fitText([author, relativeTime].filter(Boolean).join(" · "), metadataWidth);
  const textRowCount = refLine || hasConvergence ? 3 : 2;
  const cutoffCount = row.cutoffLanes?.length ?? 0;
  const compactionCount = presentation.graph && row.cutoffConvergences?.length ? 1 : 0;
  const separatorIndex = metadata.indexOf(" · ");
  const fittedAuthor = author
    ? separatorIndex >= 0
      ? metadata.slice(0, separatorIndex)
      : metadata
    : "";
  const fittedRelativeTime = relativeTime
    ? separatorIndex >= 0
      ? metadata.slice(separatorIndex + 3)
      : author
        ? ""
        : metadata
    : "";
  return {
    graph,
    cutoffConvergence: compactionCount
      ? fitText(
          renderHistoryCutoffConvergence(row, !presentation.unicode),
          Math.max(1, graphWidth - 2),
          "…",
        )
      : "",
    continuation,
    convergence,
    graphWidth,
    cutoffs: (row.cutoffLanes ?? []).length
      ? presentation.graph
        ? renderHistoryCutoffs(row, !presentation.unicode).map((line) =>
            graphContentWidth > 0 && measureTextWidth(line) <= graphContentWidth ? line : "~",
          )
        : (row.cutoffLanes ?? []).map(() => "~")
      : [],
    leftWidth,
    rightWidth,
    columnGap,
    textWidth,
    refLine,
    inlineRefLine,
    textRowCount,
    commitHeight: textRowCount + cutoffCount + compactionCount,
    metadataWidth,
    metadataGap,
    summaryGap,
    secondaryWidth,
    title: formatHistoryTitle(row.commit, leftWidth),
    author: fittedAuthor,
    relativeTime: fittedRelativeTime,
    metadata,
    displayId,
    copyIcon,
    secondary,
  };
}
