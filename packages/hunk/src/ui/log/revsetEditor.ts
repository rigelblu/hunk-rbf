import { fitText, measureTextWidth, wrapSanitizedTextByWidth } from "../lib/text";
import type { LogQueryRequest, LogQueryState } from "./controller";

/**
 * Draft state and layout rules for the revset editor.
 *
 * Triggers that converge here: the `L` key and View → Edit revset… open it; typing, the
 * previous-input list, F2/F3/Esc and the mouse change it. It owns what the editor shows for a given
 * draft, list and notice at a given terminal size, and nothing about how a query is applied: the
 * log controller applies, and the log surface decides when a result closes the editor.
 */

export const REVSET_EDITOR_TITLE = "Edit revset";
export const REVSET_FIELD_PREFIX = "Revset: ";
export const LAUNCH_POLICY_LABEL = "Launch policy";
export const CUSTOM_REVSET_LABEL = "Custom revset";
export const CUSTOM_RESTRICTION = "Custom revset: graph links and range review unavailable.";
export const PREVIOUS_INPUTS_LABEL = "Previous inputs";
export const NO_PREVIOUS_INPUTS = "No previous inputs yet.";
export const EXPRESSION_UNAVAILABLE = "Active revset unavailable. Enter a new revset or Reset.";
export const APPLYING_REVSET = "Applying revset…";
export const RESTORING_LAUNCH_POLICY = "Restoring launch policy…";
export const TOO_SMALL_MESSAGE = "Terminal too small for revset editing. Resize or press Esc.";

/** Longest draft the field accepts, matching the executable-text bound on the extension contract. */
export const REVSET_DRAFT_MAX_UNITS = 65_536;
/** Most previous inputs shown at once; the rest scroll. */
export const MAX_VISIBLE_SUGGESTIONS = 8;
/** First terminal height the normal editor frame fits at 40 columns. */
export const COMPACT_EDITOR_BELOW_HEIGHT = 15;
/** Smallest terminal the editor draws in at all. */
export const MIN_EDITOR_WIDTH = 24;
export const MIN_EDITOR_HEIGHT = 8;

export type EditorPhase = "editing" | "applying" | "resetting";
export type EditorMode = "launch" | "custom";
export type EditorActionId = "apply" | "reset" | "cancel";

/** Everything the open editor remembers; the log surface keeps one while the editor is open. */
export interface RevsetEditorState {
  draft: string;
  /** Index of the highlighted previous input, or null while none is. */
  highlight: number | null;
  phase: EditorPhase;
  /** The failure or guidance text under the mode line; empty when there is none. */
  notice: string;
  /** First visible line of a notice taller than its region. */
  noticeOffset: number;
  /** Previous inputs, most recent first, copied when the editor opened. */
  previous: readonly string[];
  /** The query the history behind the editor is showing. */
  accepted: { mode: EditorMode; expression?: string };
  limit?: number;
  /** The frame's size, place and style when a request started; a busy frame keeps all three. */
  frozen?: { height: number; top: number; compact?: boolean };
}

/** Open the editor on the accepted expression, or on an empty draft when the source gave none. */
export function openRevsetEditor(
  query: LogQueryState,
  previous: readonly string[],
): RevsetEditorState {
  return {
    draft: query.expression ?? "",
    highlight: null,
    phase: "editing",
    notice: query.expression === undefined ? EXPRESSION_UNAVAILABLE : "",
    noticeOffset: 0,
    previous: [...previous],
    accepted: {
      mode: query.mode,
      ...(query.expression !== undefined ? { expression: query.expression } : {}),
    },
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
  };
}

/** Compare Apply text without changing the provider's accepted metadata or literal inner spaces. */
function draftMatchesAcceptedExpression(state: RevsetEditorState): boolean {
  return (
    state.accepted.expression !== undefined &&
    state.draft.trim() === state.accepted.expression.trim()
  );
}

/** Preview the accepted mode while Apply text matches the accepted expression. */
export function editorMode(state: RevsetEditorState): EditorMode {
  return draftMatchesAcceptedExpression(state) ? state.accepted.mode : "custom";
}

/** `Launch policy · Limit: 100` or `Custom revset · Limit: none`. */
export function modeLine(mode: EditorMode, limit: number | undefined) {
  return `${mode === "launch" ? LAUNCH_POLICY_LABEL : CUSTOM_REVSET_LABEL} · Limit: ${limit ?? "none"}`;
}

