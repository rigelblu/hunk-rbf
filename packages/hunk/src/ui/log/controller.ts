import { createHistoryLaneCheckpoint, planHistoryPage } from "../../core/history/lanePlanner";
import type { HistoryGraphRow, HistoryLaneCheckpoint } from "../../core/history/types";
import {
  historyOperationTargets,
  reconcileRevisionMarks,
  revisionMark,
  revisionMarkLogicalFallbackEligible,
  revisionMarkSeenUnder,
  revisionMarkTraversalKey,
  type RevisionMarkResolution,
  type RevisionMarkStatus,
} from "../../core/history/revisionMarks";
import type { HistoryQueryTarget } from "../../core/history/queryReplacement";
import type { HistoryAcceptedInput } from "../../core/run/commandInputs";
import { sanitizeTerminalLine } from "../../lib/terminalText";
import type { ExtensionVcsHistoryGraphStyle } from "../../extension-api/types";
import type { HistoryRuntime } from "../history/types";
import { commitEntryHeight, LOG_ENTRY_HEIGHT, planLogViewportGeometry } from "./geometry";
import {
  chooseHistoryQueryFocus,
  historyQueryFailureReason,
  historyQueryPageLimit,
  HISTORY_QUERY_BLANK_MESSAGE,
  HISTORY_QUERY_NEWEST_NOTICE,
  directGraphLinks,
} from "./queryReplacement";

import type { LogPresentation } from "./presentation";
export type { LogPresentation } from "./presentation";

/** Return whether traversal filters can omit commits between adjacent displayed rows. */
export function historyFiltersCanHideIntermediateCommits(input: HistoryRuntime["input"]) {
  return Boolean(
    input.all ||
    input.author !== undefined ||
    input.grep !== undefined ||
    input.since !== undefined ||
    input.until !== undefined ||
    Boolean(input.pathspecs?.length),
  );
}

/**
 * Return whether the query in force can hide or interleave commits between adjacent rows. An
 * applied expression always can, whatever the provider reports, so the guard reads the accepted
 * input and not the launch input.
 */
export function historyInputCanHideIntermediateCommits(input: HistoryAcceptedInput) {
  return input.kind === "expression" || historyFiltersCanHideIntermediateCommits(input);
}

/** What the revset editor needs to know about the query in force. */
export interface LogQueryState {
  /** The provider accepts expression input, so the editor may open. */
  editable: boolean;
  /** `launch` runs the launch input; `custom` runs an applied expression. */
  mode: "launch" | "custom";
  /** The accepted query's exact text when its source reported one; absent when it could not. */
  expression?: string;
  /** The launch row limit, shown beside the query and kept out of its text. */
  limit?: number;
  /** Counts accepted replacements, so a watcher or view can restart on a new query. */
  generation: number;
}

/** How one Apply or Reset ended; only `applied` changed anything. */
export type LogQueryResult =
  | { status: "applied"; mode: "launch" | "custom"; expression?: string }
  | { status: "failed"; reason: string }
  | { status: "aborted" }
  | { status: "obsolete" };

/** One Apply or Reset: the typed draft, or a return to the launch input. */
export type LogQueryRequest = { kind: "apply"; expression: string } | { kind: "reset" };

export interface LogSnapshot {
  marks: readonly RevisionMarkResolution[];
  /** Ordinary selection inputs waiting for their accepted navigation/identity boundary. */
  pendingMarkEdits?: number;
  markStatus: RevisionMarkStatus;
  rows: readonly HistoryGraphRow[];
  selected: number;
  selectionAnchor: number | null;
  visualSelectionActive: boolean;
  top: number;
  /** Physical row offset inside a selected entry taller than the history body. */
  entryScroll: number;
  /** The last submitted search query, repeated by next/previous match. */
  search: string;
  historyDone: boolean;
  loading: boolean;
  notice: string;
  presentation: LogPresentation;
  scope?: HistoryRuntime["source"]["scope"];
  /** Always set by the controller; optional so hand-built snapshots stay valid. */
  query?: LogQueryState;
  graphPreference?: ExtensionVcsHistoryGraphStyle;
  graphStyle?: ExtensionVcsHistoryGraphStyle;
  supportsNativeGraph?: boolean;
  stagingGraph?: boolean;
  /** A graph, refresh or query replacement is preparing a new accepted source. */
  sourceTransitionPending?: boolean;
}

/** Find a row by immutable revision id, then by one unambiguous provider logical id. */
function findHistoryRowIndex(
  rows: readonly HistoryGraphRow[],
  identity: { revisionId: string; logicalId?: string } | undefined,
) {
  if (!identity) return -1;
  const exactIndex = rows.findIndex((row) => row.commit.revisionId === identity.revisionId);
  if (exactIndex >= 0 || !identity.logicalId) return exactIndex;
  let logicalIndex = -1;
  for (const [index, row] of rows.entries()) {
    if (row.commit.logicalId !== identity.logicalId) continue;
    if (logicalIndex >= 0) return -1;
    logicalIndex = index;
  }
  return logicalIndex;
}

/** Settle exact identity early; logical uniqueness requires the complete history. */
function isHistoryIdentitySettled(
  rows: readonly HistoryGraphRow[],
  identity: { revisionId: string; logicalId?: string },
  historyDone: boolean,
) {
  return historyDone || rows.some((row) => row.commit.revisionId === identity.revisionId);
}

/** Distinguish an exact selection-preservation refusal from a provider failure. */
class HistoryGraphSwitchRefusal extends Error {}

interface HistoryRefreshCandidate {
  abort: AbortController;
  source?: HistoryRuntime["source"];
  accepted: boolean;
  closePromise?: Promise<void>;
}

/** Report candidates that can still replace the accepted source. */
function isPendingHistoryCandidate(candidate: HistoryRefreshCandidate | null) {
  return Boolean(candidate && !candidate.accepted && !candidate.abort.signal.aborted);
}

/** Retain interactive log state independently of renderer mount/unmount cycles. */
export class LogController {
  private source: HistoryRuntime["source"];
  private checkpoint: HistoryLaneCheckpoint = createHistoryLaneCheckpoint();
  private listeners = new Set<() => void>();
  private generation = 0;
  private abort = new AbortController();
  private loadingPromise: Promise<boolean> | null = null;
  private refreshPromise: Promise<boolean> | null = null;
  private refreshCandidate: HistoryRefreshCandidate | null = null;
  private navigationTarget: number | null = null;
  private navigationPromise: Promise<void> | null = null;
  private navigationWaiters = new Set<() => void>();
  private selectionGeneration = 0;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private pendingCleanup = new Set<Promise<void>>();
  private markGeneration = 0;
  private markEditGeneration = 0;
  private markEditQueue: Promise<void> = Promise.resolve();
  private operationGeneration = 0;
  /** Traversal input the rows on screen were read under; a new mark records it with the scope. */
  private acceptedTraversalKey: string;
  /** The query the rows on screen came from: the launch input until an expression is applied. */
  private acceptedInput: HistoryAcceptedInput;
  private queryToken = 0;
  private queryCandidate: HistoryRefreshCandidate | null = null;
  private viewportBodyHeight = 1;
  private viewportWidth = 80;
  private viewportAnchorOffset: number | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private startupNotices = new Set<string>();
  private graphPreference: ExtensionVcsHistoryGraphStyle = "default";
  private graphCandidate:
    | (HistoryRefreshCandidate & { graph: boolean; preference: ExtensionVcsHistoryGraphStyle })
    | null = null;
  private snapshot: LogSnapshot;

