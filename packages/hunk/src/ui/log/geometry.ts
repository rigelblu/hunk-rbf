import type { HistoryGraphRow } from "../../core/history/types";
import type { LogPresentation } from "./presentation";
import { projectResponsiveLogRow } from "./responsiveLayout";
import { historyDayKey } from "./formatting";

export const LOG_ENTRY_HEIGHT = 2;
export const LOG_DAY_HEADER_HEIGHT = 2;

export interface LogViewportEntry {
  index: number;
  row: HistoryGraphRow;
  showDayHeader: boolean;
  height: number;
}

export interface LogViewportGeometry {
  top: number;
  entries: LogViewportEntry[];
  usedHeight: number;
  selectedRowOffset: number | null;
  backfilled: boolean;
}

export interface LogEntryDimensions {
  width?: number;
  presentation?: LogPresentation;
}

/** Measure the same responsive commit plan that the mounted history renders. */
export function commitEntryHeight(
  row: HistoryGraphRow,
  groupByDay: boolean,
  dimensions: LogEntryDimensions = {},
) {
  const width = dimensions.width ?? 80;
  return projectResponsiveLogRow({
    row,
    width,
    presentation: dimensions.presentation ?? {
      graph: !groupByDay,
      unicode: true,
      author: true,
      date: true,
      decorations: true,
    },
  }).commitHeight;
}

/**
 * Plan commit entries and day headers, retaining the nearest requested physical selection row.
 * Preserve requested reading anchors before EOF backfill; explicit navigation fills normally.
 */
export function planLogViewportGeometry({
  rows,
  selected,
  requestedTop,
  bodyHeight,
  groupByDay,
  requestedSelectedRowOffset,
  width,
  presentation,
}: {
  rows: readonly HistoryGraphRow[];
  selected: number;
  requestedTop: number;
  bodyHeight: number;
  groupByDay: boolean;
  requestedSelectedRowOffset?: number | null;
  width?: number;
  presentation?: LogPresentation;
}): LogViewportGeometry {
  if (rows.length === 0 || bodyHeight < LOG_ENTRY_HEIGHT) {
    return { top: 0, entries: [], usedHeight: 0, selectedRowOffset: null, backfilled: false };
  }

  const measured = new Map<number, number>();
  const commitHeight = (index: number) => {
    let height = measured.get(index);
    if (height === undefined) {
      height = commitEntryHeight(rows[index]!, groupByDay, { width, presentation });
      measured.set(index, height);
    }
    return height;
  };
  const entryHeight = (index: number, top: number) => {
    const startsDay =
      groupByDay &&
      bodyHeight >= commitHeight(index) + LOG_DAY_HEADER_HEIGHT &&
      (index === top ||
        historyDayKey(rows[index]!.commit.authoredAt) !==
          historyDayKey(rows[index - 1]!.commit.authoredAt));
    return commitHeight(index) + (startsDay ? LOG_DAY_HEADER_HEIGHT : 0);
  };
  const selectionFits = (top: number, selected: number) => {
    let height = 0;
    for (let index = top; index <= selected; index += 1) {
      height += entryHeight(index, top);
      if (height > bodyHeight) return false;
    }
    return true;
  };
  const safeSelected = Math.max(0, Math.min(rows.length - 1, selected));
  const minimumTop = Math.max(0, Math.min(safeSelected, requestedTop));
  let top = safeSelected;
  // Walk backward only through entries that can share the viewport with the selection. Starting
  // at requestedTop would revisit the same bounded window for every skipped commit in long logs.
  while (top > minimumTop && selectionFits(top - 1, safeSelected)) top -= 1;
  if (requestedSelectedRowOffset != null) {
    const preferredTop = top;
    let bestDistance = Number.POSITIVE_INFINITY;
    let candidateTop = safeSelected;
    let height = entryHeight(candidateTop, candidateTop);
    let offset = height - commitHeight(candidateTop);
    while (height <= bodyHeight) {
      const distance = Math.abs(offset - requestedSelectedRowOffset);
      if (
        distance < bestDistance ||
        (distance === bestDistance &&
          ((candidateTop === preferredTop && top !== preferredTop) ||
            (candidateTop !== preferredTop && top !== preferredTop && candidateTop < top)))
      ) {
        top = candidateTop;
        bestDistance = distance;
      }
      if (candidateTop === 0) break;
      // Moving the boundary repeats its heading but may remove the previous boundary's heading.
      const addedHeight =
        entryHeight(candidateTop - 1, candidateTop - 1) +
        entryHeight(candidateTop, candidateTop - 1) -
        entryHeight(candidateTop, candidateTop);
      height += addedHeight;
      offset += addedHeight;
      candidateTop -= 1;
    }
  }
  const preservedTop = top;
  // Near EOF, backfill earlier commits instead of leaving rows empty below the last group.
  while (requestedSelectedRowOffset == null && top > 0) {
    let candidateHeight = 0;
    for (let index = top - 1; index < rows.length && candidateHeight <= bodyHeight; index += 1) {
      candidateHeight += entryHeight(index, top - 1);
    }
    if (candidateHeight > bodyHeight) break;
    top -= 1;
  }

  const entries: LogViewportEntry[] = [];
  let usedHeight = 0;
  let selectedRowOffset: number | null = null;
  for (let index = top; index < rows.length; index += 1) {
    const height = entryHeight(index, top);
    if (usedHeight + height > bodyHeight && entries.length > 0) break;
    const visibleHeight = Math.min(height, bodyHeight - usedHeight);
    const showDayHeader = height > commitHeight(index);
    if (index === safeSelected)
      selectedRowOffset = usedHeight + (showDayHeader ? LOG_DAY_HEADER_HEIGHT : 0);
    entries.push({ index, row: rows[index]!, showDayHeader, height: visibleHeight });
    usedHeight += visibleHeight;
  }
  return { top, entries, usedHeight, selectedRowOffset, backfilled: top < preservedTop };
}
