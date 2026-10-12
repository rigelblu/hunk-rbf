import type { HistoryCommit, HistoryGraphRow } from "../../core/history/types";
import { sanitizeTerminalText } from "../../lib/terminalText";

/** Longest error reason the editor shows, in UTF-16 units, the closing ellipsis included. */
export const HISTORY_QUERY_REASON_UNITS = 4096;

/** Most commits an Apply or Reset reads before it replaces the view. */
export const HISTORY_QUERY_PAGE_LIMIT = 256;

/** Sentence for an Apply with nothing to apply; Reset is the explicit way back to launch policy. */
export const HISTORY_QUERY_BLANK_MESSAGE = "Enter a revset, or choose Reset.";

/** Timed notice for a replacement whose previously focused revision is not in the first page. */
export const HISTORY_QUERY_NEWEST_NOTICE = "Selected newest; previous not loaded.";

/** Sanitize and cap a provider's error text for the editor, keeping its line breaks. */
export function historyQueryFailureReason(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  const text =
    sanitizeTerminalText(raw).replaceAll("\t", " ").trim() || "History could not be read.";
  if (text.length <= HISTORY_QUERY_REASON_UNITS) return text;
  let end = HISTORY_QUERY_REASON_UNITS - 1;
  // Never end on half of a surrogate pair.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** Narrow the first page of a replacement by the launch row limit; zero rows still need one read. */
export function historyQueryPageLimit(maxCount: number | undefined) {
  return Math.max(1, Math.min(HISTORY_QUERY_PAGE_LIMIT, maxCount ?? HISTORY_QUERY_PAGE_LIMIT));
}

/**
 * Drop every graph link a provider sent, so a custom query never draws a line through commits it
 * leaves out. Real parent ids stay, because they still drive single-revision review.
 */
export function withoutGraphLinks(commits: readonly HistoryCommit[]): HistoryCommit[] {
  return commits.map((commit) => ({ ...commit, graphParentRevisionIds: [] }));
}

/** Where focus lands once a replacement's first page is in. */
export type HistoryQueryFocus =
  | { outcome: "kept"; selected: number }
  | { outcome: "newest"; selected: 0 }
  | { outcome: "first"; selected: 0 }
  | { outcome: "empty"; selected: 0 };

/**
 * Keep focus only on the exact revision that was focused, if the first page holds it. A changed
 * query is changed traversal input, so there is no logical-identity fallback: any other focused
 * revision gives way to the newest row, and the caller announces it.
 */
export function chooseHistoryQueryFocus(
  rows: readonly HistoryGraphRow[],
  previousRevisionId: string | undefined,
): HistoryQueryFocus {
  if (rows.length === 0) return { outcome: "empty", selected: 0 };
  if (previousRevisionId === undefined) return { outcome: "first", selected: 0 };
  const index = rows.findIndex((row) => row.commit.revisionId === previousRevisionId);
  return index >= 0 ? { outcome: "kept", selected: index } : { outcome: "newest", selected: 0 };
}