  constructor(private readonly runtime: HistoryRuntime) {
    this.source = runtime.source;
    this.acceptedTraversalKey = revisionMarkTraversalKey(runtime.input);
    this.acceptedInput = runtime.input;
    const initialGraphStyle = runtime.source.graphStyle ?? "default";
    this.graphPreference = initialGraphStyle;
    const startupNotices = runtime.notices.map(sanitizeTerminalLine).filter(Boolean);
    this.startupNotices = new Set(startupNotices);
    this.snapshot = {
      rows: [],
      marks: [],
      markStatus: "ready",
      selected: 0,
      selectionAnchor: null,
      visualSelectionActive: false,
      top: 0,
      entryScroll: 0,
      search: "",
      historyDone: false,
      loading: false,
      notice: startupNotices.join(" • "),
      query: {
        editable: Boolean(runtime.queryReplacement),
        mode: "launch",
        ...(runtime.source.expression !== undefined
          ? { expression: runtime.source.expression }
          : {}),
        ...(runtime.input.maxCount !== undefined ? { limit: runtime.input.maxCount } : {}),
        generation: 0,
      },
      graphPreference: this.graphPreference,
      graphStyle: initialGraphStyle,
      supportsNativeGraph: Boolean(runtime.source.openGraph),
      stagingGraph: false,
      sourceTransitionPending: false,
      presentation: {
        graph: false,
        unicode: !runtime.input.ascii && process.env.TERM !== "dumb",
        author: true,
        date: true,
        decorations: true,
        workspaceNames: runtime.initialViewPreferences.historyWorkspaceNames ?? true,
      },
    };
  }

  /** Return the immutable render snapshot. */
  getSnapshot = () => this.snapshot;

  /** Report navigation that has been requested but has not reached its row yet. */
  isNavigating() {
    return this.navigationTarget !== null;
  }

  /** Subscribe one mounted surface to controller changes. */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(patch: Partial<LogSnapshot>, transitionOnly = false) {
    if (this.closed) return;
    const sourceTransitionPending = [
      this.graphCandidate,
      this.refreshCandidate,
      this.queryCandidate,
    ].some(isPendingHistoryCandidate);
    this.snapshot = { ...this.snapshot, ...patch, sourceTransitionPending };
    this.operationGeneration += 1;
    for (const listener of this.listeners) {
      if (!transitionOnly) listener();
      else {
        try {
          listener();
        } catch {
          // A transition observer cannot cancel source preparation or override its accepted result.
        }
      }
    }
  }

  /** Load one bounded page, preserving symbolic graph state across page boundaries. */
  async loadMore() {
    if (this.loadingPromise) return this.loadingPromise;
    if (this.closed) return false;
    if (this.snapshot.historyDone) return true;
    const generation = this.generation;
    const source = this.source;
    const signal = this.abort.signal;
    this.publish({ loading: true });
    const loading = (async () => {
      try {
        const page = await source.read({ limit: 256, signal });
        if (generation !== this.generation || this.closed) return false;
        if (!page.done && page.commits.length === 0)
          throw new Error("VCS history returned an empty page before EOF.");
        const planned = planHistoryPage(this.graphCommits(page.commits), this.checkpoint);
        this.checkpoint = planned.checkpoint;
        const rows = [...this.snapshot.rows, ...planned.rows];
        this.publish({
          rows,
          scope: source.scope,
          historyDone: page.done,
          notice: rows.length === 0 && page.done ? "No commits found." : this.snapshot.notice,
        });
        return true;
      } catch (error) {
        if (!signal.aborted && generation === this.generation && !this.closed) {
          const rawMessage = error instanceof Error ? error.message : String(error);
          const notice =
            this.snapshot.graphStyle === "native"
              ? `Could not load more history: ${rawMessage.replace(/[.!?]$/, "")}. Loaded revisions kept.`
              : sanitizeTerminalLine(rawMessage);
          this.publish({
            historyDone: true,
            notice: sanitizeTerminalLine(notice),
          });
          return false;
        }
        return false;
      } finally {
        if (generation === this.generation && !this.closed) this.publish({ loading: false });
      }
    })();
    this.loadingPromise = loading;
    try {
      return await loading;
    } finally {
      if (this.loadingPromise === loading) this.loadingPromise = null;
    }
  }

  /** Plan the mounted viewport with its current responsive heights and optional reading anchor. */
  planViewport(bodyHeight = this.viewportBodyHeight, width = this.viewportWidth) {
    return planLogViewportGeometry({
      rows: this.snapshot.rows,
      selected: this.snapshot.selected,
      requestedTop: this.snapshot.top,
      bodyHeight,
      width,
      presentation: this.snapshot.presentation,
      groupByDay: !this.snapshot.presentation.graph,
      requestedSelectedRowOffset: this.viewportAnchorOffset,
    });
  }

  /** Retain the closest feasible selected-title row when terminal dimensions change. */
  setViewport(width: number, bodyHeight: number) {
    const safeWidth = Math.max(1, width),
      safeHeight = Math.max(1, bodyHeight);
    if (safeWidth === this.viewportWidth && safeHeight === this.viewportBodyHeight) return;
    this.viewportAnchorOffset = this.planViewport().selectedRowOffset;
    this.viewportWidth = safeWidth;
    this.clampViewport(safeHeight);
  }

  /** Supply the same width/presentation to every geometry and oversized-entry calculation. */
  private entryDimensions() {
    return { width: this.viewportWidth, presentation: this.snapshot.presentation };
  }

  /** Keep the selected commit visible across grouped and graph viewport projections. */
  clampViewport(bodyHeight: number) {
    const safeHeight = Math.max(1, bodyHeight);
    this.viewportBodyHeight = safeHeight;
    const selected = Math.max(
      0,
      Math.min(Math.max(0, this.snapshot.rows.length - 1), this.snapshot.selected),
    );
    const geometry = planLogViewportGeometry({
      ...this.entryDimensions(),
      requestedSelectedRowOffset: this.viewportAnchorOffset,
      rows: this.snapshot.rows,
      selected,
      requestedTop: this.snapshot.top,
      bodyHeight: safeHeight,
      groupByDay: !this.snapshot.presentation.graph,
    });
    const selectionAnchor =
      this.snapshot.selectionAnchor === null
        ? null
        : Math.max(
            0,
            Math.min(Math.max(0, this.snapshot.rows.length - 1), this.snapshot.selectionAnchor),
          );
    const row = this.snapshot.rows[selected];
    const maximumScroll = row
      ? Math.max(
          0,
          commitEntryHeight(row, !this.snapshot.presentation.graph, this.entryDimensions()) -
            safeHeight,
        )
      : 0;
    const entryScroll = Math.min(this.snapshot.entryScroll, maximumScroll);
    if (
      entryScroll !== this.snapshot.entryScroll ||
      selected !== this.snapshot.selected ||
      selectionAnchor !== this.snapshot.selectionAnchor ||
      geometry.top !== this.snapshot.top
    )
      this.publish({ selected, selectionAnchor, top: geometry.top, entryScroll });
  }

