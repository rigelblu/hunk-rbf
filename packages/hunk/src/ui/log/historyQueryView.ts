import { fitText, measureTextWidth } from "../lib/text";
import type { LogQueryState } from "./controller";
import {
  COMPACT_EDITOR_BELOW_HEIGHT,
  CUSTOM_REVSET_LABEL,
  CUSTOM_RESTRICTION,
  EXPRESSION_UNAVAILABLE,
  REVSET_FIELD_PREFIX,
  modeLine,
  wrapNoticeText,
} from "./revsetEditor";

/** Rows the history screen adds around its list for a provider that accepts revset expressions. */
export interface HistoryQueryView {
  /** Rows between the menu's spacer and the list. */
  top: Array<{ kind: "revset" | "mode" | "custom"; text: string } | { kind: "blank" }>;
  /** Standing restriction lines directly above the status line. */
  bottom: string[];
  /** A custom query has no mainline scope line: the restriction line takes its place. */
  replacesScopeLine: boolean;
}

/** Split off the longest head of at most `cells` terminal cells, at a code point boundary. */
function takeCells(text: string, cells: number): [string, string] {
  let head = "";
  let used = 0;
  const points = Array.from(text);
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    const width = measureTextWidth(point);
    if (used + width > cells) return [head, points.slice(index).join("")];
    head += point;
    used += width;
  }
  return [head, ""];
}

const EMPTY_VIEW: HistoryQueryView = { top: [], bottom: [], replacesScopeLine: false };

/**
 * Plan what history adds for the accepted query. A provider that cannot edit its query adds
 * nothing. From 15 rows up the complete revset (two rows at most, clipped with an ellipsis) and
 * the mode and limit sit above the list, and a custom query adds its restriction below it. Under
 * 15 rows launch policy adds nothing and a custom query adds one `Custom revset: {expression}` row.
 */
export function planHistoryQueryView(
  query: LogQueryState | undefined,
  terminal: { width: number; height: number },
): HistoryQueryView {
  if (!query?.editable) return EMPTY_VIEW;
  const custom = query.mode === "custom";
  const width = Math.max(1, terminal.width - 2);
  if (terminal.height < COMPACT_EDITOR_BELOW_HEIGHT) {
    if (!custom) return EMPTY_VIEW;
    const text =
      query.expression === undefined
        ? CUSTOM_REVSET_LABEL
        : fitText(`${CUSTOM_REVSET_LABEL}: ${query.expression}`, width, "…");
    return { top: [{ kind: "custom", text }], bottom: [], replacesScopeLine: true };
  }
  const top: HistoryQueryView["top"] = [];
  if (query.expression !== undefined) {
    // Fill the first row to the box width, continue on a second row indented one cell, and clip
    // that row with an ellipsis. The break falls inside a token: the text is the executed one.
    const [first, rest] = takeCells(`${REVSET_FIELD_PREFIX}${query.expression}`, width);
    top.push({ kind: "revset", text: first });
    if (rest) top.push({ kind: "revset", text: ` ${fitText(rest, Math.max(1, width - 1), "…")}` });
  } else {
    top.push({ kind: "revset", text: fitText(EXPRESSION_UNAVAILABLE, width, "…") });
  }
  top.push(
    { kind: "mode", text: fitText(modeLine(query.mode, query.limit), width, "…") },
    { kind: "blank" },
  );
  return {
    top,
    bottom: custom ? wrapNoticeText(CUSTOM_RESTRICTION, width) : [],
    replacesScopeLine: custom,
  };
}

/** How many rows the view takes from the list. */
export function historyQueryViewRows(view: HistoryQueryView) {
  return view.top.length + view.bottom.length;
}