/** Take a typed change: any edit clears the highlight and the notice, and keeps the caret. */
export function editDraft(state: RevsetEditorState, draft: string): RevsetEditorState {
  if (draft === state.draft) return state;
  return { ...state, draft, highlight: null, notice: "", noticeOffset: 0 };
}

/** Move the highlight through the list, wrapping, starting from the end that matches the direction. */
export function moveHighlight(state: RevsetEditorState, delta: 1 | -1): RevsetEditorState {
  const count = state.previous.length;
  if (count === 0) return state;
  const highlight =
    state.highlight === null
      ? delta > 0
        ? 0
        : count - 1
      : (state.highlight + delta + count) % count;
  return { ...state, highlight };
}

/** Highlight one row, as a click on it does. */
export function highlightRow(state: RevsetEditorState, index: number): RevsetEditorState {
  return index >= 0 && index < state.previous.length ? { ...state, highlight: index } : state;
}

/** Replace the whole field with the highlighted previous input; this never applies it. */
export function insertHighlighted(state: RevsetEditorState): RevsetEditorState {
  const text = state.highlight === null ? undefined : state.previous[state.highlight];
  if (text === undefined) return state;
  return {
    ...state,
    draft: text,
    highlight: null,
    notice: "",
    noticeOffset: 0,
  };
}

/** What F2 or an unhighlighted Enter does with the draft. */
export type ApplyDecision =
  | { kind: "reject"; notice: string }
  | { kind: "noop" }
  | { kind: "apply"; request: LogQueryRequest };

/**
 * Decide what Apply does. Text that equals the accepted text closes the editor and opens
 * nothing, so launch policy stays launch policy; a blank draft is refused; anything else is a
 * custom expression, including the launch text typed over a custom query.
 */
export function decideApply(state: RevsetEditorState): ApplyDecision {
  const expression = state.draft.trim();
  if (!expression) return { kind: "reject", notice: "Enter a revset, or choose Reset." };
  if (draftMatchesAcceptedExpression(state)) return { kind: "noop" };
  return { kind: "apply", request: { kind: "apply", expression } };
}

/** Show the busy state: the list gives way to the busy notice and the actions go inert. */
export function beginRequest(
  state: RevsetEditorState,
  request: LogQueryRequest,
  frozen?: { height: number; top: number; compact?: boolean },
): RevsetEditorState {
  return {
    ...state,
    phase: request.kind === "reset" ? "resetting" : "applying",
    highlight: null,
    notice: request.kind === "reset" ? RESTORING_LAUNCH_POLICY : APPLYING_REVSET,
    noticeOffset: 0,
    ...(frozen ? { frozen } : {}),
  };
}

/** Return to the editor with the draft kept, after an abort or a failure. */
export function endRequest(state: RevsetEditorState, notice = ""): RevsetEditorState {
  const { frozen: _frozen, ...rest } = state;
  return { ...rest, phase: "editing", notice, noticeOffset: 0 };
}

/** The editor text for a failed request. */
export function failureNotice(request: LogQueryRequest, reason: string) {
  return request.kind === "reset" ? `Reset failed: ${reason}` : `Revset not applied: ${reason}`;
}

/**
 * Wrap provider text for a region `width` cells wide, keeping its line breaks and each line's
 * leading spaces. Words wrap at spaces; a word wider than the region splits.
 */
export function wrapNoticeText(text: string, width: number): string[] {
  const limit = Math.max(1, width);
  const lines: string[] = [];
  for (const physical of text.split("\n")) {
    let current = "";
    let hasWord = false;
    const push = () => {
      lines.push(current.trimEnd());
      current = "";
      hasWord = false;
    };
    for (const [, spaces, word] of physical.matchAll(/( *)(\S+)/g)) {
      const candidate = `${current}${spaces}${word}`;
      if (measureTextWidth(candidate) <= limit) {
        current = candidate;
        hasWord = true;
        continue;
      }
      if (hasWord) push();
      if (measureTextWidth(word!) <= limit) {
        current = word!;
        hasWord = true;
        continue;
      }
      const chunks = wrapSanitizedTextByWidth(word!, limit).map((chunk) => chunk.text);
      for (const chunk of chunks.slice(0, -1)) lines.push(chunk);
      current = chunks.at(-1) ?? "";
      hasWord = current.length > 0;
    }
    lines.push(current.trimEnd());
  }
  return lines;
}