  /** Select a target, optionally extending a contiguous range from the current focus. */
  select(index: number, viewportBodyHeight: number, { extend = false }: { extend?: boolean } = {}) {
    this.clearNotice();
    this.viewportAnchorOffset = null;
    if (extend && historyInputCanHideIntermediateCommits(this.acceptedInput)) {
      this.setNotice(
        "Multi-commit selection is unavailable when history traversal can hide or interleave commits.",
      );
      return Promise.resolve();
    }
    this.viewportBodyHeight = Math.max(1, viewportBodyHeight);
    const target = Math.max(0, index);
    const anchor = extend ? (this.snapshot.selectionAnchor ?? this.snapshot.selected) : null;
    const requestGeneration = ++this.selectionGeneration;
    this.publish({
      entryScroll: 0,
      selectionAnchor: anchor,
      ...(!extend ? { visualSelectionActive: false } : {}),
    });
    this.navigationTarget = target;
    const navigation = (async () => {
      while (
        target >= this.snapshot.rows.length &&
        !this.snapshot.historyDone &&
        !this.closed &&
        requestGeneration === this.selectionGeneration
      ) {
        await this.loadMore();
      }
      if (this.closed || requestGeneration !== this.selectionGeneration) return;
      const selected = Math.max(0, Math.min(this.snapshot.rows.length - 1, target));
      this.publish({
        selected,
        selectionAnchor:
          anchor === selected && !this.snapshot.visualSelectionActive ? null : anchor,
      });
      this.clampViewport(this.viewportBodyHeight);
      if (this.navigationTarget === target) this.navigationTarget = null;
      const visibleCount = planLogViewportGeometry({
        ...this.entryDimensions(),
        rows: this.snapshot.rows,
        selected: this.snapshot.selected,
        requestedTop: this.snapshot.top,
        bodyHeight: this.viewportBodyHeight,
        groupByDay: !this.snapshot.presentation.graph,
      }).entries.length;
      if (target + visibleCount >= this.snapshot.rows.length && !this.snapshot.historyDone)
        void this.loadMore();
    })();
    return this.trackNavigation(navigation);
  }

  /** Highlight an exact loaded operation endpoint using current geometry and retained range state. */
  highlightLoadedRevision(revisionId: string) {
    if (this.closed) return false;
    const index = this.snapshot.rows.findIndex((row) => row.commit.revisionId === revisionId);
    if (index < 0) return false;
    if (index === this.snapshot.selected) return true;
    this.selectionGeneration += 1;
    this.navigationTarget = null;
    this.setNavigationPromise(null);
    this.publish({ selected: index, entryScroll: 0 });
    this.clampViewport(this.viewportBodyHeight);
    return true;
  }

  /** Track only the latest request so refresh cannot restore ahead of pending input. */
  private trackNavigation(navigation: Promise<void>) {
    this.setNavigationPromise(navigation);
    void navigation.then(
      () => {
        if (this.navigationPromise === navigation) this.setNavigationPromise(null);
      },
      () => {
        if (this.navigationPromise === navigation) this.setNavigationPromise(null);
      },
    );
    return navigation;
  }

  /** Start a persistent contiguous selection at the focused commit. */
  beginVisualSelection() {
    this.clearNotice();
    if (historyInputCanHideIntermediateCommits(this.acceptedInput)) {
      this.setNotice(
        "Multi-commit selection is unavailable when history traversal can hide or interleave commits.",
      );
      return;
    }
    const hasSelectedRow = Boolean(this.snapshot.rows[this.snapshot.selected]);
    if (!hasSelectedRow && !this.refreshPromise) return;
    this.selectionGeneration += 1;
    this.navigationTarget = null;
    this.setNavigationPromise(null);
    this.publish({
      selectionAnchor: hasSelectedRow ? this.snapshot.selected : null,
      visualSelectionActive: true,
    });
  }

  /** Toggle exactly one displayed revision without changing focus or review range. */
  toggleMark(index = this.snapshot.selected) {
    const row = this.snapshot.rows[index];
    if (this.closed || !row || this.snapshot.markStatus !== "ready") return false;
    const existing = this.snapshot.marks.findIndex(
      (entry) => entry.kind === "resolved" && entry.revisionId === row.commit.revisionId,
    );
    const marks =
      existing >= 0
        ? this.snapshot.marks.filter((_, entryIndex) => entryIndex !== existing)
        : [
            ...this.snapshot.marks,
            Object.freeze({
              kind: "resolved" as const,
              mark: revisionMark(
                row.commit,
                revisionMarkSeenUnder(this.acceptedTraversalKey, this.source.scope),
              ),
              revisionId: row.commit.revisionId,
            }),
          ];
    this.markGeneration += 1;
    this.publish({ marks: Object.freeze(marks) });
    return true;
  }

