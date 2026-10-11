import { createHistoryLaneCheckpoint, planHistoryPage } from "../../core/history/lanePlanner";
import type { HistoryGraphRow, HistoryLaneCheckpoint } from "../../core/history/types";
import { sanitizeTerminalLine } from "../../lib/terminalText";
import type { HistoryRuntime } from "../history/types";
import { commitEntryHeight, planLogViewportGeometry } from "./geometry";

export interface LogPresentation {
  graph: boolean;
  unicode: boolean;
  author: boolean;
  date: boolean;
  decorations: boolean;
}

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

export interface LogSnapshot {
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

interface HistoryRefreshCandidate {
  abort: AbortController;
  source?: HistoryRuntime["source"];
  accepted: boolean;
  closePromise?: Promise<void>;
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
  private viewportBodyHeight = 1;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private startupNotices = new Set<string>();
  private snapshot: LogSnapshot;

  constructor(private readonly runtime: HistoryRuntime) {
    this.source = runtime.source;
    const startupNotices = runtime.notices.map(sanitizeTerminalLine).filter(Boolean);
    this.startupNotices = new Set(startupNotices);
    this.snapshot = {
      rows: [],
      selected: 0,
      selectionAnchor: null,
      visualSelectionActive: false,
      top: 0,
      entryScroll: 0,
      search: "",
      historyDone: false,
      loading: false,
      notice: startupNotices.join(" • "),
      presentation: {
        graph: false,
        unicode: !runtime.input.ascii && process.env.TERM !== "dumb",
        author: true,
        date: true,
        decorations: true,
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

  private publish(patch: Partial<LogSnapshot>) {
    if (this.closed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
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
        const planned = planHistoryPage(page.commits, this.checkpoint);
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
          this.publish({
            historyDone: true,
            notice: sanitizeTerminalLine(error instanceof Error ? error.message : String(error)),
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

  /** Keep the selected commit visible across grouped and graph viewport projections. */
  clampViewport(bodyHeight: number) {
    const safeHeight = Math.max(1, bodyHeight);
    this.viewportBodyHeight = safeHeight;
    const selected = Math.max(
      0,
      Math.min(Math.max(0, this.snapshot.rows.length - 1), this.snapshot.selected),
    );
    const geometry = planLogViewportGeometry({
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
      ? Math.max(0, commitEntryHeight(row, !this.snapshot.presentation.graph) - safeHeight)
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
    if (extend && historyFiltersCanHideIntermediateCommits(this.runtime.input)) {
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
    if (historyFiltersCanHideIntermediateCommits(this.runtime.input)) {
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

  /** Collapse any range to the focused commit and leave visual selection mode. */
  clearSelection() {
    if (this.snapshot.selectionAnchor === null && !this.snapshot.visualSelectionActive)
      return false;
    this.selectionGeneration += 1;
    this.navigationTarget = null;
    this.setNavigationPromise(null);
    this.publish({ selectionAnchor: null, visualSelectionActive: false });
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
    if (!row) return false;
    const maximum = Math.max(
      0,
      commitEntryHeight(row, !this.snapshot.presentation.graph) - Math.max(1, viewportBodyHeight),
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

  togglePresentation(key: keyof LogPresentation) {
    this.publish({
      presentation: { ...this.snapshot.presentation, [key]: !this.snapshot.presentation[key] },
    });
    if (key === "graph") this.clampViewport(this.viewportBodyHeight);
  }

  /** Refresh the provider cursor while reconciling selection by immutable or logical identity. */
  async refresh(shouldApply: () => boolean = () => true) {
    if (this.refreshPromise) return this.refreshPromise;
    const refreshing = this.performRefresh(shouldApply);
    this.refreshPromise = refreshing;
    try {
      return await refreshing;
    } finally {
      if (this.refreshPromise === refreshing) this.refreshPromise = null;
    }
  }

  /** Close an unaccepted candidate once, including when quit races its read. */
  private discardCandidate(candidate: HistoryRefreshCandidate) {
    if (candidate.accepted) return Promise.resolve();
    candidate.abort.abort();
    if (candidate.source && !candidate.closePromise)
      candidate.closePromise = Promise.resolve().then(() => candidate.source!.close());
    return candidate.closePromise ?? Promise.resolve();
  }

  /** Stage replacement pages privately while active paging and newer navigation continue. */
  private async performRefresh(shouldApply: () => boolean): Promise<boolean> {
    if (this.closed || !shouldApply()) return false;
    const candidate: HistoryRefreshCandidate = { abort: new AbortController(), accepted: false };
    this.refreshCandidate = candidate;
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
      const replacement = await this.runtime.reopenSource(candidate.abort.signal);
      candidate.source = replacement;
      if (!canApply()) return false;
      let needsPage = true;
      while (true) {
        if (needsPage) {
          const page = await replacement.read({ limit: 256, signal: candidate.abort.signal });
          if (!canApply()) return false;
          if (!page.done && page.commits.length === 0)
            throw new Error("VCS history returned an empty page before EOF.");
          const planned = planHistoryPage(page.commits, checkpoint);
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
        const identities = [selectedIdentity, anchorIdentity].filter(
          (identity): identity is NonNullable<typeof identity> => Boolean(identity),
        );
        needsPage =
          !historyDone &&
          identities.some((identity) => !isHistoryIdentitySettled(rows, identity, historyDone));
        if (needsPage) continue;
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
        const requestedTop = Math.max(0, selected - (current.selected - current.top));
        const currentGeometry = planLogViewportGeometry({
          rows: current.rows,
          selected: current.selected,
          requestedTop: current.top,
          bodyHeight,
          groupByDay: !current.presentation.graph,
        });
        const geometry = planLogViewportGeometry({
          rows,
          selected,
          requestedTop,
          bodyHeight,
          groupByDay: !current.presentation.graph,
          requestedSelectedRowOffset: currentGeometry.selectedRowOffset,
        });
        // A partial candidate must not trigger the planner's EOF backfill over the reading position.
        if (!historyDone && geometry.entries.length > 0 && geometry.backfilled) {
          needsPage = true;
          continue;
        }
        // Revalidate after the caller's guard; acceptance and publication remain synchronous.
        if (!canApply()) return false;
        if (
          current !== this.snapshot ||
          bodyHeight !== this.viewportBodyHeight ||
          this.navigationPromise
        )
          continue;
        const accepted = this.runtime.acceptSource?.(replacement);
        candidate.accepted = true;
        this.generation += 1;
        const previousAbort = this.abort;
        this.source = replacement;
        this.abort = candidate.abort;
        this.checkpoint = checkpoint;
        this.loadingPromise = null;
        previousAbort.abort();
        this.publish({
          rows,
          selected,
          selectionAnchor:
            selectionAnchor !== selected || visualSelectionActive ? selectionAnchor : null,
          visualSelectionActive,
          top: geometry.top,
          entryScroll: Math.min(
            selectedIndex >= 0 ? current.entryScroll : 0,
            rows[selected]
              ? Math.max(
                  0,
                  commitEntryHeight(rows[selected]!, !current.presentation.graph) - bodyHeight,
                )
              : 0,
          ),
          historyDone,
          scope: replacement.scope,
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
      if (!this.closed) this.setNotice(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      try {
        await this.discardCandidate(candidate);
      } catch (error) {
        if (!this.closed) this.setNotice(error instanceof Error ? error.message : String(error));
      }
      if (this.refreshCandidate === candidate) this.refreshCandidate = null;
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

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    this.selectionGeneration += 1;
    this.navigationTarget = null;
    this.abort.abort();
    this.setNavigationPromise(null);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
    await Promise.all([
      this.refreshCandidate ? this.discardCandidate(this.refreshCandidate) : Promise.resolve(),
      this.runtime.close(),
    ]);
  }
}
