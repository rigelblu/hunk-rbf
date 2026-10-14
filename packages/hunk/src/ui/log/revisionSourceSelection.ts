/**
 * Retain one operation's editable source phase over the history controller's marks.
 * The shared host supplies eligibility and a fresh visit identity, routes Space and mark clicks,
 * validates arity before locking, and ends the visit after cancellation or settled execution.
 * Destination choice and mutation execution stay with their owners. Slot replacement and
 * confirmation reopen do not end this adapter's visit; stale visit callbacks cannot clear it.
 */
import type { HistoryCommit } from "../../core/history/types";
import type { HistoryOperationTargets } from "../../core/history/revisionMarks";
import type { LogController } from "./controller";

/** Carry the shared host's source rule without deriving provider eligibility here. */
export type RevisionSourceEligibility = { eligible: true } | { eligible: false; reason: string };

/** Report a source edit without opening a second refusal or mutation flow. */
export type RevisionSourceEdit =
  | { kind: "changed" }
  | { kind: "inactive" }
  | { kind: "refused"; reason: string };

/** Coordinate editable membership and a submitted snapshot without another selection store. */
export class RevisionSourceSelection {
  private visit: symbol | null = null;
  private entering = false;
  private lockedTargets: HistoryOperationTargets | null = null;

  constructor(
    private readonly controller: LogController,
    private readonly eligibility: (commit: HistoryCommit) => RevisionSourceEligibility,
  ) {}

  /** Begin with one explicit source; the host must mint a fresh symbol for each operation. */
  begin(visit: symbol): RevisionSourceEdit {
    if (this.visit !== null)
      return { kind: "refused", reason: "Source selection is already active." };
    const snapshot = this.controller.getSnapshot();
    const commit = snapshot.rows[snapshot.selected]?.commit;
    if (!commit) return { kind: "refused", reason: "No revision is highlighted." };
    // Reserve the visit before calling the host, which may synchronously replace it.
    this.visit = visit;
    this.entering = true;
    this.lockedTargets = null;
    let eligibility: RevisionSourceEligibility;
    try {
      eligibility = this.eligibility(commit);
    } catch (error) {
      if (this.visit === visit) {
        this.visit = null;
        this.entering = false;
      }
      throw error;
    }
    if (this.visit !== visit) return { kind: "inactive" };
    if (!eligibility.eligible) {
      this.entering = false;
      this.visit = null;
      return { kind: "refused", reason: eligibility.reason };
    }
    // No host callback runs between leaving entry and publishing the seeded marks.
    this.entering = false;
    if (!this.controller.seedSourceSelection(commit.revisionId)) {
      if (this.visit === visit) this.visit = null;
      return { kind: "refused", reason: "Source selection is not ready." };
    }
    return this.visit === visit ? { kind: "changed" } : { kind: "inactive" };
  }

  /** Toggle the live highlight for Space, or a clicked row, without changing focus. */
  toggle(visit: symbol, index = this.controller.getSnapshot().selected): RevisionSourceEdit {
    if (this.visit !== visit || this.entering || this.lockedTargets !== null)
      return { kind: "inactive" };
    const commit = this.controller.getSnapshot().rows[index]?.commit;
    if (!commit) return { kind: "refused", reason: "This revision is not in view." };
    const marked = this.controller
      .getSnapshot()
      .marks.some((entry) => entry.kind === "resolved" && entry.revisionId === commit.revisionId);
    // Removing intent remains possible even if the source's eligibility changed meanwhile.
    if (!marked) {
      const eligibility = this.eligibility(commit);
      if (this.visit !== visit || this.lockedTargets !== null) return { kind: "inactive" };
      if (!eligibility.eligible) return { kind: "refused", reason: eligibility.reason };
    }
    if (this.controller.getSnapshot().rows[index]?.commit.revisionId !== commit.revisionId)
      return { kind: "refused", reason: "This revision is not in view." };
    return this.controller.toggleMark(index)
      ? { kind: "changed" }
      : { kind: "refused", reason: "Source selection is not ready." };
  }

  /** Read only explicit membership; clearing the final source never selects the highlight. */
  targets(visit: symbol): HistoryOperationTargets {
    if (this.visit !== visit || this.entering) return Object.freeze({ kind: "empty" });
    return (
      this.lockedTargets ?? this.controller.getOperationTargets({ allowHighlightedFallback: false })
    );
  }

  /** Freeze sources after the shared host accepts its arity and eligibility checks. */
  lock(visit: symbol): HistoryOperationTargets {
    const targets = this.targets(visit);
    if (this.visit === visit && targets.kind === "ready") this.lockedTargets = targets;
    return targets;
  }

  /** Draw a selected-source checkmark through destination choice and confirmation reopen. */
  indicator(revisionId: string): "✓" | " " {
    if (this.visit === null || this.entering) return " ";
    const targets = this.lockedTargets;
    if (targets?.kind === "ready") return targets.revisionIds.includes(revisionId) ? "✓" : " ";
    return this.controller
      .getSnapshot()
      .marks.some((entry) => entry.kind === "resolved" && entry.revisionId === revisionId)
      ? "✓"
      : " ";
  }

  /** End only this visit; the host retains focus restoration and post-mutation policies. */
  end(visit: symbol): boolean {
    if (this.visit !== visit) return false;
    this.visit = null;
    this.entering = false;
    this.lockedTargets = null;
    this.controller.clearRevisionMarks();
    return true;
  }
}