  /** Queue ordinary selection against the accepted identity, with Clear invalidating late edits. */
  queueRevisionSelection(expected?: { revisionId: string | null }) {
    const epoch = this.markEditGeneration;
    const navigation = this.selectionGeneration;
    const revisionId = expected
      ? expected.revisionId
      : this.snapshot.rows[this.navigationTarget ?? this.snapshot.selected]?.commit.revisionId;
    this.publish({ pendingMarkEdits: (this.snapshot.pendingMarkEdits ?? 0) + 1 });
    const task = this.markEditQueue
      .then(async (): Promise<"changed" | "cancelled" | "unavailable"> => {
        await this.settleNavigation();
        if (this.closed || epoch !== this.markEditGeneration) return "cancelled";
        if (
          this.snapshot.markStatus !== "ready" ||
          this.snapshot.marks.some((mark) => mark.kind === "unresolved")
        )
          return "unavailable";
        const identity =
          revisionId === undefined && navigation === this.selectionGeneration
            ? this.getSelectedRow()?.commit.revisionId
            : revisionId;
        const index = this.snapshot.rows.findIndex((row) => row.commit.revisionId === identity);
        return index >= 0 && this.toggleMark(index) ? "changed" : "unavailable";
      })
      .finally(() => {
        if (!this.closed && epoch === this.markEditGeneration)
          this.publish({
            pendingMarkEdits: Math.max(0, (this.snapshot.pendingMarkEdits ?? 0) - 1),
          });
      });
    this.markEditQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  /** Drain already accepted ordinary selection before capturing an operation's fixed sources. */
  async settleRevisionSelection() {
    while (true) {
      const queue = this.markEditQueue;
      await queue;
      if (queue === this.markEditQueue) return;
    }
  }

  /** Remove only unresolved intent, retaining valid marks and reading position. */
  removeUnresolvedMarks() {
    if (this.snapshot.markStatus === "checking") return false;
    const marks = this.snapshot.marks.filter((entry) => entry.kind === "resolved");
    if (marks.length === this.snapshot.marks.length) return false;
    this.markGeneration += 1;
    this.publish({
      marks: Object.freeze(marks),
      ...(marks.length === 0 ? { markStatus: "ready" as const } : {}),
    });
    return true;
  }

  /** Seed a fresh operation's marks from the highlight after the host checks eligibility. */
  seedSourceSelection(expectedRevisionId: string) {
    const row = this.snapshot.rows[this.snapshot.selected];
    if (
      this.closed ||
      !row ||
      row.commit.revisionId !== expectedRevisionId ||
      this.snapshot.markStatus !== "ready"
    )
      return false;
    this.markGeneration += 1;
    this.publish({
      marks: Object.freeze([
        Object.freeze({
          kind: "resolved" as const,
          mark: revisionMark(
            row.commit,
            revisionMarkSeenUnder(this.acceptedTraversalKey, this.source.scope),
          ),
          revisionId: row.commit.revisionId,
        }),
      ]),
    });
    return true;
  }

  /** Clear mark intent without changing review ranges, queued navigation or reading position. */
  clearRevisionMarks() {
    if (this.closed) return false;
    this.markEditGeneration += 1;
    if (this.snapshot.marks.length === 0 && !this.snapshot.pendingMarkEdits) return false;
    this.markGeneration += 1;
    this.publish({
      marks: Object.freeze([]),
      pendingMarkEdits: 0,
      markStatus: this.snapshot.markStatus === "checking" ? "checking" : "ready",
    });
    return true;
  }

  /** Return a detached immutable operation snapshot, independently of review endpoints. */
  getOperationTargets(options: { allowHighlightedFallback?: boolean } = {}) {
    if (this.snapshot.pendingMarkEdits)
      return Object.freeze({
        kind: "blocked" as const,
        reason: "checking" as const,
        unresolved: Object.freeze([]),
      });
    return historyOperationTargets({
      ...this.snapshot,
      status: this.snapshot.markStatus,
      generation: this.operationGeneration,
      allowHighlightedFallback: options.allowHighlightedFallback,
    });
  }

  /** Clear only the review range, preserving independent revision intent and focus. */
  clearReviewRange() {
    if (
      this.closed ||
      (this.snapshot.selectionAnchor === null && !this.snapshot.visualSelectionActive)
    )
      return false;
    this.selectionGeneration += 1;
    this.navigationTarget = null;
    this.setNavigationPromise(null);
    this.publish({ selectionAnchor: null, visualSelectionActive: false });
    return true;
  }

  /** Clear marks and any range without moving the focus or reading position. */
  clearSelection() {
    if (
      this.snapshot.marks.length === 0 &&
      this.snapshot.selectionAnchor === null &&
      !this.snapshot.visualSelectionActive
    )
      return false;
    this.markGeneration += 1;
    this.selectionGeneration += 1;
    this.navigationTarget = null;
    this.setNavigationPromise(null);
    this.publish({
      selectionAnchor: null,
      visualSelectionActive: false,
      marks: [],
      markStatus: this.snapshot.markStatus === "checking" ? "checking" : "ready",
    });
    return true;
  }

  /** Wake settlement waiters whenever the latest request completes or is superseded. */
  private setNavigationPromise(navigation: Promise<void> | null) {
    this.navigationPromise = navigation;
    for (const wake of this.navigationWaiters) wake();
    this.navigationWaiters.clear();
  }

  /** Wait for the latest selection, rechecking immediately when an older request is canceled. */
  async settleNavigation() {
    while (this.navigationPromise) {
      const navigation = this.navigationPromise;
      let wake!: () => void;
      const changed = new Promise<void>((resolve) => {
        wake = resolve;
      });
      this.navigationWaiters.add(wake);
      try {
        await Promise.race([navigation, changed]);
      } finally {
        this.navigationWaiters.delete(wake);
      }
    }
  }

  move(delta: number, viewportBodyHeight: number, options: { extend?: boolean } = {}) {
    return this.select(
      (this.navigationTarget ?? this.snapshot.selected) + delta,
      viewportBodyHeight,
      options,
    );
  }

  /** Scroll an oversized entry through existing wheel/page controls without selecting its stubs. */
  scrollEntry(delta: number, viewportBodyHeight: number) {
    const row = this.snapshot.rows[this.snapshot.selected];
    // Native connectors remain scrollable when the viewport clips the three detail rows.
    if (!row || (viewportBodyHeight < LOG_ENTRY_HEIGHT && !row.commit.nativeGraph)) return false;
    const maximum = Math.max(
      0,
      commitEntryHeight(row, !this.snapshot.presentation.graph, this.entryDimensions()) -
        Math.max(1, viewportBodyHeight),
    );
    const entryScroll = Math.max(0, Math.min(maximum, this.snapshot.entryScroll + delta));
    if (entryScroll === this.snapshot.entryScroll) return false;
    this.clearNotice();
    this.selectionGeneration += 1;
    this.navigationTarget = null;
    this.setNavigationPromise(null);
    this.viewportBodyHeight = Math.max(1, viewportBodyHeight);
    this.publish({ entryScroll });
    return true;
  }

  page(delta: number, viewportBodyHeight: number, fraction = 1) {
    if (
      this.scrollEntry(
        delta * Math.max(1, Math.floor(viewportBodyHeight * fraction)),
        viewportBodyHeight,
      )
    )
      return Promise.resolve();
    const visibleCount = planLogViewportGeometry({
      ...this.entryDimensions(),
      rows: this.snapshot.rows,
      selected: this.snapshot.selected,
      requestedTop: this.snapshot.top,
      bodyHeight: viewportBodyHeight,
      groupByDay: !this.snapshot.presentation.graph,
    }).entries.length;
    return this.move(delta * Math.max(1, Math.floor(visibleCount * fraction)), viewportBodyHeight);
  }

  /** Move the history focus by half of the visible commit rows. */
  halfPage(delta: number, viewportBodyHeight: number) {
    return this.page(delta, viewportBodyHeight, 0.5);
  }

  first(viewportBodyHeight: number) {
    return this.select(0, viewportBodyHeight);
  }

  /** Resolve the last row only while this remains the latest navigation request. */
  last(viewportBodyHeight: number) {
    const requestGeneration = ++this.selectionGeneration;
    this.viewportBodyHeight = Math.max(1, viewportBodyHeight);
    this.navigationTarget = this.snapshot.selected;
    return this.trackNavigation(
      (async () => {
        while (
          !this.snapshot.historyDone &&
          !this.closed &&
          requestGeneration === this.selectionGeneration
        )
          await this.loadMore();
        if (this.closed || requestGeneration !== this.selectionGeneration) return;
        await this.select(this.snapshot.rows.length - 1, this.viewportBodyHeight);
      })(),
    );
  }

  /** Replace the repeatable query without filtering topology; the host prompt owns editing. */
  setSearch(search: string) {
    this.clearNotice();
    this.publish({ search });
  }

  /** Select the next match of one submitted query, in `direction`. */
  async search(query: string, direction: 1 | -1 = 1, viewportHeight = this.viewportBodyHeight) {
    this.setSearch(query);
    await this.findMatch(direction, viewportHeight);
  }

  /** Resolve the submitted match only while its navigation request remains current. */
  findMatch(direction: 1 | -1, viewportHeight = this.viewportBodyHeight) {
    this.viewportAnchorOffset = null;
    const needle = this.snapshot.search.toLocaleLowerCase();
    const requestGeneration = ++this.selectionGeneration;
    if (!needle) {
      this.navigationTarget = null;
      this.setNavigationPromise(null);
      return Promise.resolve();
    }
    this.viewportBodyHeight = Math.max(1, viewportHeight);
    this.navigationTarget = this.snapshot.selected;
    return this.trackNavigation(
      (async () => {
        while (
          !this.snapshot.historyDone &&
          !this.closed &&
          requestGeneration === this.selectionGeneration
        )
          await this.loadMore();
        if (this.closed || requestGeneration !== this.selectionGeneration) return;
        const rows = this.snapshot.rows;
        for (let step = 1; step <= rows.length; step += 1) {
          const index = (this.snapshot.selected + direction * step + rows.length) % rows.length;
          const commit = rows[index]!.commit;
          const haystack = [
            commit.revisionId,
            commit.displayId,
            commit.subject,
            commit.body ?? "",
            commit.authorName,
            commit.authorEmail ?? "",
            ...commit.decorations.map((entry) => entry.label),
          ]
            .join(" ")
            .toLocaleLowerCase();
          if (haystack.includes(needle)) {
            this.publish({
              selected: index,
              entryScroll: 0,
              selectionAnchor: null,
              visualSelectionActive: false,
              notice: "",
            });
            this.clampViewport(this.viewportBodyHeight);
            this.navigationTarget = null;
            return;
          }
        }
        this.navigationTarget = null;
        this.setNotice(`No match for ${this.snapshot.search}`);
      })(),
    );
  }

  private clearNotice() {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
    if (this.snapshot.notice) this.publish({ notice: "" });
  }

  /** Add startup diagnostics without replacing notices gathered before the UI mounted. */
  addStartupNotices(notices: readonly string[]) {
    const additions = notices
      .map(sanitizeTerminalLine)
      .filter((notice) => notice && !this.startupNotices.has(notice));
    if (additions.length === 0) return;
    for (const notice of additions) this.startupNotices.add(notice);
    const existing = this.snapshot.notice ? [this.snapshot.notice] : [];
    this.publish({ notice: [...existing, ...additions].join(" • ") });
  }

  setNotice(notice: string) {
    if (this.closed) return;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    const safe = sanitizeTerminalLine(notice);
    this.publish({ notice: safe });
    if (safe) {
      this.noticeTimer = setTimeout(() => {
        this.noticeTimer = null;
        if (!this.closed && this.snapshot.notice === safe) this.publish({ notice: "" });
      }, 2500);
      this.noticeTimer.unref?.();
    }
  }

  /** Toggle detail fields immediately, or stage graph visibility on the accepted source context. */
  togglePresentation(key: keyof LogPresentation) {
    if (key !== "graph") {
      this.viewportAnchorOffset = this.planViewport().selectedRowOffset;
      this.publish({
        presentation: { ...this.snapshot.presentation, [key]: !this.snapshot.presentation[key] },
      });
      this.clampViewport(this.viewportBodyHeight);
      return;
    }
    const graph = !this.snapshot.presentation.graph;
    const preference = this.graphPreference;
    void this.stageGraph(graph ? preference : "default", { graph, preference });
  }

  /** Select the other graph preference and enable Graph view, including from grouped history. */
  toggleNativeGraph() {
    if (!this.snapshot.supportsNativeGraph) {
      this.setNotice("Graph view (jj style) is available only for JJ history.");
      return;
    }
    const preference = this.graphPreference === "native" ? "default" : "native";
    void this.stageGraph(preference, { graph: true, preference });
  }

  /** Cancel a presentation candidate while leaving the accepted presentation untouched. */
  cancelStagingGraph() {
    const candidate = this.graphCandidate;
    if (!candidate) return;
    this.graphCandidate = null;
    candidate.abort.abort();
    void this.discardCandidate(candidate).catch(() => {});
    this.publish({ stagingGraph: false, notice: "" });
  }

  /**
   * Stage graph rows privately while navigation and marks continue on the accepted view.
   * Query/refresh replacement owns new context; this transaction only changes presentation.
   */
  async stageGraph(
    targetStyle: ExtensionVcsHistoryGraphStyle,
    request = {
      graph: this.snapshot.presentation.graph || targetStyle === "native",
      preference: targetStyle,
    },
  ): Promise<boolean> {
    if (this.closed) return false;
    this.cancelStagingGraph();
    if (targetStyle === this.snapshot.graphStyle) {
      this.viewportAnchorOffset = this.planViewport().selectedRowOffset;
      this.graphPreference = request.preference;
      this.publish({
        presentation: { ...this.snapshot.presentation, graph: request.graph },
        graphPreference: request.preference,
      });
      this.clampViewport(this.viewportBodyHeight);
      return true;
    }
    if ([this.queryCandidate, this.refreshCandidate].some(isPendingHistoryCandidate)) return false;
    const source = this.source;
    const openGraph = source.openGraph;
    if (!openGraph) {
      this.setNotice("Graph view (jj style) is available only for JJ history.");
      return false;
    }
    const candidate = {
      abort: new AbortController(),
      accepted: false,
      ...request,
    } as HistoryRefreshCandidate & typeof request;
    this.graphCandidate = candidate;
    const generation = this.generation;
    const queryToken = this.queryToken;
    const canApply = () =>
      !this.closed &&
      this.graphCandidate === candidate &&
      !candidate.abort.signal.aborted &&
      generation === this.generation &&
      queryToken === this.queryToken &&
      this.source === source;
    this.publish({ stagingGraph: true, notice: "Switching graph… Esc cancel" });
    try {
      candidate.source = await openGraph(targetStyle, { signal: candidate.abort.signal });
      if (!canApply()) return false;
      let rows: HistoryGraphRow[] = [];
      let checkpoint = createHistoryLaneCheckpoint();
      let done = false;
      let needsPage = true;
      while (canApply()) {
        if (needsPage) {
          const page = await candidate.source.read({ limit: 256, signal: candidate.abort.signal });
          if (!canApply()) return false;
          if (!page.done && page.commits.length === 0)
            throw new Error("VCS history returned an empty page before EOF.");
          const planned = planHistoryPage(this.graphCommits(page.commits), checkpoint);
          rows = [...rows, ...planned.rows];
          checkpoint = planned.checkpoint;
          done = page.done;
        }
        await this.settleNavigation();
        await this.settleRevisionSelection();
        if (!canApply()) return false;
        const current = this.snapshot;
        // A selection queued after the drain still belongs to the accepted source's identities.
        if (current.pendingMarkEdits) {
          needsPage = false;
          continue;
        }
        const selectedId = current.rows[current.selected]?.commit.revisionId;
        const anchorId =
          current.selectionAnchor === null
            ? undefined
            : current.rows[current.selectionAnchor]?.commit.revisionId;
        const indexOf = (id: string | undefined) =>
          id === undefined ? -1 : rows.findIndex((row) => row.commit.revisionId === id);
        const selected = indexOf(selectedId);
        const anchor = indexOf(anchorId);
        const missingSelection =
          (selectedId !== undefined && selected < 0) || (anchorId !== undefined && anchor < 0);
        const missingMarks = current.marks.some(
          (mark) => mark.kind === "resolved" && indexOf(mark.revisionId) < 0,
        );
        needsPage = !done && (missingSelection || missingMarks);
        if (needsPage) continue;
        if (missingSelection)
          throw new HistoryGraphSwitchRefusal(
            "selection is outside the history limit. Reopen with a higher --max-count.",
          );
        if (missingMarks)
          throw new HistoryGraphSwitchRefusal(
            "marked revisions are outside the history limit. Clear the marks or reopen with a higher --max-count.",
          );
        if (anchor >= 0 && selected >= 0 && anchor !== selected) {
          const oldFrom = Math.min(current.selected, current.selectionAnchor!);
          const oldTo = Math.max(current.selected, current.selectionAnchor!);
          const oldIds = new Set(
            current.rows.slice(oldFrom, oldTo + 1).map((row) => row.commit.revisionId),
          );
          const newRows = rows.slice(Math.min(selected, anchor), Math.max(selected, anchor) + 1);
          if (
            newRows.length !== oldIds.size ||
            newRows.some((row) => !oldIds.has(row.commit.revisionId))
          )
            throw new HistoryGraphSwitchRefusal(
              "selected range would change. Clear the range and retry.",
            );
        }
        const bodyHeight = this.viewportBodyHeight;
        const nextSelected = Math.max(0, selected);
        const width = this.viewportWidth;
        const { geometry, entryScroll, previousSelectedRowOffset } = this.planReplacementViewport(
          current,
          rows,
          nextSelected,
          bodyHeight,
          selected >= 0,
          request.graph,
        );
        if (!done && geometry.entries.length > 0 && geometry.backfilled) {
          needsPage = true;
          continue;
        }
        if (!canApply()) return false;
        if (
          current !== this.snapshot ||
          bodyHeight !== this.viewportBodyHeight ||
          width !== this.viewportWidth ||
          this.navigationPromise
        ) {
          needsPage = false;
          continue;
        }
        const cleanup = this.acceptCandidate(
          candidate,
          checkpoint,
          () => this.runtime.acceptSource?.(candidate.source!) ?? Promise.resolve(source.close()),
        );
        this.viewportAnchorOffset = previousSelectedRowOffset;
        this.graphPreference = request.preference;
        this.graphCandidate = null;
        this.publish({
          rows,
          marks: current.marks,
          markStatus: current.markStatus,
          selected: nextSelected,
          selectionAnchor:
            anchor >= 0 ? anchor : current.visualSelectionActive ? nextSelected : null,
          visualSelectionActive: current.visualSelectionActive && rows.length > 0,
          top: geometry.top,
          entryScroll,
          historyDone: done,
          scope: candidate.source.scope,
          graphPreference: request.preference,
          graphStyle: targetStyle,
          presentation: { ...current.presentation, graph: request.graph },
          supportsNativeGraph: Boolean(candidate.source.openGraph),
          stagingGraph: false,
          loading: false,
          notice: "",
        });
        this.reportCleanup(cleanup, candidate.source);
        return true;
      }
      return false;
    } catch (error) {
      if (canApply()) {
        const message = error instanceof Error ? error.message : String(error);
        this.setNotice(
          message.includes("configuration")
            ? "JJ configuration changed. Refresh history before switching graph."
            : error instanceof HistoryGraphSwitchRefusal
              ? `Cannot switch graph: ${message}`
              : `Could not switch graph: ${message.replace(/[.!?]$/, "")}. Current view kept.`,
        );
      }
      return false;
    } finally {
      await this.discardCandidate(candidate).catch(() => {});
      if (this.graphCandidate === candidate) {
        this.graphCandidate = null;
        this.publish({ stagingGraph: false });
      }
    }
  }

  /** Transfer cursor ownership synchronously before publishing any accepted replacement. */
  private acceptCandidate(
    candidate: HistoryRefreshCandidate,
    checkpoint: HistoryLaneCheckpoint,
    accept: () => Promise<void>,
  ) {
    const cleanup = this.trackCleanup(accept());
    candidate.accepted = true;
    const previousAbort = this.abort;
    this.generation += 1;
    this.source = candidate.source!;
    this.abort = candidate.abort;
    this.checkpoint = checkpoint;
    this.loadingPromise = null;
    previousAbort.abort();
    return cleanup;
  }

  /** Retain unfinished cleanup so shutdown joins resources whose transaction already ended. */
  private trackCleanup(cleanup: Promise<void>) {
    this.pendingCleanup.add(cleanup);
    const forget = () => this.pendingCleanup.delete(cleanup);
    void cleanup.then(forget, forget);
    return cleanup;
  }

  /** Report cleanup failures without rolling back the cursor already accepted by its owner. */
  private reportCleanup(cleanup: Promise<void>, source: HistoryRuntime["source"]) {
    void cleanup.catch((error) => {
      if (!this.closed && this.source === source)
        this.setNotice(error instanceof Error ? error.message : String(error));
    });
  }

  /** Refresh the provider cursor while reconciling selection by immutable or logical identity. */
  async refresh(
    shouldApply: () => boolean = () => true,
    removedRevisionIds: readonly string[] = [],
  ) {
    if (this.refreshPromise) return this.refreshPromise;
    const refreshing = this.performRefresh(shouldApply, new Set(removedRevisionIds));
    this.refreshPromise = refreshing;
    try {
      return await refreshing;
    } finally {
      if (this.refreshPromise === refreshing) this.refreshPromise = null;
    }
  }

  /**
   * Refresh with a read that begins after this call.
   *
   * `refresh` joins a read already in flight, and that read may have started
   * before a history change recorded its operation. This waits it out first.
   */
  async refreshAfterMutation(
    shouldApply: () => boolean = () => true,
    removedRevisionIds: readonly string[] = [],
  ) {
    if (this.refreshPromise) await this.refreshPromise.catch(() => undefined);
    return this.refresh(shouldApply, removedRevisionIds);
  }

  /** Close an unaccepted candidate once, including when quit races its read. */
  private discardCandidate(candidate: HistoryRefreshCandidate) {
    if (candidate.accepted) return Promise.resolve();
    candidate.abort.abort();
    if (candidate.source && !candidate.closePromise)
      candidate.closePromise = this.trackCleanup(
        Promise.resolve().then(() => candidate.source!.close()),
      );
    return candidate.closePromise ?? Promise.resolve();
  }

  /** Stage replacement pages privately while active paging and newer navigation continue. */
  private async performRefresh(
    shouldApply: () => boolean,
    removedRevisionIds: ReadonlySet<string>,
  ): Promise<boolean> {
    if (this.closed) return false;
    if (!shouldApply()) {
      if (this.snapshot.marks.length) this.publish({ markStatus: "refresh-failed" });
      return false;
    }
    this.cancelStagingGraph();
    const previousMarkStatus = this.snapshot.markStatus;
    const traversalKey = revisionMarkTraversalKey(this.acceptedInput);
    const candidate: HistoryRefreshCandidate = { abort: new AbortController(), accepted: false };
    this.refreshCandidate = candidate;
    this.publish({ markStatus: "checking" });
    const generation = this.generation;
    const canApply = () =>
      !this.closed &&
      generation === this.generation &&
      !candidate.abort.signal.aborted &&
      shouldApply();
    let rows: HistoryGraphRow[] = [];
    let checkpoint = createHistoryLaneCheckpoint();
    let historyDone = false;
    try {
      let replacement = await this.runtime.reopenSource(candidate.abort.signal);
      candidate.source = replacement;
      if (
        this.snapshot.graphStyle === "native" &&
        replacement.openGraph &&
        replacement.graphStyle !== "native"
      ) {
        const nativeReplacement = await replacement.openGraph("native", {
          signal: candidate.abort.signal,
        });
        const intermediate = replacement;
        replacement = nativeReplacement;
        candidate.source = replacement;
        await intermediate.close().catch(() => {});
      }
      candidate.source = replacement;
      if (!canApply()) return false;
      let needsPage = true;
      while (true) {
        if (needsPage) {
          const page = await replacement.read({ limit: 256, signal: candidate.abort.signal });
          if (!canApply()) return false;
          if (!page.done && page.commits.length === 0)
            throw new Error("VCS history returned an empty page before EOF.");
          const planned = planHistoryPage(this.graphCommits(page.commits), checkpoint);
          rows = [...rows, ...planned.rows];
          checkpoint = planned.checkpoint;
          historyDone = page.done;
        }
        await this.settleNavigation();
        if (!canApply()) return false;
        const current = this.snapshot;
        const selectedIdentity = current.rows[current.selected]?.commit;
        const anchorIdentity =
          current.selectionAnchor === null
            ? undefined
            : current.rows[current.selectionAnchor]?.commit;
        const markGeneration = this.markGeneration;
        const markIntents = current.marks.map((entry) => entry.mark);
        const identities = [selectedIdentity, anchorIdentity, ...markIntents].filter(
          (identity): identity is NonNullable<typeof identity> => Boolean(identity),
        );
        needsPage =
          !historyDone &&
          identities.some((identity) => !isHistoryIdentitySettled(rows, identity, historyDone));
        if (needsPage) continue;
        // Each mark compares these rows with where its own revision was last seen, so a mark
        // left behind by a moved bound or a changed traversal stays unchecked on later refreshes.
        const reconciled = reconcileRevisionMarks(markIntents, rows, {
          seenUnder: revisionMarkSeenUnder(traversalKey, replacement.scope),
          complete: historyDone && revisionMarkLogicalFallbackEligible(this.acceptedInput),
        });
        // Pair each reconciled result with its original intent: logical fallback may rename it.
        const marks = Object.freeze(
          reconciled.filter((_, index) => !removedRevisionIds.has(markIntents[index]!.revisionId)),
        );
        const selectedIndex = findHistoryRowIndex(rows, selectedIdentity);
        const anchorIndex = findHistoryRowIndex(rows, anchorIdentity);
        const selected = selectedIndex >= 0 ? selectedIndex : Math.max(0, anchorIndex);
        const anchor = selectedIndex >= 0 && anchorIndex >= 0 ? anchorIndex : null;
        const hasSelection = Boolean(rows[selected]);
        const visualSelectionActive =
          hasSelection && current.visualSelectionActive && (!anchorIdentity || anchor !== null);
        const selectionAnchor =
          anchor ?? (visualSelectionActive && !anchorIdentity ? selected : null);
        const bodyHeight = this.viewportBodyHeight;
        const width = this.viewportWidth;
        const { geometry, entryScroll, previousSelectedRowOffset } = this.planReplacementViewport(
          current,
          rows,
          selected,
          bodyHeight,
          selectedIndex >= 0,
        );
        // A partial candidate must not trigger the planner's EOF backfill over the reading position.
        if (!historyDone && geometry.entries.length > 0 && geometry.backfilled) {
          needsPage = true;
          continue;
        }
        // Revalidate after the caller's guard; acceptance and publication remain synchronous.
        if (!canApply()) return false;
        if (
          current !== this.snapshot ||
          markGeneration !== this.markGeneration ||
          bodyHeight !== this.viewportBodyHeight ||
          width !== this.viewportWidth ||
          this.navigationPromise
        )
          continue;
        if (traversalKey !== revisionMarkTraversalKey(this.acceptedInput))
          throw new Error("History traversal changed during refresh.");
        const previousSource = this.source;
        const accepted = this.acceptCandidate(
          candidate,
          checkpoint,
          () => this.runtime.acceptSource?.(replacement) ?? Promise.resolve(previousSource.close()),
        );
        this.acceptedTraversalKey = traversalKey;
        this.viewportAnchorOffset = previousSelectedRowOffset;
        this.publish({
          rows,
          marks,
          markStatus: "ready",
          selected,
          selectionAnchor:
            selectionAnchor !== selected || visualSelectionActive ? selectionAnchor : null,
          visualSelectionActive,
          top: geometry.top,
          entryScroll,
          historyDone,
          scope: replacement.scope,
          graphPreference: this.graphPreference,
          graphStyle: replacement.graphStyle ?? "default",
          supportsNativeGraph: Boolean(replacement.openGraph),
          loading: false,
          notice: "",
        });
        this.setNotice(
          selectedIdentity && selectedIndex < 0
            ? `Couldn’t uniquely identify selected change; moved to ${anchorIndex >= 0 ? "range anchor" : "newest change"}.`
            : rows.length === 0 && historyDone
              ? "No commits found."
              : "History refreshed.",
        );
        if (accepted)
          void accepted.catch((error) => {
            if (!this.closed && this.source === replacement)
              this.setNotice(error instanceof Error ? error.message : String(error));
          });
        return true;
      }
    } catch (error) {
      if (!this.closed && (candidate.accepted || generation === this.generation)) {
        if (this.snapshot.marks.length > 0) this.publish({ markStatus: "refresh-failed" });
        this.setNotice(error instanceof Error ? error.message : String(error));
      }
      return false;
    } finally {
      try {
        await this.discardCandidate(candidate);
      } catch (error) {
        if (!this.closed) this.setNotice(error instanceof Error ? error.message : String(error));
      }
      if (this.refreshCandidate === candidate) {
        this.refreshCandidate = null;
        this.publish({}, true);
      }
      if (
        !this.closed &&
        !candidate.accepted &&
        generation === this.generation &&
        this.snapshot.markStatus === "checking"
      )
        this.publish({
          markStatus: this.snapshot.marks.length ? "refresh-failed" : previousMarkStatus,
        });
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Query replacement                                                          */
  /* ------------------------------------------------------------------------ */

  /**
   * Plan where replacement rows sit: the selected row keeps the screen offset it had, and a tall
   * selected entry keeps its scroll only when it is the same entry (`keepEntryScroll`). A refresh
   * and a query replacement both place their new rows with this.
   */
  private planReplacementViewport(
    current: LogSnapshot,
    rows: readonly HistoryGraphRow[],
    selected: number,
    bodyHeight: number,
    keepEntryScroll: boolean,
    graph = current.presentation.graph,
  ) {
    const width = this.viewportWidth;
    const previousTop = findHistoryRowIndex(rows, current.rows[current.top]?.commit);
    const requestedTop =
      previousTop >= 0
        ? Math.min(selected, previousTop)
        : Math.max(0, selected - (current.selected - current.top));
    const currentGeometry = planLogViewportGeometry({
      width,
      presentation: current.presentation,
      requestedSelectedRowOffset: this.viewportAnchorOffset,
      rows: current.rows,
      selected: current.selected,
      requestedTop: current.top,
      bodyHeight,
      groupByDay: !current.presentation.graph,
    });
    const geometry = planLogViewportGeometry({
      width,
      presentation: { ...current.presentation, graph },
      rows,
      selected,
      requestedTop,
      bodyHeight,
      groupByDay: !graph,
      requestedSelectedRowOffset: currentGeometry.selectedRowOffset,
    });
    const entryScroll = Math.min(
      keepEntryScroll ? current.entryScroll : 0,
      rows[selected]
        ? Math.max(
            0,
            commitEntryHeight(rows[selected]!, !graph, {
              width,
              presentation: { ...current.presentation, graph },
            }) - bodyHeight,
          )
        : 0,
    );
    return { geometry, entryScroll, previousSelectedRowOffset: currentGeometry.selectedRowOffset };
  }

  /**
   * Preserve provider omission boundaries under custom queries while refusing projected
   * ancestors that are not direct parents. Range eligibility stays in its separate input policy.
   */
  private graphCommits(commits: Parameters<typeof directGraphLinks>[0]) {
    return this.acceptedInput.kind === "expression" ? directGraphLinks(commits) : [...commits];
  }

  /**
   * Run an Apply or a Reset: read one page of the replacement query, then swap rows, source,
   * accepted input and watch together, or change nothing.
   *
   * The editor keeps its draft, so a failure, an abort and a newer request all leave the accepted
   * source, rows, marks and focus exactly as they were. A newer request or quit wins: an older
   * candidate closes its own cursor and reports `obsolete`. Focus survives only on the exact
   * revision that held it; marks go through the same reconciliation as refresh.
   */
  async replaceQuery(request: LogQueryRequest, signal?: AbortSignal): Promise<LogQueryResult> {
    const replacement = this.runtime.queryReplacement;
    if (this.closed) return { status: "obsolete" };
    if (!replacement)
      return { status: "failed", reason: "This VCS provider does not support custom revsets." };
    let target: HistoryQueryTarget;
    if (request.kind === "reset") {
      target = { kind: "launch" };
    } else {
      const expression = request.expression.trim();
      if (!expression) return { status: "failed", reason: HISTORY_QUERY_BLANK_MESSAGE };
      const maxCount = this.runtime.input.maxCount;
      target = { kind: "expression", expression, ...(maxCount !== undefined ? { maxCount } : {}) };
    }
    const nextInput: HistoryAcceptedInput = target.kind === "launch" ? this.runtime.input : target;
    if (signal?.aborted) return { status: "aborted" };

    this.cancelStagingGraph();
    const token = ++this.queryToken;
    this.queryCandidate?.abort.abort();
    const candidate: HistoryRefreshCandidate = { abort: new AbortController(), accepted: false };
    this.queryCandidate = candidate;
    const relayAbort = () => candidate.abort.abort(signal?.reason);
    signal?.addEventListener("abort", relayAbort, { once: true });
    const current = () =>
      !this.closed && token === this.queryToken && !candidate.abort.signal.aborted;
    const unfinished = (): LogQueryResult =>
      signal?.aborted && token === this.queryToken && !this.closed
        ? { status: "aborted" }
        : { status: "obsolete" };
    // Set the moment the view is published, so a later throw cannot report an applied view failed.
    let applied: LogQueryResult | undefined;
    try {
      // Install cancellation before notifying observers; they can abort, quit or start a newer query.
      this.publish({}, true);
      if (!current()) return unfinished();
      let opened = await replacement.open(target, candidate.abort.signal);
      candidate.source = opened;
      if (
        this.snapshot.graphStyle === "native" &&
        opened.openGraph &&
        opened.graphStyle !== "native"
      ) {
        const nativeOpened = await opened.openGraph("native", { signal: candidate.abort.signal });
        const intermediate = opened;
        opened = nativeOpened;
        candidate.source = opened;
        await intermediate.close().catch(() => {});
      }
      candidate.source = opened;
      if (!current()) return unfinished();
      const page = await opened.read({
        limit: historyQueryPageLimit(this.runtime.input.maxCount),
        signal: candidate.abort.signal,
      });
      if (!current()) return unfinished();
      if (!page.done && page.commits.length === 0)
        throw new Error("VCS history returned an empty page before EOF.");

      // Everything below is synchronous: the focus and marks it reads are the ones on screen now.
      const planned = planHistoryPage(
        nextInput.kind === "expression" ? directGraphLinks(page.commits) : page.commits,
      );
      const rows = planned.rows;
      const before = this.snapshot;
      const previous = before.rows[before.selected]?.commit;
      const focus = chooseHistoryQueryFocus(rows, previous?.revisionId);
      const traversalKey = revisionMarkTraversalKey(nextInput);
      const marks = reconcileRevisionMarks(
        before.marks.map((entry) => entry.mark),
        rows,
        {
          seenUnder: revisionMarkSeenUnder(traversalKey, opened.scope),
          complete: page.done && revisionMarkLogicalFallbackEligible(nextInput),
        },
      );
      const { geometry, entryScroll, previousSelectedRowOffset } = this.planReplacementViewport(
        before,
        rows,
        focus.selected,
        this.viewportBodyHeight,
        focus.outcome === "kept",
      );

      const accepted = this.acceptCandidate(candidate, planned.checkpoint, () =>
        replacement.accept(target, opened),
      );
      const mode = target.kind === "launch" ? "launch" : "custom";
      applied = {
        status: "applied",
        mode,
        ...(opened.expression !== undefined ? { expression: opened.expression } : {}),
      };
      this.selectionGeneration += 1;
      this.markGeneration += 1;
      this.navigationTarget = null;
      this.setNavigationPromise(null);
      // A refresh still in flight read the previous query. Abort it, and forget its promise so the
      // next refresh starts fresh instead of joining one that can no longer publish.
      this.refreshCandidate?.abort.abort();
      this.refreshPromise = null;
      this.acceptedInput = nextInput;
      this.acceptedTraversalKey = traversalKey;
      this.viewportAnchorOffset = previousSelectedRowOffset;
      this.publish({
        rows,
        marks,
        markStatus: "ready",
        selected: focus.selected,
        selectionAnchor: null,
        visualSelectionActive: false,
        top: geometry.top,
        entryScroll,
        historyDone: page.done,
        scope: opened.scope,
        graphPreference: this.graphPreference,
        graphStyle: opened.graphStyle ?? "default",
        supportsNativeGraph: Boolean(opened.openGraph),
        loading: false,
        // An empty result is a valid answer; the list says so and the status line stays quiet.
        notice: "",
        query: {
          editable: true,
          mode,
          ...(opened.expression !== undefined ? { expression: opened.expression } : {}),
          ...(this.runtime.input.maxCount !== undefined
            ? { limit: this.runtime.input.maxCount }
            : {}),
          generation: (before.query?.generation ?? 0) + 1,
        },
      });
      if (focus.outcome === "newest") this.setNotice(HISTORY_QUERY_NEWEST_NOTICE);
      void accepted.catch((error) => {
        if (!this.closed && this.source === opened)
          this.setNotice(error instanceof Error ? error.message : String(error));
      });
      return applied;
    } catch (error) {
      // Past the commit point the view is applied, whatever a later step threw.
      if (applied) return applied;
      return current()
        ? { status: "failed", reason: historyQueryFailureReason(error) }
        : unfinished();
    } finally {
      signal?.removeEventListener("abort", relayAbort);
      try {
        await this.discardCandidate(candidate);
      } catch {
        // The accepted view is unchanged; a cursor that fails to close has nothing left to report.
      }
      if (this.queryCandidate === candidate) {
        this.queryCandidate = null;
        this.publish({}, true);
      }
    }
  }

  /** Return the focused row and normalized inclusive selection endpoints. */
  getSelection() {
    const focus = this.snapshot.rows[this.snapshot.selected];
    if (!focus) return undefined;
    const anchor = this.snapshot.selectionAnchor ?? this.snapshot.selected;
    const newestIndex = Math.min(anchor, this.snapshot.selected);
    const oldestIndex = Math.max(anchor, this.snapshot.selected);
    return {
      focus,
      newest: this.snapshot.rows[newestIndex]!,
      oldest: this.snapshot.rows[oldestIndex]!,
      newestIndex,
      oldestIndex,
      count: oldestIndex - newestIndex + 1,
    };
  }

  /** Return at most `limit` selected rows in newest-first display order. */
  getSelectedRows(limit = Number.POSITIVE_INFINITY) {
    const selection = this.getSelection();
    if (!selection) return [];
    const boundedLimit = Math.max(0, Math.floor(limit));
    return this.snapshot.rows.slice(
      selection.newestIndex,
      Math.min(selection.oldestIndex + 1, selection.newestIndex + boundedLimit),
    );
  }

  /** Return the currently focused immutable provider history row. */
  getSelectedRow() {
    return this.getSelection()?.focus;
  }

  /** Close active cursors and join cleanup retained by completed or cancelled transactions. */
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.generation += 1;
    this.selectionGeneration += 1;
    this.navigationTarget = null;
    this.abort.abort();
    this.graphCandidate?.abort.abort();
    this.setNavigationPromise(null);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
    const activeCleanup = [
      this.queryCandidate ? this.discardCandidate(this.queryCandidate) : Promise.resolve(),
      this.refreshCandidate ? this.discardCandidate(this.refreshCandidate) : Promise.resolve(),
      this.graphCandidate ? this.discardCandidate(this.graphCandidate) : Promise.resolve(),
      this.runtime.acceptSource ? Promise.resolve() : Promise.resolve(this.source.close()),
      this.runtime.close(),
    ];
    this.closePromise = Promise.allSettled([
      ...activeCleanup,
      // Accepted cleanup failures already have a notice; shutdown still waits for their resources.
      ...[...this.pendingCleanup].map((cleanup) => cleanup.catch(() => {})),
    ]).then((results) => {
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    });
    return this.closePromise;
  }
}
