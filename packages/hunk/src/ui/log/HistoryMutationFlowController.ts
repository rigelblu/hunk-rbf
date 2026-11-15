/**
 * Keep source selection, destination choice and one confirmed history change in the session.
 * Rebase inspection temporarily borrows review without ending the visit. Squash captures
 * persistent selection once and keeps surviving intent through cancellation and actual readback.
 * The provider runtime owns processes, freshness and readback; the log controller owns rows,
 * ranges and reading position. Every callback carries its visit and preparation generation.
 */
import { createElement } from "react";
import type { KeyEvent } from "@opentui/core";
import type {
  ExtensionVcsHistoryCommit,
  ExtensionVcsMutationPrepared,
  ExtensionVcsMutationPreparation,
  ExtensionVcsMutationRequest,
  ExtensionVcsMutationResult,
} from "../../extension-api/types";
import type { HistoryMutationRuntime } from "../history/types";
import type { LogController } from "./controller";
import {
  toHistoryMutationRevisionRef,
  type HistoryMutationFlow,
  type HistoryMutationModal,
  type HistoryMutationModalFrame,
  type HistoryMutationStartOptions,
} from "./mutationFlow";
import { RevisionSourceSelection } from "./revisionSourceSelection";
import {
  handleRevisionSourcePanelKey,
  revisionSourcePanelLayout,
  type RevisionSourcePanelActions,
  type RevisionSourcePanelState,
} from "./RevisionSourcePanel";
import {
  HistoryOperationView,
  destinationLayout,
  squashDockLayout,
  squashErrorOutputAvailable,
  squashDockTooSmall,
  historyOperationTooSmall,
  planHistoryOperationOverlay,
} from "./HistoryOperationView";

import type {
  HistoryOperationKind,
  HistoryInspectionToken,
  HistoryOperationSnapshot,
  HistoryOperationViewFlow,
} from "./historyOperationTypes";
export type {
  HistoryOperationKind,
  HistoryInspectionToken,
  HistoryOperationSnapshot,
} from "./historyOperationTypes";

import { cleanSquashResultNotice } from "./mutationPresentation";

const SQUASH_CHECKING_DELAY_MS = 400;