/** One row of the editor's contents, top to bottom, inside the frame. */
export type EditorRow =
  | { kind: "field" }
  | { kind: "mode"; text: string }
  | { kind: "blank" }
  | { kind: "text"; text: string; tone: "text" | "muted" | "error" }
  | { kind: "item"; index: number; text: string; highlighted: boolean }
  | { kind: "hint"; text: string }
  | { kind: "actions"; items: Array<{ id: EditorActionId; label: string }> };

export interface EditorFrame {
  width: number;
  /** Frame height including its border and chrome rows. */
  height: number;
  /** Top row of the frame in the terminal. */
  top: number;
}

export type EditorLayout =
  | { kind: "too-small" }
  | {
      kind: "layout";
      compact: boolean;
      frame: EditorFrame;
      /** Cells inside the frame's border and padding. */
      bodyWidth: number;
      rows: EditorRow[];
      /** Set while a notice taller than its region scrolls. */
      noticeScroll?: { offset: number; visible: number; total: number; maxOffset: number };
      /** Whether any previous-input row is on screen, so Tab and the arrows have something to move. */
      listVisible: boolean;
    };

/** Frame width: 8 cells narrower than the terminal up to 96, or 2 narrower on a narrow one. */
export function editorFrameWidth(terminalWidth: number) {
  return Math.min(96, terminalWidth >= 64 ? terminalWidth - 8 : terminalWidth - 2);
}

/**
 * Split the action legend into rows of at most `width` cells, keeping the strings whole. A busy
 * legend that does not fit one row takes a row per label unless `packed` asks for the labels to
 * share rows.
 */
export function planActionRows(busy: boolean, width: number, packed = false) {
  const items: Array<{ id: EditorActionId; label: string }> = [
    { id: "apply", label: busy ? "[F2] Apply (busy)" : "[F2] Apply" },
    { id: "reset", label: busy ? "[F3] Reset (busy)" : "[F3] Reset" },
    { id: "cancel", label: "[Esc] Cancel" },
  ];
  const rows: Array<typeof items> = [];
  // A busy legend that does not fit one row takes three, so no label shares a row with another.
  const joinedWidth = items.reduce((sum, item) => sum + measureTextWidth(item.label), 0) + 4;
  if (busy && !packed && joinedWidth > width) return items.map((item) => [item]);
  let current: typeof items = [];
  let used = 0;
  for (const item of items) {
    const itemWidth = measureTextWidth(item.label);
    const needed = current.length === 0 ? itemWidth : used + 2 + itemWidth;
    if (current.length > 0 && needed > width) {
      rows.push(current);
      current = [];
      used = 0;
    }
    used = current.length === 0 ? itemWidth : used + 2 + itemWidth;
    current.push(item);
  }
  if (current.length > 0) rows.push(current);
  return rows;
}

/** Wrap the standing restriction for the editor's body width. */
function restrictionLines(mode: EditorMode, width: number) {
  return mode === "custom" ? wrapNoticeText(CUSTOM_RESTRICTION, width) : [];
}

function listRowCount(total: number, visible: number) {
  return total === 0 ? 1 : 1 + visible + (total > visible ? 1 : 0);
}

/** First visible list index that keeps the highlight in a window of `visible` rows. */
export function listWindowStart(total: number, visible: number, highlight: number | null) {
  if (highlight === null || total <= visible) return 0;
  return Math.max(0, Math.min(total - visible, highlight - Math.floor(visible / 2)));
}

/**
 * Decide which sections the body shows and how tall each is. Rows go to the notice first, then
 * the list, then the restriction line, so the restriction is the first thing dropped. A notice that
 * does not fit beside the list replaces the list and the restriction; one that still does not fit
 * scrolls, with one row of its region given to the scroll hint.
 */
