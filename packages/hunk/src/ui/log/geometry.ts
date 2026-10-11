import type { HistoryGraphRow } from "../../core/history/types";
import { historyDayKey } from "./formatting";

export const LOG_ENTRY_HEIGHT = 3;
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

/** Count commit, local cutoff, and graph compaction rows without creating selectable entries. */
export function commitEntryHeight(row: HistoryGraphRow, groupByDay: boolean) {
  return (
    LOG_ENTRY_HEIGHT +
    (row.cutoffLanes?.length ?? 0) +
    (!groupByDay && row.cutoffConvergences?.length ? 1 : 0)
  );
}

/** Measure one commit entry, including a repeated day heading and spacer at viewport boundaries. */
function entryHeight(
  rows: readonly HistoryGraphRow[],
  index: number,
  top: number,
  bodyHeight: number,
  groupByDay: boolean,
) {
  const startsDay =
    groupByDay &&
    bodyHeight >= commitEntryHeight(rows[index]!, groupByDay) + LOG_DAY_HEADER_HEIGHT &&
    (index === top ||
      historyDayKey(rows[index]!.commit.authoredAt) !==
        historyDayKey(rows[index - 1]!.commit.authoredAt));
  return commitEntryHeight(rows[index]!, groupByDay) + (startsDay ? LOG_DAY_HEADER_HEIGHT : 0);
}

/** Return whether a commit fits when the viewport begins at the requested commit index. */
function selectionFits(
  rows: readonly HistoryGraphRow[],
  top: number,
  selected: number,
  bodyHeight: number,
  groupByDay: boolean,
) {
  let usedHeight = 0;
  for (let index = top; index <= selected; index += 1) {
    usedHeight += entryHeight(rows, index, top, bodyHeight, groupByDay);
    if (usedHeight > bodyHeight) return false;
  }
  return true;
}

/**
 * Plan commit entries and day headers, retaining the nearest requested physical selection row.
 * Keep the selected commit visible and preserve ordinary end-of-history backfill.
 */
export function planLogViewportGeometry({
  rows,
  selected,
  requestedTop,
  bodyHeight,
  groupByDay,
  requestedSelectedRowOffset,
}: {
  rows: readonly HistoryGraphRow[];
  selected: number;
  requestedTop: number;
  bodyHeight: number;
  groupByDay: boolean;
  requestedSelectedRowOffset?: number | null;
}): LogViewportGeometry {
  if (rows.length === 0 || bodyHeight < LOG_ENTRY_HEIGHT) {
    return { top: 0, entries: [], usedHeight: 0, selectedRowOffset: null, backfilled: false };
  }

  const safeSelected = Math.max(0, Math.min(rows.length - 1, selected));
  const minimumTop = Math.max(0, Math.min(safeSelected, requestedTop));
  let top = safeSelected;
  // Walk backward only through entries that can share the viewport with the selection. Starting
  // at requestedTop would revisit the same bounded window for every skipped commit in long logs.
  while (top > minimumTop && selectionFits(rows, top - 1, safeSelected, bodyHeight, groupByDay))
    top -= 1;
  if (requestedSelectedRowOffset != null) {
    const preferredTop = top;
    let bestDistance = Number.POSITIVE_INFINITY;
    let candidateTop = safeSelected;
    let height = entryHeight(rows, candidateTop, candidateTop, bodyHeight, groupByDay);
    let offset = height - commitEntryHeight(rows[candidateTop]!, groupByDay);
    while (height <= bodyHeight) {
      const distance = Math.abs(offset - requestedSelectedRowOffset);
      if (
        distance < bestDistance ||
        (distance === bestDistance &&
          Math.abs(candidateTop - preferredTop) < Math.abs(top - preferredTop))
      ) {
        top = candidateTop;
        bestDistance = distance;
      }
      if (candidateTop === 0) break;
      // Moving the boundary repeats its heading but may remove the previous boundary's heading.
      const addedHeight =
        entryHeight(rows, candidateTop - 1, candidateTop - 1, bodyHeight, groupByDay) +
        entryHeight(rows, candidateTop, candidateTop - 1, bodyHeight, groupByDay) -
        entryHeight(rows, candidateTop, candidateTop, bodyHeight, groupByDay);
      height += addedHeight;
      offset += addedHeight;
      candidateTop -= 1;
    }
  }
  const preservedTop = top;
  // Near EOF, backfill earlier commits instead of leaving rows empty below the last group.
  while (top > 0) {
    let candidateHeight = 0;
    for (let index = top - 1; index < rows.length && candidateHeight <= bodyHeight; index += 1) {
      candidateHeight += entryHeight(rows, index, top - 1, bodyHeight, groupByDay);
    }
    if (candidateHeight > bodyHeight) break;
    top -= 1;
  }

  const entries: LogViewportEntry[] = [];
  let usedHeight = 0;
  let selectedRowOffset: number | null = null;
  for (let index = top; index < rows.length; index += 1) {
    const height = entryHeight(rows, index, top, bodyHeight, groupByDay);
    if (usedHeight + height > bodyHeight && entries.length > 0) break;
    const visibleHeight = Math.min(height, bodyHeight - usedHeight);
    const showDayHeader = height > commitEntryHeight(rows[index]!, groupByDay);
    if (index === safeSelected)
      selectedRowOffset = usedHeight + (showDayHeader ? LOG_DAY_HEADER_HEIGHT : 0);
    entries.push({ index, row: rows[index]!, showDayHeader, height: visibleHeight });
    usedHeight += visibleHeight;
  }
  return { top, entries, usedHeight, selectedRowOffset, backfilled: top < preservedTop };
}