/** Retain one operation visit even when its log surface unmounts for inspection. */
export class HistoryMutationFlowController
  implements HistoryMutationFlow, HistoryOperationViewFlow
{
  private readonly listeners = new Set<() => void>();
  private readonly sources: RevisionSourceSelection;
  private abort: AbortController | null = null;
  private work: Promise<void> | null = null;
  private pendingInput = 0;
  private deliveringInput = false;
  private queue: Promise<void> = Promise.resolve();
  private ending: Promise<void> | null = null;
  private closed = false;
  private inspection = 0;
  private invocation: ExtensionVcsHistoryCommit | null = null;
  private options: HistoryMutationStartOptions = {};
  private visitRan = false;
  private readonly undisposed = new Set<string>();
  private cleanupReason = "";
  private lastResult: ExtensionVcsMutationResult | null = null;
  private lastPrepared: ExtensionVcsMutationPrepared | null = null;
  private pendingRemovedIds: readonly string[] = [];
  private snapshot: HistoryOperationSnapshot;
  private readonly ownedModal: HistoryMutationModal;
  private readonly stopController: () => void;
  private squashCandidate: string | null = null;
  private checkingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly controller: LogController,
    private readonly runtime?: HistoryMutationRuntime,
  ) {
    this.sources = new RevisionSourceSelection(controller, (commit) =>
      commit.isImmutable
        ? { eligible: false, reason: "This revision is immutable." }
        : { eligible: true },
    );
    this.ownedModal = {
      presentation: "docked",
      render: (frame) => createElement(HistoryOperationView, { flow: this, frame }),
      rows: (frame) =>
        this.snapshot.operation === "squash" &&
        ["destination", "preparing", "result"].includes(this.snapshot.phase)
          ? squashDockLayout(this, frame).rows
          : this.snapshot.phase === "sources"
            ? revisionSourcePanelLayout({
                operationLabel: this.snapshot.operation!,
                width: frame.terminalWidth,
                state: this.sourceState(),
                actions: this.sourceActions(frame),
              }).rows
            : this.snapshot.phase === "destination"
              ? destinationLayout(this, frame).rows
              : 1,
      statusLine: (frame) =>
        this.snapshot.phase === "destination"
          ? (this.destinationRefusal(frame.highlighted) ?? "Choose the destination, then preview.")
          : "",
      rowMark: (commit, frame) => ({
        tags: !this.snapshot.visit
          ? []
          : [
              ...(this.snapshot.sources.some((source) => source.revisionId === commit.revisionId) &&
              !(
                this.snapshot.operation === "squash" &&
                this.snapshot.sources.length > 1 &&
                frame.highlighted?.revisionId === commit.revisionId
              )
                ? [this.snapshot.operation === "squash" ? "from" : "source"]
                : []),
              ...(frame.highlighted?.revisionId === commit.revisionId &&
              (!this.snapshot.sources.some((source) => source.revisionId === commit.revisionId) ||
                (this.snapshot.operation === "squash" && this.snapshot.sources.length > 1))
                ? [this.snapshot.operation === "squash" ? "into" : "destination"]
                : []),
            ],
        muted:
          frame.highlighted?.revisionId === commit.revisionId &&
          Boolean(this.destinationRefusal(commit)),
      }),
      handleKey: (key, frame) => this.handleKey(key, frame),
    };
    this.snapshot = Object.freeze({
      phase: "idle",
      visit: null,
      attempt: 0,
      operation: null,
      suspended: false,
      squashCheckingVisible: false,
      sources: [],
      placement: "onto",
      prepared: null,
      request: null,
      result: null,
      reason: "",
      providerText: "",
      details: false,
      fullResult: false,
      resultNotice: null,
      focus: 0,
      scroll: 0,
      refreshFailed: false,
      modal: null,
    });
    this.stopController = controller.subscribe(() => this.scheduleSquashPreview());
  }

  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  /** Limit delayed feedback to a live Squash check of the highlighted destination. */
  private isPendingSquash(s: HistoryOperationSnapshot) {
    return (
      !this.closed &&
      !this.ending &&
      s.operation === "squash" &&
      s.phase === "preparing" &&
      s.visit !== null &&
      (!s.request ||
        (s.request.kind === "squash" &&
          s.request.destination.revisionId === this.controller.getSelectedRow()?.commit.revisionId))
    );
  }
  /** Publish immediately; delay only busy copy, never preparation or readiness. */
  private publish(update: Partial<HistoryOperationSnapshot>) {
    const previous = this.snapshot;
    const next = { ...previous, ...update };
    const pending = this.isPendingSquash(next);
    const samePreparation =
      previous.phase === "preparing" &&
      previous.visit === next.visit &&
      previous.attempt === next.attempt &&
      previous.request === next.request;
    if (!pending || !samePreparation) {
      if (this.checkingTimer !== null) clearTimeout(this.checkingTimer);
      this.checkingTimer = null;
      next.squashCheckingVisible = false;
      if (pending) {
        const { visit, attempt, request } = next;
        const timer = setTimeout(() => {
          if (this.checkingTimer !== timer) return;
          this.checkingTimer = null;
          const current = this.snapshot;
          if (
            current.visit === visit &&
            current.attempt === attempt &&
            current.request === request &&
            this.isPendingSquash(current)
          )
            this.publish({ squashCheckingVisible: true });
        }, SQUASH_CHECKING_DELAY_MS);
        this.checkingTimer = timer;
      }
    }
    this.snapshot = Object.freeze(next);
    const listeners = Array.from(this.listeners);
    for (const listener of listeners) listener();
  }
  /** Project this session's modal presentation without changing its identity. */
  private show(update: Partial<HistoryOperationSnapshot>) {
    const phase = update.phase ?? this.snapshot.phase;
    const overlay =
      phase === "confirmation" ||
      (phase === "result" && this.snapshot.operation !== "squash") ||
      ((phase === "destination" || phase === "result") &&
        (update.details ?? this.snapshot.details));
    this.publish({
      ...(phase !== "result" ? { resultNotice: null, fullResult: false } : {}),
      ...update,
      modal: Object.freeze({ ...this.ownedModal, presentation: overlay ? "overlay" : "docked" }),
    });
  }
  /** Serialize input after any already queued navigation, then reject stale visits. */
  private enqueue(visit: symbol, action: () => void | Promise<void>) {
    this.pendingInput += 1;
    this.queue = this.queue
      .then(async () => {
        await this.controller.settleNavigation();
        if (
          !this.closed &&
          !this.ending &&
          this.snapshot.visit === visit &&
          !this.snapshot.suspended
        ) {
          this.deliveringInput = true;
          try {
            await action();
          } finally {
            this.deliveringInput = false;
          }
        }
      })
      .catch((error) =>
        this.controller.setNotice(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => {
        this.pendingInput -= 1;
      });
  }
  /** Keep a provider settlement available to terminal cancellation and session shutdown. */
  private track(action: () => Promise<void>) {
    const task = action();
    this.work = task;
    void task
      .finally(() => {
        if (this.work === task) {
          this.work = null;
          if (!this.closed) this.publish({});
        }
      })
      .catch(() => undefined);
    return task;
  }
  /** Retain failed handle cleanup and report it without an unhandled rejection or false teardown claim. */
  private async disposeHandle(handleId: string): Promise<boolean> {
    try {
      await this.runtime?.dispose(handleId);
      this.undisposed.delete(handleId);
      if (!this.undisposed.size) this.cleanupReason = "";
      return true;
    } catch (error) {
      this.undisposed.add(handleId);
      this.cleanupReason = `Could not discard the preview: ${error instanceof Error ? error.message : String(error)}`;
      this.controller.setNotice(this.cleanupReason);
      return false;
    }
  }
  /** Retry only retained cleanup handles, never a command or Apply. */
  private async retryCleanup() {
    const handles = Array.from(this.undisposed);
    for (const handleId of handles) await this.disposeHandle(handleId);
    return this.undisposed.size === 0;
  }
  /** Require an explicit single ready source; never borrow the highlighted row after clearing. */
  sourceState(): RevisionSourcePanelState {
    const targets = this.snapshot.visit
      ? this.sources.targets(this.snapshot.visit)
      : Object.freeze({ kind: "empty" as const });
    const selectedCount = this.controller.getSnapshot().marks.length;
    const selected =
      targets.kind === "ready" && targets.revisionIds.length === 1
        ? this.controller
            .getSnapshot()
            .rows.find((row) => row.commit.revisionId === targets.revisionIds[0])?.commit
        : undefined;
    const refusal =
      targets.kind === "ready" && targets.revisionIds.length !== 1
        ? `This action takes one revision. ${targets.revisionIds.length} are selected.`
        : targets.kind === "ready" && (!selected || selected.isImmutable)
          ? "The selected source is unavailable or immutable."
          : undefined;
    return {
      targets,
      selectedCount,
      ...(refusal ? { continueRefusal: refusal } : {}),
      ...(this.snapshot.reason ? { notice: this.snapshot.reason } : {}),
    };
  }

  /** Build callbacks with the exact visit shown in this frame. */
  sourceActions(frame: HistoryMutationModalFrame): RevisionSourcePanelActions {
    const visit = this.snapshot.visit!;
    const attempt = this.snapshot.attempt;
    return {
      toggle: () => this.toggleSource(visit),
      continue: () => this.continueSources(visit),
      cancel: () => {
        void this.cancelVisit(visit, attempt);
      },
      inspect: () => {
        if (
          this.snapshot.visit === visit &&
          this.snapshot.phase === "sources" &&
          !this.snapshot.suspended
        )
          frame.inspectHighlighted?.();
      },
      reviewMarks: () => {
        if (
          this.snapshot.visit === visit &&
          this.snapshot.phase === "sources" &&
          !this.snapshot.suspended
        )
          frame.reviewMarks?.();
      },
    };
  }
  /** Draw marks from the same controller/locked source set, never another selection store. */
  indicator(revisionId: string) {
    return this.sources.indicator(revisionId);
  }

  /** Capture exact Squash intent once, or open Rebase's editable source selection. */
  async beginSources(operation: HistoryOperationKind): Promise<boolean> {
    if (
      this.closed ||
      this.ending ||
      this.snapshot.visit ||
      this.work ||
      this.snapshot.refreshFailed ||
      this.undisposed.size
    ) {
      this.controller.setNotice(
        this.cleanupReason ||
          (this.snapshot.refreshFailed
            ? "Refresh history before starting another action."
            : "Another history change is still active."),
      );
      return false;
    }
    const visit = Symbol(operation);
    this.visitRan = false;
    const attempt = this.snapshot.attempt + 1;
    const abort = new AbortController();
    this.abort = abort;
    this.show({
      phase: "preparing",
      visit,
      attempt,
      operation,
      suspended: false,
      prepared: null,
      result: null,
      request: null,
      sources: [],
      reason: "",
      providerText: "",
      details: false,
      focus: 0,
      scroll: 0,
      placement: "onto",
    });
    let entered = false;
    await this.track(async () => {
      try {
        await this.controller.settleNavigation();
        await this.controller.settleRevisionSelection();
        if (!this.isCurrent(visit, attempt)) return;
        this.invocation = this.controller.getSelectedRow()?.commit ?? null;
        let captured: readonly ExtensionVcsHistoryCommit[] = [];
        if (operation === "squash") {
          const targets = this.controller.getOperationTargets();
          const range = this.controller.getSnapshot();
          const refusal =
            targets.kind === "blocked"
              ? targets.reason === "checking"
                ? "Refreshing history… Selection is still checking."
                : targets.reason === "refresh-failed"
                  ? "History refresh failed. Refresh before using this selection."
                  : "Review unresolved selections or clear them before Squash."
              : targets.kind === "empty"
                ? "No revision is highlighted."
                : targets.source === "highlight" &&
                    (range.selectionAnchor !== null || range.visualSelectionActive)
                  ? "A review range is not an operation source. Clear the review range first."
                  : null;
          if (refusal || targets.kind !== "ready") {
            this.finish(visit);
            this.show({
              phase: "result",
              reason: refusal ?? "No revision is selected.",
              result: null,
            });
            return;
          }
          const rows = this.controller.getSnapshot().rows;
          const commits = targets.revisionIds.map(
            (id) => rows.find((row) => row.commit.revisionId === id)?.commit,
          );
          if (!commits.length || commits.some((commit) => !commit || commit.isImmutable)) {
            this.finish(visit);
            this.show({
              phase: "result",
              reason: "A selected source is unavailable or immutable.",
              result: null,
            });
            return;
          }
          captured = Object.freeze(commits.map((commit) => Object.freeze({ ...commit! })));
        }
        const available = await this.runtime?.availability(abort.signal);
        if (!this.isCurrent(visit, attempt)) return;
        if (
          !available ||
          available.kind === "unsupported" ||
          !available.kinds.includes(operation)
        ) {
          this.finish(visit);
          this.show({
            phase: "result",
            reason:
              available?.kind === "unsupported"
                ? available.reason
                : "This provider does not offer this action.",
            result: null,
          });
          return;
        }
        if (operation === "squash") {
          this.squashCandidate = null;
          this.show({ phase: "destination", sources: captured, reason: "" });
          entered = true;
          this.scheduleSquashPreview();
          return;
        }
        const range = this.controller.getSelection();
        if (range && range.count > 1) {
          this.finish(visit);
          this.show({
            phase: "result",
            reason: "A review range is not an operation source. Clear the review range first.",
            result: null,
          });
          return;
        }
        this.invocation = this.controller.getSelectedRow()?.commit ?? null;
        const entry = this.sources.begin(visit);
        if (entry.kind !== "changed") {
          this.finish(visit);
          this.show({
            phase: "result",
            reason:
              entry.kind === "refused" ? entry.reason : "Source selection is no longer active.",
            result: null,
          });
          return;
        }
        this.show({ phase: "sources" });
        entered = true;
      } catch (error) {
        if (this.isCurrent(visit, attempt)) {
          this.finish(visit);
          this.show({ phase: "result", reason: String(error), result: null });
        }
      }
    });
    return entered;
  }
  /** Resolve a clicked immutable render identity against live rows before toggling it. */
  toggleSource(visit: symbol, revisionId?: string) {
    this.enqueue(visit, () => {
      if (this.snapshot.phase !== "sources") return;
      const index =
        revisionId === undefined
          ? this.controller.getSnapshot().selected
          : this.controller
              .getSnapshot()
              .rows.findIndex((row) => row.commit.revisionId === revisionId);
      const edit = this.sources.toggle(visit, index);
      this.publish({ reason: edit.kind === "refused" ? edit.reason : "" });
    });
  }
  /** Lock the complete provider-order source snapshot only after one-source validation. */
  continueSources(visit: symbol) {
    this.enqueue(visit, () => {
      if (this.snapshot.phase !== "sources") return;
      const state = this.sourceState();
      if (state.targets.kind !== "ready" || state.continueRefusal) return;
      const commits = state.targets.revisionIds.map(
        (id) =>
          this.controller.getSnapshot().rows.find((row) => row.commit.revisionId === id)?.commit,
      );
      if (commits.length !== 1 || !commits[0] || commits[0].isImmutable) {
        this.publish({ reason: "The selected source is no longer available." });
        return;
      }
      this.sources.lock(visit);
      this.squashCandidate = null;
      this.show({
        phase: "destination",
        sources: Object.freeze([Object.freeze({ ...commits[0] })]),
        reason: "",
      });
      this.scheduleSquashPreview();
    });
  }
  /** Serialize inspection with source edits so accepted Space cannot disappear behind suspension. */
  inspectSource(visit: symbol, inspect: (token: HistoryInspectionToken) => void | Promise<void>) {
    this.enqueue(visit, async () => {
      const token = this.beginInspection(visit);
      if (token) await inspect(token);
    });
  }
  /** Enable Squash only for the prepared exact candidate currently highlighted in history. */
  squashDestinationReady(): boolean {
    const s = this.snapshot;
    const current = this.controller.getSelectedRow()?.commit;
    return (
      s.operation === "squash" &&
      s.phase === "destination" &&
      !this.work &&
      !this.ending &&
      !this.closed &&
      !s.details &&
      Boolean(s.prepared) &&
      s.prepared?.request.kind === "squash" &&
      s.prepared.request.destination.revisionId === current?.revisionId &&
      !this.destinationRefusal(current ?? null)
    );
  }
  /** Prepare content effects as the candidate changes, disposing every obsolete ready handle. */
  private scheduleSquashPreview(force = false) {
    const s = this.snapshot;
    if (
      !s.visit ||
      s.sources.length < 1 ||
      s.operation !== "squash" ||
      s.details ||
      this.ending ||
      this.closed ||
      !["destination", "preparing"].includes(s.phase)
    )
      return;
    const current = this.controller.getSelectedRow()?.commit;
    const candidate = current?.revisionId ?? "";
    if (!force && candidate === this.squashCandidate) return;
    this.squashCandidate = candidate;
    // Invalidate old feedback as soon as navigation changes the candidate, before disposal settles.
    this.publish({ squashCheckingVisible: false });
    if (s.phase === "preparing") this.abort?.abort();
    this.enqueue(s.visit, async () => {
      await this.work;
      if (
        this.squashCandidate !== candidate ||
        this.snapshot.visit !== s.visit ||
        this.ending ||
        this.closed ||
        !["destination", "preparing"].includes(this.snapshot.phase)
      )
        return;
      const prepared = this.snapshot.prepared;
      if (prepared && !(await this.disposeHandle(prepared.handleId))) {
        this.reopen(this.cleanupReason);
        return;
      }
      const live = this.controller.getSelectedRow()?.commit;
      const refusal = this.destinationRefusal(live ?? null);
      if (refusal || live?.revisionId !== candidate) {
        this.show({
          phase: "destination",
          prepared: null,
          reason: refusal ?? "The destination changed.",
        });
        return;
      }
      this.start({
        kind: "squash",
        sources: this.snapshot.sources
          .filter((source) => source.revisionId !== live!.revisionId)
          .map(toHistoryMutationRevisionRef) as [
          ReturnType<typeof toHistoryMutationRevisionRef>,
          ...ReturnType<typeof toHistoryMutationRevisionRef>[],
        ],
        destination: toHistoryMutationRevisionRef(live!),
      });
    });
  }
  /** Queue placement changes with destination progression under the rendered visit. */
  choosePlacement(
    visit: symbol,
    placement: "onto" | "after" | "before",
    attempt = this.snapshot.attempt,
  ) {
    this.enqueue(visit, () => {
      if (this.snapshot.phase === "destination" && this.snapshot.attempt === attempt)
        this.publish({ placement, reason: "", focus: 0 });
    });
  }
  /** Suspend editing while the session prepares and borrows the highlighted singleton review. */
  beginInspection(visit: symbol): HistoryInspectionToken | null {
    if (
      this.closed ||
      this.ending ||
      (this.pendingInput > 0 && !this.deliveringInput) ||
      this.snapshot.visit !== visit ||
      this.snapshot.phase !== "sources" ||
      this.snapshot.suspended
    )
      return null;
    const token = Object.freeze({ visit, inspection: ++this.inspection });
    this.publish({ suspended: true });
    return token;
  }
  /** Resume only the inspection belonging to the retained visit. */
  finishInspection(token: HistoryInspectionToken) {
    if (
      this.snapshot.visit === token.visit &&
      token.inspection === this.inspection &&
      this.snapshot.phase === "sources"
    )
      this.publish({ suspended: false });
  }
  /** Name destination eligibility without changing provider authority over the actual preview. */
  destinationRefusal(commit: ExtensionVcsHistoryCommit | null): string | null {
    if (!commit) return "No revision is highlighted.";
    if (
      this.snapshot.sources.some((source) => source.revisionId === commit.revisionId) &&
      (this.snapshot.operation !== "squash" || this.snapshot.sources.length === 1)
    )
      return "This is the source. Pick another revision as the destination.";
    if (
      commit.isImmutable &&
      (this.snapshot.operation === "squash" || this.snapshot.placement === "before")
    )
      return "This destination is immutable. Choose another revision.";
    return null;
  }
  /** Preview the live destination after navigation settles; no stale row/index enters argv. */
  previewDestination(visit: symbol, attempt = this.snapshot.attempt) {
    if (this.snapshot.operation === "squash") {
      this.enqueue(visit, () => {
        if (this.snapshot.attempt !== attempt) return;
        if (this.squashDestinationReady()) this.apply(visit, attempt);
        else this.scheduleSquashPreview(true);
      });
      return;
    }
    this.enqueue(visit, () => {
      if (this.snapshot.phase !== "destination" || this.snapshot.attempt !== attempt) return;
      const commit = this.controller.getSelectedRow()?.commit ?? null;
      const reason = this.destinationRefusal(commit);
      if (reason) {
        this.publish({ reason });
        return;
      }
      const source = this.snapshot.sources[0]!;
      const common = {
        sources: [toHistoryMutationRevisionRef(source)] as const,
        destination: toHistoryMutationRevisionRef(commit!),
      };
      const request: ExtensionVcsMutationRequest =
        this.snapshot.operation === "squash"
          ? { kind: "squash", ...common }
          : { kind: "rebase", ...common, placement: this.snapshot.placement, skipEmptied: false };
      this.start(request);
    });
  }
  /** Start only this retained visit's request; the runtime owns freshness and command execution. */
  start(request: ExtensionVcsMutationRequest, options: HistoryMutationStartOptions = {}) {
    const visit = this.snapshot.visit;
    if (!visit || this.closed || this.ending || this.work || this.snapshot.suspended) return;
    if (this.undisposed.size) {
      this.publish({ reason: this.cleanupReason });
      return;
    }
    this.options = options;
    const attempt = this.snapshot.attempt + 1;
    const abort = new AbortController();
    this.abort = abort;
    this.show({
      phase: "preparing",
      request,
      prepared: null,
      attempt,
      reason: "",
      providerText: "",
      details: false,
      focus: 0,
      scroll: 0,
    });
    void this.track(async () => {
      try {
        const preparation = await this.runtime!.prepare(request, abort.signal);
        await this.acceptPreparation(visit, attempt, preparation);
      } catch (error) {
        if (this.isCurrent(visit, attempt)) this.reopen(String(error));
      }
    });
  }
  /** Dispose late preparations; a refreshed preview always requires another explicit Apply. */
  private async acceptPreparation(
    visit: symbol,
    attempt: number,
    preparation: ExtensionVcsMutationPreparation,
  ) {
    if (!this.isCurrent(visit, attempt)) {
      if (preparation.kind === "ready") await this.disposeHandle(preparation.prepared.handleId);
      return;
    }
    if (preparation.kind === "ready") {
      if (
        preparation.prepared.request.kind === "squash" &&
        preparation.prepared.request.destination.revisionId !==
          this.controller.getSelectedRow()?.commit.revisionId
      ) {
        await this.disposeHandle(preparation.prepared.handleId);
        this.show({ phase: "destination", prepared: null });
        this.squashCandidate = null;
        this.scheduleSquashPreview();
        return;
      }
      this.show({
        phase: preparation.prepared.request.kind === "squash" ? "destination" : "confirmation",
        prepared: preparation.prepared,
        request: preparation.prepared.request,
        details: false,
        focus: 0,
        scroll: 0,
      });
    } else
      this.reopen(
        preparation.kind === "refused"
          ? preparation.isWorkingCopyStale
            ? "The working copy is stale. Run jj workspace update-stale; it preserves unsaved edits in another visible version."
            : preparation.reason
          : "Preparation was cancelled. Preview again to continue.",
        preparation.kind === "refused" ? preparation.providerText : undefined,
      );
  }
  /** Reopen within the visit; replacing the slot does not clear selected sources. */
  private reopen(reason = "", providerText = "") {
    this.show({
      phase: "destination",
      prepared: null,
      reason,
      providerText,
      details: false,
      focus: 0,
      scroll: 0,
    });
    if (this.snapshot.request) this.options.reopen?.(this.snapshot.request);
  }
  /** Cancel a confirmation, retaining membership, destination and the invocation focus policy. */
  async cancelConfirmation(visit: symbol, attempt: number) {
    if (
      !this.isCurrent(visit, attempt) ||
      this.snapshot.phase !== "confirmation" ||
      !this.snapshot.prepared ||
      this.work
    )
      return;
    const prepared = this.snapshot.prepared;
    const nextAttempt = attempt + 1;
    this.show({ phase: "preparing", attempt: nextAttempt, prepared: null });
    await this.track(async () => {
      const disposed = await this.disposeHandle(prepared.handleId);
      if (this.isCurrent(visit, nextAttempt)) {
        this.reopen(disposed ? "" : this.cleanupReason);
        if (!disposed) this.publish({ refreshFailed: true });
      }
    });
  }
  /** Dispose and reprepare a changed toggle as one tracked provider settlement. */
  async toggleSkipEmptied(visit: symbol, attempt: number) {
    if (
      !this.isCurrent(visit, attempt) ||
      this.snapshot.phase !== "confirmation" ||
      !this.snapshot.prepared ||
      this.work
    )
      return;
    const prepared = this.snapshot.prepared;
    if (prepared.request.kind !== "rebase") return;
    const request = { ...prepared.request, skipEmptied: !prepared.request.skipEmptied };
    const nextAttempt = attempt + 1;
    const abort = new AbortController();
    this.abort = abort;
    this.show({ phase: "preparing", attempt: nextAttempt, prepared: null, request });
    await this.track(async () => {
      const disposed = await this.disposeHandle(prepared.handleId);
      if (!this.isCurrent(visit, nextAttempt)) return;
      if (!disposed) {
        this.reopen(this.cleanupReason);
        this.publish({ refreshFailed: true });
        return;
      }
      try {
        await this.acceptPreparation(
          visit,
          nextAttempt,
          await this.runtime!.prepare(request, abort.signal),
        );
      } catch (error) {
        if (this.isCurrent(visit, nextAttempt)) this.reopen(String(error));
      }
    });
  }
  /** Apply once, retain actual readback, and refresh only after the provider finishes. */
  apply(visit: symbol, attempt: number) {
    if (
      !this.isCurrent(visit, attempt) ||
      !(this.snapshot.phase === "confirmation" || this.squashDestinationReady()) ||
      !this.snapshot.prepared ||
      this.work
    )
      return;
    const prepared = this.snapshot.prepared!;
    const abort = new AbortController();
    this.abort = abort;
    this.show({ phase: "applying", prepared: null, details: false });
    void this.track(async () => {
      let disposed = false;
      try {
        const result = await this.runtime!.apply(prepared.handleId, abort.signal);
        this.lastResult = result;
        this.lastPrepared = prepared;
        this.publish({ result, prepared });
        this.visitRan = result.kind === "ran";
        if (this.snapshot.visit !== visit) return;
        if (result.kind === "not-run" && result.reason === "changed") {
          const nextAttempt = this.snapshot.attempt + 1;
          if (this.isCurrent(visit, attempt)) this.publish({ attempt: nextAttempt });
          await this.acceptPreparation(visit, nextAttempt, result.refreshed);
          if (this.isCurrent(visit, nextAttempt))
            this.publish({
              reason:
                this.snapshot.operation === "squash"
                  ? "History or files changed. Review the updated squash, then press Enter again."
                  : result.detail,
            });
          return;
        }
        if (result.kind === "not-run" && result.reason !== "start-failed") {
          if (!this.ending)
            this.reopen(
              result.reason === "stale-handle"
                ? "This preview is no longer valid. Preview again to continue."
                : "The command was cancelled before it ran. Preview again to continue.",
            );
          return;
        }
        this.pendingRemovedIds =
          this.snapshot.operation === "squash" &&
          result.kind === "ran" &&
          result.change.kind === "read"
            ? result.change.value.revisions
                .filter((change) => change.after.length === 0)
                .flatMap((change) => change.before.map((revision) => revision.revisionId))
            : [];
        const refreshed =
          result.kind === "ran"
            ? await this.controller.refreshAfterMutation(() => !this.closed, this.pendingRemovedIds)
            : true;
        if (refreshed) this.pendingRemovedIds = [];
        if (result.kind === "ran" && refreshed && result.verdict.selectAfter)
          this.highlight(result.verdict.selectAfter);
        // Cleanup is part of settlement: never offer ordinary browsing while it can still fail.
        const cleaned = await this.disposeHandle(prepared.handleId);
        disposed = true;
        this.finish(visit);
        if (!this.closed && !this.ending) {
          const notice = refreshed && cleaned ? cleanSquashResultNotice(result, prepared) : null;
          const update = {
            result,
            prepared,
            reason: cleaned ? "" : this.cleanupReason,
            refreshFailed: !refreshed || !cleaned,
            focus: 0,
            scroll: 0,
            details: false,
            fullResult: false,
            resultNotice: notice,
          };
          if (notice) this.publish({ ...update, phase: "idle", modal: null });
          else this.show({ ...update, phase: "result" });
        }
      } catch (error) {
        // No successful outcome can be invented after an unreadable provider settlement.
        this.finish(visit);
        if (!this.closed && !this.ending)
          this.show({
            phase: "result",
            prepared,
            reason: `The action's result could not be read: ${String(error)}`,
            refreshFailed: true,
            focus: 0,
            scroll: 0,
          });
      } finally {
        if (!disposed && !(await this.disposeHandle(prepared.handleId)) && !this.closed)
          this.publish({ reason: this.cleanupReason, refreshFailed: true });
      }
    });
  }
  /** Test the visit and generation before any callback changes active operation state. */
  private isCurrent(visit: symbol, attempt: number) {
    return (
      !this.closed &&
      !this.ending &&
      this.snapshot.visit === visit &&
      this.snapshot.attempt === attempt
    );
  }
  /** End membership once without changing the controller's review range or reading position. */
  private finish(visit: symbol) {
    if (this.snapshot.visit !== visit) return;
    this.sources.end(visit);
    this.publish({ visit: null, suspended: false });
  }
  /** Await abort/readback/disposal before returning to ordinary history or shutting down. */
  cancelVisit(visit: symbol, attempt?: number): Promise<void> {
    if (attempt !== undefined && this.snapshot.attempt !== attempt) return Promise.resolve();
    if (this.ending) return this.ending;
    if (this.snapshot.visit !== visit) return Promise.resolve();
    const prepared = this.snapshot.prepared;
    const work = this.work;
    let settle!: () => void;
    this.ending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const ending = this.ending;
    this.publish({ attempt: this.snapshot.attempt + 1, reason: "Cancelling action…" });
    this.abort?.abort();
    void (async () => {
      try {
        await work?.catch(() => undefined);
        await this.queue;
        if (prepared) await this.disposeHandle(prepared.handleId);
        await this.retryCleanup();
        this.finish(visit);
        if (!this.closed) {
          if (!this.visitRan && this.invocation) this.highlight(this.invocation);
          if (this.undisposed.size)
            this.show({
              phase: "result",
              prepared: null,
              reason: this.cleanupReason,
              refreshFailed: true,
              details: false,
            });
          else
            this.publish({
              phase: "idle",
              modal: null,
              prepared: null,
              reason: "",
              details: false,
            });
        }
      } finally {
        if (this.ending === ending) this.ending = null;
        settle();
      }
    })();
    return ending;
  }
  /** Shut down before history/runtime/session teardown, including inspection-owned routes. */
  async shutdown() {
    if (this.checkingTimer !== null) clearTimeout(this.checkingTimer);
    this.checkingTimer = null;
    const visit = this.snapshot.visit;
    this.closed = true;
    this.stopController();
    if (visit) await this.cancelVisit(visit);
    else await this.work?.catch(() => undefined);
    await this.retryCleanup();
  }
  /** Reopen the session's last actual result, even when no operation has run yet. */
  openResult() {
    if (this.closed) return;
    if (this.snapshot.visit || this.work || this.ending) {
      this.controller.setNotice("Finish the active action before opening its result.");
      return;
    }
    this.show({
      phase: "result",
      attempt: this.snapshot.attempt + 1,
      result: this.lastResult,
      prepared: this.lastPrepared,
      operation:
        this.lastPrepared?.request.kind === "squash"
          ? "squash"
          : this.lastPrepared?.request.kind === "rebase"
            ? "rebase"
            : null,
      reason: this.lastResult ? "" : "No operation has run in this Hunk session.",
      details: this.lastPrepared?.request.kind === "squash",
      fullResult: this.lastPrepared?.request.kind === "squash",
      focus: 0,
      scroll: 0,
    });
  }
  /** Dismiss only the notice generation that supplied this callback. */
  dismissResultNotice(attempt = this.snapshot.attempt) {
    if (!this.closed && this.snapshot.attempt === attempt && this.snapshot.resultNotice)
      this.publish({ resultNotice: null });
  }
  /** Close the result without erasing the saved actual outcome. */
  closeResult(attempt = this.snapshot.attempt) {
    if (this.snapshot.phase === "result" && this.snapshot.attempt === attempt)
      this.publish({ phase: "idle", modal: null, details: false, fullResult: false });
  }
  /** Retry a failed post-run refresh without replaying the mutation. */
  async retryRefresh(attempt = this.snapshot.attempt) {
    if (
      this.closed ||
      this.work ||
      this.snapshot.attempt !== attempt ||
      !this.snapshot.refreshFailed
    )
      return;
    await this.track(async () => {
      if (!(await this.retryCleanup())) {
        this.publish({ reason: this.cleanupReason, refreshFailed: true });
        return;
      }
      const refreshed = await this.controller.refreshAfterMutation(
        () => !this.closed && this.snapshot.attempt === attempt,
        this.pendingRemovedIds,
      );
      if (refreshed) this.pendingRemovedIds = [];
      this.publish({ reason: "", refreshFailed: !refreshed });
    });
  }
  /** Select only a loaded exact/logical revision under the existing controller policy. */
  highlight(commit: { revisionId: string; logicalId?: string }): boolean {
    if (this.controller.highlightLoadedRevision(commit.revisionId)) return true;
    this.controller.setNotice("The action's selected revision is outside this history view.");
    return false;
  }
  /** Preserve the shared target/arity refusal seam for callers using the current history. */
  resolveTargets(arity: "one" | "one-or-more") {
    const targets = this.controller.getOperationTargets();
    const selection = this.controller.getSelection();
    if (
      targets.kind !== "ready" ||
      (targets.source === "highlight" && (selection?.count ?? 0) > 1) ||
      (arity === "one" && targets.revisionIds.length !== 1)
    ) {
      this.controller.setNotice("Select the required revisions explicitly before this action.");
      return null;
    }
    const rows = this.controller.getSnapshot().rows;
    const commits = targets.revisionIds.map(
      (id) => rows.find((row) => row.commit.revisionId === id)?.commit,
    );
    if (commits.some((commit) => !commit || commit.isImmutable)) {
      this.controller.setNotice("A selected revision is unavailable or immutable.");
      return null;
    }
    return Object.freeze(commits as ExtensionVcsHistoryCommit[]);
  }
  /** Key a custom slot closer so an old picker cannot dismiss a later modal. */
  openModal(modal: HistoryMutationModal) {
    const visit = this.snapshot.visit;
    this.publish({ modal });
    return () => {
      if (this.snapshot.visit === visit && this.snapshot.modal === modal)
        this.publish({ modal: null });
    };
  }
  /** Change presentation-only focus/details/scroll without touching source membership. */
  updateView(
    update: Pick<Partial<HistoryOperationSnapshot>, "focus" | "details" | "scroll">,
    expected?: Pick<HistoryOperationSnapshot, "visit" | "attempt" | "phase">,
  ) {
    if (
      expected &&
      (expected.visit !== this.snapshot.visit ||
        expected.attempt !== this.snapshot.attempt ||
        expected.phase !== this.snapshot.phase)
    )
      return;
    if (
      update.details &&
      this.snapshot.operation === "squash" &&
      !squashErrorOutputAvailable(this.snapshot.result)
    )
      return;
    this.show(update);
  }
  /** Dispatch phase input; dock navigation passes through, modal input remains modal. */
  handleKey(key: KeyEvent, frame: HistoryMutationModalFrame): boolean {
    const s = this.snapshot;
    if (s.suspended) return true;
    if (key.ctrl && key.name === "c") {
      if (s.visit) void this.cancelVisit(s.visit);
      else this.closeResult();
      return true;
    }
    if (s.phase === "sources")
      return handleRevisionSourcePanelKey(key, this.sourceState(), this.sourceActions(frame));
    if (key.eventType === "release") return s.modal?.presentation === "overlay";
    const repeat = key.eventType === "repeat" || key.repeated;
    const plain = !key.ctrl && !key.meta && !key.option && !key.super && !key.hyper;
    if (
      s.operation === "squash" &&
      !s.details &&
      ["destination", "preparing", "result"].includes(s.phase) &&
      plain
    ) {
      const layout = squashDockLayout(this, frame);
      if (layout.overflow && ["pageup", "pagedown"].includes(key.name)) {
        this.updateView(
          {
            scroll: Math.min(
              layout.maxScroll,
              Math.max(0, layout.top + (key.name === "pageup" ? -1 : 1) * layout.bodyRows),
            ),
          },
          s,
        );
        return true;
      }
    }
    if (s.operation === "squash" && s.phase === "result" && !s.details) {
      if (!plain || repeat) return true;
      if (
        key.name === "o" &&
        squashErrorOutputAvailable(s.result) &&
        !squashDockLayout(this, frame).tooSmall
      )
        this.updateView({ details: true, scroll: 0 }, s);
      else if (key.name === "escape" || key.name === "enter" || key.name === "return")
        this.closeResult(s.attempt);
      else if (key.name === "r" && s.refreshFailed) void this.retryRefresh(s.attempt);
      return true;
    }
    if (s.phase === "destination" && !s.details) {
      if (!plain) return false;
      if (s.operation === "squash" && (key.name === "d" || key.name === "tab")) return true;
      const name =
        key.shift && key.name === "a"
          ? "A"
          : key.shift && key.name === "b"
            ? "B"
            : key.sequence === "A" || key.sequence === "B"
              ? key.sequence
              : key.name;
      if (["escape", "return", "enter", "o", "A", "B", "tab"].includes(name)) {
        if (repeat) return true;
        if (name === "escape") void this.cancelVisit(s.visit!);
        else if (name === "tab" && s.providerText)
          this.updateView({ focus: (s.focus + (key.shift ? 2 : 1)) % 3 });
        else if (name === "return" || name === "enter") {
          if (s.operation !== "squash" && s.focus === 2 && s.providerText)
            this.updateView({ details: true, scroll: 0 });
          else if (s.operation !== "squash" && s.focus === 1 && s.providerText)
            void this.cancelVisit(s.visit!);
          else if (s.operation !== "squash" || !squashDockTooSmall(frame))
            this.previewDestination(s.visit!, s.attempt);
        } else if (s.operation === "rebase")
          this.choosePlacement(
            s.visit!,
            name === "o" ? "onto" : name === "A" ? "after" : "before",
            s.attempt,
          );
        return true;
      }
      return false;
    }
    if (s.phase === "preparing" || s.phase === "applying") {
      if (
        s.operation === "squash" &&
        s.phase === "preparing" &&
        plain &&
        ["up", "down", "j", "k", "pageup", "pagedown", "home", "end"].includes(key.name)
      )
        return false;
      if (plain && key.name === "escape" && !repeat) void this.cancelVisit(s.visit!);
      return true;
    }
    if (s.phase === "confirmation" || s.phase === "result" || s.details) {
      if (!plain || repeat) return true;
      const tooSmall = historyOperationTooSmall(
        frame,
        s.prepared?.request.kind === "rebase",
        s.details,
      );
      if (tooSmall) {
        if (key.name === "escape" || key.name === "enter" || key.name === "return") {
          if (s.fullResult) this.closeResult(s.attempt);
          else if (s.details) this.updateView({ details: false, scroll: 0 });
          else if (s.visit) void this.cancelConfirmation(s.visit, s.attempt);
          else this.closeResult();
        }
        return true;
      }
      if (s.fullResult && key.name === "r" && s.refreshFailed) void this.retryRefresh(s.attempt);
      else if (key.name === "escape") {
        if (s.fullResult) this.closeResult(s.attempt);
        else if (s.details) this.updateView({ details: false, scroll: 0 });
        else if (s.visit) void this.cancelConfirmation(s.visit, s.attempt);
        else this.closeResult();
      } else if (key.name === "tab" && !s.details)
        this.updateView({
          focus:
            (s.focus +
              (key.shift ? -1 : 1) +
              (s.phase === "confirmation" ? 3 : s.refreshFailed ? 3 : 2)) %
            (s.phase === "confirmation" ? 3 : s.refreshFailed ? 3 : 2),
        });
      else if (key.name === "return" || key.name === "enter") {
        if (s.fullResult) this.closeResult(s.attempt);
        else if (s.details) this.updateView({ details: false, scroll: 0 });
        else if (s.focus === 0) {
          if (s.visit) void this.cancelConfirmation(s.visit, s.attempt);
          else this.closeResult();
        } else if (s.phase === "confirmation" && s.focus === 1) this.apply(s.visit!, s.attempt);
        else if (s.phase === "result" && s.focus === 2) void this.retryRefresh();
        else this.updateView({ details: true, scroll: 0 });
      } else if (key.name === "s" && !key.shift && s.phase === "confirmation")
        void this.toggleSkipEmptied(s.visit!, s.attempt);
      else if (["up", "down", "pageup", "pagedown", "home", "end"].includes(key.name)) {
        const layout = planHistoryOperationOverlay(this, frame);
        const delta =
          key.name === "up"
            ? -1
            : key.name === "down"
              ? 1
              : (key.name === "pageup" ? -1 : 1) * layout.bodyRows;
        this.updateView({
          scroll:
            key.name === "home"
              ? 0
              : key.name === "end"
                ? layout.maxScroll
                : Math.max(0, Math.min(layout.maxScroll, layout.top + delta)),
        });
      }
      return true;
    }
    return false;
  }
}