function planBody({
  rows,
  separator,
  noticeLines,
  noticeOffset,
  listTotal,
  showList,
  restriction,
  maxVisible,
}: {
  rows: number;
  separator: number;
  noticeLines: string[];
  noticeOffset: number;
  listTotal: number;
  showList: boolean;
  restriction: string[];
  /** Most previous inputs the list may show: eight, or one in the compact frame. */
  maxVisible: number;
}) {
  if (rows <= 0)
    return {
      intact: false,
      showNotice: false,
      showRestriction: false,
      listShown: false,
      listVisible: 0,
      noticeClip: undefined as number | undefined,
      scroll: undefined as
        | { offset: number; visible: number; total: number; maxOffset: number }
        | undefined,
    };
  const joined = (heights: number[]) =>
    heights.length === 0
      ? 0
      : heights.reduce((sum, h) => sum + h, 0) + separator * (heights.length - 1);
  const naturalVisible = Math.min(maxVisible, listTotal);
  const noticeHeight = noticeLines.length;
  const natural = showList ? listRowCount(listTotal, naturalVisible) : 0;
  const smallest = showList ? listRowCount(listTotal, Math.min(1, listTotal)) : 0;
  const R = restriction.length;
  const sections = (heights: Array<number | 0>) => heights.filter((h) => h > 0);

  const showNotice = noticeHeight > 0;
  let noticeClip: number | undefined;
  let showRestriction = false;
  let listVisible = 0;
  let listShown = false;
  // True while the body drops nothing it would show with unlimited rows.
  let intact = false;
  let scroll: { offset: number; visible: number; total: number; maxOffset: number } | undefined;

  const fitList = (available: number) => {
    for (let visible = naturalVisible; visible >= Math.min(1, listTotal); visible -= 1) {
      if (listRowCount(listTotal, visible) <= available) return visible;
    }
    return Math.min(1, listTotal);
  };

  if (noticeHeight > 0) {
    if (joined(sections([noticeHeight, natural, R])) <= rows) {
      listShown = showList;
      listVisible = naturalVisible;
      showRestriction = R > 0;
      intact = true;
    } else if (joined(sections([noticeHeight, natural])) <= rows) {
      listShown = showList;
      listVisible = naturalVisible;
    } else if (showList && joined([noticeHeight, smallest]) <= rows) {
      listShown = true;
      listVisible = fitList(rows - noticeHeight - separator);
    } else if (noticeHeight <= rows) {
      // The notice replaces the list and the restriction; it fits whole, so it has no scroll row.
    } else if (rows < 2) {
      // Only one row is left: the notice keeps its first line, so a failure is never hidden.
      noticeClip = 1;
    } else {
      const visible = Math.max(1, rows - 1);
      const maxOffset = Math.max(0, noticeHeight - visible);
      scroll = {
        offset: Math.max(0, Math.min(maxOffset, noticeOffset)),
        visible,
        total: noticeHeight,
        maxOffset,
      };
    }
  } else if (showList) {
    if (joined(sections([natural, R])) <= rows) {
      listShown = true;
      listVisible = naturalVisible;
      showRestriction = R > 0;
      intact = true;
    } else if (natural <= rows) {
      listShown = true;
      listVisible = naturalVisible;
    } else {
      listShown = true;
      listVisible = fitList(rows);
    }
  } else if (R > 0 && R <= rows) {
    showRestriction = true;
    intact = true;
  } else if (R === 0) {
    intact = true;
  }
  return { intact, showNotice, showRestriction, listShown, listVisible, noticeClip, scroll };
}

/**
 * Lay the editor out for one terminal.
 *
 * The normal frame separates sections with blank rows and pads the title and bottom; below 15
 * rows the compact frame drops that padding and the separators and keeps a three-row body. Too
 * small to hold the title, field, mode line and actions, it returns `too-small`.
 */
export function planRevsetEditor(
  state: RevsetEditorState,
  terminal: { width: number; height: number },
  /** `compact` forces the compact frame, whatever the terminal height. */
  options: { compact?: boolean } = {},
): EditorLayout {
  return planEditorLayout(state, terminal, true, options.compact);
}

/** True while the notice is a provider or validation failure, which may grow the frame. */
function hasFailureNotice(state: RevsetEditorState) {
  return (
    state.phase === "editing" && state.notice !== "" && state.notice !== EXPRESSION_UNAVAILABLE
  );
}

function planEditorLayout(
  state: RevsetEditorState,
  terminal: { width: number; height: number },
  withStablePosition: boolean,
  forceCompact?: boolean,
): EditorLayout {
  if (terminal.width < MIN_EDITOR_WIDTH || terminal.height < MIN_EDITOR_HEIGHT)
    return { kind: "too-small" };
  // A busy frame keeps the style (compact or normal) it had when the request started.
  const compact =
    forceCompact ??
    (state.phase !== "editing" ? state.frozen?.compact : undefined) ??
    terminal.height < COMPACT_EDITOR_BELOW_HEIGHT;
  const frameWidth = Math.max(1, editorFrameWidth(terminal.width));
  const bodyWidth = Math.max(1, frameWidth - 4);
  const chrome = compact ? 3 : 5;
  const screenHeight = terminal.height - (compact ? 1 : 2);
  const busy = state.phase !== "editing";
  // A busy legend takes a row per label where it must wrap. It never makes the frame taller than
  // it was, or taller than the terminal allows, so it packs its labels, and failing that drops
  // the "(busy)" marks, rather than push the busy notice out.
  const legendLimit =
    busy && state.frozen ? Math.min(screenHeight, state.frozen.height) : screenHeight;
  let actionRows = planActionRows(busy, bodyWidth);
  if (busy && chrome + 2 + actionRows.length > legendLimit) {
    const packedRows = planActionRows(true, bodyWidth, true);
    actionRows = packedRows.length < actionRows.length ? packedRows : actionRows;
    if (chrome + 2 + actionRows.length > legendLimit) {
      const idleRows = planActionRows(false, bodyWidth);
      if (idleRows.length < actionRows.length) actionRows = idleRows;
    }
  }
  // A busy frame never grows past the size it had when the request started, unless its own
  // controls need more; it never covers the status row either way.
  const maxHeight =
    busy && state.frozen
      ? Math.min(screenHeight, Math.max(state.frozen.height, chrome + 2 + actionRows.length))
      : screenHeight;
  const failure = hasFailureNotice(state);
  const mode = editorMode(state);
  const separator = compact ? 0 : 1;
  const noticeLines = state.notice ? wrapNoticeText(state.notice, bodyWidth) : [];
  const restriction = restrictionLines(mode, bodyWidth);
  const clip = (text: string) => fitText(text, bodyWidth, "…");

  /** What each planned frame kept of its notice and body, for choosing between attempts. */
  const outcomes = new WeakMap<EditorLayout, { wholeNotice: boolean; intact: boolean }>();

  /** Build the frame for one body budget, or null when it does not fit the available rows. */
  const attempt = (
    bodyRows: number,
    withHint: boolean,
    withMode: boolean,
    padded = true,
  ): EditorLayout | null => {
    const plan = planBody({
      rows: bodyRows,
      separator,
      noticeLines,
      noticeOffset: state.noticeOffset,
      listTotal: state.previous.length,
      showList: !busy,
      restriction,
      maxVisible: compact ? 1 : MAX_VISIBLE_SUGGESTIONS,
    });
    const body: EditorRow[] = [];
    const section = (rows: EditorRow[]) => {
      if (rows.length === 0) return;
      if (body.length > 0 && separator > 0) body.push({ kind: "blank" });
      body.push(...rows);
    };
    const addNotice = () => {
      if (!(plan.showNotice || plan.scroll)) return;
      // A notice cut to its first lines ends in an ellipsis, so the cut never reads as the whole.
      const shown =
        plan.noticeClip === undefined
          ? noticeLines
          : noticeLines.slice(0, plan.noticeClip).map((line) => clip(`${line}…`));
      const noticeTone =
        state.phase !== "editing"
          ? "muted"
          : state.notice.startsWith("Revset not applied") || state.notice.startsWith("Reset failed")
            ? "error"
            : "text";
      if (plan.scroll) {
        const { offset, visible, total } = plan.scroll;
        section([
          ...noticeLines
            .slice(offset, offset + visible)
            .map((text): EditorRow => ({ kind: "text", text, tone: noticeTone })),
          {
            kind: "text",
            text: clip(`PgUp/PgDn scroll · ${visible}/${total} lines`),
            tone: "muted",
          },
        ]);
      } else {
        section(shown.map((text): EditorRow => ({ kind: "text", text, tone: noticeTone })));
      }
    };
    let visibleItems = 0;
    const addList = () => {
      if (!plan.listShown) return;
      const total = state.previous.length;
      if (total === 0) {
        section([{ kind: "text", text: clip(NO_PREVIOUS_INPUTS), tone: "muted" }]);
        return;
      }
      visibleItems = Math.min(plan.listVisible, total);
      const start = listWindowStart(total, visibleItems, state.highlight);
      const rows: EditorRow[] = [
        { kind: "text", text: clip(PREVIOUS_INPUTS_LABEL), tone: "muted" },
      ];
      for (let index = start; index < start + visibleItems; index += 1) {
        rows.push({
          kind: "item",
          index,
          text: fitText(state.previous[index]!, Math.max(1, bodyWidth - 2), "…"),
          highlighted: index === state.highlight,
        });
      }
      if (total > visibleItems)
        rows.push({
          kind: "text",
          text: clip(`${visibleItems}/${total} suggestions`),
          tone: "muted",
        });
      section(rows);
    };
    const addRestriction = () => {
      if (plan.showRestriction)
        section(restriction.map((text): EditorRow => ({ kind: "text", text, tone: "muted" })));
    };
    // The normal frame leads with the standing restriction; the compact frame gives it what is left.
    for (const add of compact
      ? [addNotice, addList, addRestriction]
      : [addRestriction, addNotice, addList])
      add();

    const rows: EditorRow[] = [{ kind: "field" }];
    if (withMode) rows.push({ kind: "mode", text: clip(modeLine(mode, state.limit)) });
    if (compact) {
      rows.push(...body);
      for (let filler = body.length; filler < bodyRows; filler += 1) rows.push({ kind: "blank" });
    } else if (body.length > 0) {
      rows.push(...(padded ? [{ kind: "blank" } as const] : []), ...body);
      if (padded) rows.push({ kind: "blank" });
    }
    if (!busy && withHint) {
      const choose = visibleItems > 0 ? "Tab/↑↓ choose · " : "";
      const action = state.highlight === null ? "Enter apply" : "Enter insert";
      rows.push({ kind: "hint", text: clip(`${choose}${action}`) });
    }
    // A busy frame keeps the height it had when the request started; the freed rows stay blank.
    if (busy && state.frozen) {
      const pad =
        Math.min(state.frozen.height, maxHeight) - (chrome + rows.length + actionRows.length);
      for (let index = 0; index < pad; index += 1) rows.push({ kind: "blank" });
    }
    for (const items of actionRows) rows.push({ kind: "actions", items });
    if (chrome + rows.length > maxHeight) return null;

    const height = chrome + rows.length;
    let top = Math.max(0, Math.floor((terminal.height - height) / 2));
    if (!compact) {
      if (busy && state.frozen?.top !== undefined) {
        top = Math.max(0, Math.min(state.frozen.top, terminal.height - height));
      } else if (withStablePosition && !failure) {
        // Hold the top where the tallest layout of this editor would put it, so the field does not
        // move as the draft switches mode, a previous input is highlighted, or Apply starts. A
        // source with no revset opens with a notice that the first keystroke clears; that
        // taller layout counts too.
        const probes = (
          state.accepted.expression === undefined ? ["", EXPRESSION_UNAVAILABLE] : [""]
        ).map((notice) =>
          planEditorLayout(
            {
              ...state,
              draft: `${state.accepted.expression ?? ""}\u0000`,
              highlight: null,
              phase: "editing",
              notice,
              frozen: undefined,
            },
            terminal,
            false,
            compact,
          ),
        );
        const tallest = Math.max(
          height,
          ...probes.map((probe) => (probe.kind === "layout" ? probe.frame.height : 0)),
        );
        top = Math.max(0, Math.floor((terminal.height - tallest) / 2));
      }
    } else if (withStablePosition && !failure && !busy && state.accepted.expression === undefined) {
      // A compact frame centres on its own height, except that a source with no revset opens with
      // a notice the first keystroke clears: the top holds where the taller of the two puts it.
      const probes = ["", EXPRESSION_UNAVAILABLE].map((notice) =>
        planEditorLayout({ ...state, notice }, terminal, false, true),
      );
      const tallest = Math.max(
        height,
        ...probes.map((probe) => (probe.kind === "layout" ? probe.frame.height : 0)),
      );
      top = Math.max(0, Math.floor((terminal.height - tallest) / 2));
    }
    const planned: EditorLayout = {
      kind: "layout",
      compact,
      frame: { width: frameWidth, height, top },
      bodyWidth,
      rows,
      ...(plan.scroll ? { noticeScroll: plan.scroll } : {}),
      listVisible: visibleItems > 0,
    };
    outcomes.set(planned, {
      wholeNotice:
        noticeLines.length === 0 ||
        (plan.showNotice && !plan.scroll && plan.noticeClip === undefined),
      intact: plan.intact,
    });
    return planned;
  };

  /** Rows the body may take once the fixed rows are accounted for. */
  const widestBody = (withHint: boolean, withMode: boolean) =>
    compact
      ? 3
      : Math.max(
          0,
          maxHeight -
            chrome -
            1 -
            (withMode ? 1 : 0) -
            (withHint && !busy ? 1 : 0) -
            actionRows.length -
            2,
        );
  /** The widest body that satisfies `accept`, or null when no body of at least `floor` rows does. */
  const tryBodies = (
    withHint: boolean,
    withMode: boolean,
    floor: number,
    accept: (layout: EditorLayout) => boolean = () => true,
    padded = true,
  ) => {
    // The two blank rows that pad the body in the normal frame are rows it may use.
    const extra = padded || compact ? 0 : 2;
    for (let body = widestBody(withHint, withMode) + extra; body >= floor; body -= 1) {
      const layout = attempt(body, withHint, withMode, padded);
      if (layout && accept(layout)) return layout;
    }
    return null;
  };

  let found: EditorLayout | null;
  if (failure || busy) {
    // The notice is the text the user needs: a failure's error, or the name of the work under way.
    // It gets every row it needs before anything else is cut. Rows go in this order: the hint,
    // then the list and the restriction, then the blank rows that pad the body, then the mode
    // line, and only then is the notice clipped or scrolled. A cut notice is never silent.
    const whole = (layout: EditorLayout) => outcomes.get(layout)?.wholeNotice === true;
    const scrolls = (layout: EditorLayout) =>
      layout.kind === "layout" && layout.noticeScroll !== undefined;
    const untouched = (layout: EditorLayout) =>
      whole(layout) && outcomes.get(layout)?.intact === true;
    found =
      tryBodies(true, true, 1, untouched) ??
      tryBodies(false, true, 1, untouched) ??
      tryBodies(false, true, 1, whole) ??
      tryBodies(false, true, 1, whole, false) ??
      tryBodies(false, false, 1, whole, false) ??
      // No size shows it whole. It scrolls where two rows allow, and else keeps its first line.
      tryBodies(false, true, 1, scrolls) ??
      tryBodies(false, true, 1, scrolls, false) ??
      tryBodies(false, false, 1, scrolls, false) ??
      tryBodies(false, false, 1, () => true, false);
  } else {
    // Drop filler first, then the restriction, then the list, and the hint last.
    found = tryBodies(true, true, 0) ?? attempt(0, false, true);
  }
  const layout: EditorLayout = found ?? { kind: "too-small" };
  // The normal frame needs two more rows of padding and gaps than the compact one. When that
  // costs the list its last row, the compact frame, which shows one at every smaller size, wins.
  // A source with no revset opens with a notice the first keystroke clears; the frame keeps the
  // style the notice-free editor picks, so that keystroke does not switch it.
  if (!compact && forceCompact === undefined && layout.kind === "layout" && !busy) {
    const noticeFree =
      state.notice === EXPRESSION_UNAVAILABLE
        ? planEditorLayout({ ...state, notice: "" }, terminal, withStablePosition)
        : null;
    const wantsCompact = noticeFree
      ? noticeFree.kind === "layout" && noticeFree.compact
      : !layout.listVisible && state.previous.length > 0;
    if (wantsCompact) {
      const alternative = planEditorLayout(state, terminal, withStablePosition, true);
      if (alternative.kind === "layout" && (noticeFree || alternative.listVisible))
        return alternative;
    }
  }
  return layout;
}

/** Scroll the notice by whole lines, clamped to its extent. */
export function scrollNotice(
  state: RevsetEditorState,
  layout: EditorLayout,
  delta: number,
): RevsetEditorState {
  if (layout.kind !== "layout" || !layout.noticeScroll) return state;
  const offset = Math.max(
    0,
    Math.min(layout.noticeScroll.maxOffset, layout.noticeScroll.offset + delta),
  );
  return offset === state.noticeOffset ? state : { ...state, noticeOffset: offset };
}

/**
 * Put the edit command in front of history's status hint, but only where the longer hint still fits
 * beside the status text with the status line's two-cell gap; otherwise today's hint stays. No
 * bound key, or no hint at all, leaves the hint as it is.
 */
export function editRevsetStatusHint(
  hint: string,
  key: string | undefined,
  statusText: string,
  terminalWidth: number,
) {
  if (!hint || !key) return hint;
  const longer = `${key} edit revset · ${hint}`;
  return measureTextWidth(statusText) + 2 + measureTextWidth(longer) <= terminalWidth - 2
    ? longer
    : hint;
}
