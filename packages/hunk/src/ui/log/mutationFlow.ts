/**
 * Declares the one flow every history mutation command calls.
 *
 * A command resolves its targets, optionally opens its own picker or mode in
 * the flow's modal slot, then starts a request. The flow owns everything after
 * that: prepare, confirmation, Apply, refresh and result. A feature supplies
 * words and a modal, never a dialog of its own in `LogApp`.
 */
import type { KeyEvent } from "@opentui/core";
import type { ReactNode } from "react";
import type {
  ExtensionVcsHistoryCommit,
  ExtensionVcsMutationRequest,
  ExtensionVcsMutationRevisionRef,
} from "../../extension-api/types";
import type { AppTheme } from "../themes";

/** How many revisions a kind takes from the shared target rule. */
export type HistoryMutationArity = "one" | "one-or-more";

/** A choice on the confirmation that changes the request. The flow prepares again and shows the new preview. */
export interface HistoryMutationToggle {
  id: string;
  /** The text the user reads, for example "Skip revisions emptied by this move". */
  label: string;
  /** The few words the action row shows beside the key and the state, for example "skip emptied". */
  shortLabel: string;
  /** The key that flips it while the confirmation is open. */
  key: string;
  isOn(request: ExtensionVcsMutationRequest): boolean;
  apply(request: ExtensionVcsMutationRequest, on: boolean): ExtensionVcsMutationRequest;
}

export interface HistoryMutationStartOptions {
  /** Called with the request that was cancelled or refused, so your picker or mode can reopen where it was. */
  reopen?: (previous: ExtensionVcsMutationRequest) => void;
  toggles?: readonly HistoryMutationToggle[];
}

/** What the flow hands a modal each time it renders, so it follows a live appearance change. */
export interface HistoryMutationModalFrame {
  /** Reserve the mounted query/task rows before budgeting lower messages and focused history. */
  historyHeaderRows?: number;
  theme: AppTheme;
  terminalWidth: number;
  terminalHeight: number;
  /** The history's highlighted row. In a docked mode it is the candidate. */
  highlighted: ExtensionVcsHistoryCommit | null;
  /** Borrow the highlighted singleton review while retaining this source visit. */
  inspectHighlighted?: () => void;
  /** Open the existing unresolved-mark recovery overlay. */
  reviewMarks?: () => void;
}

/** What a docked mode draws on one history row while it is open. */
export interface HistoryMutationRowMark {
  /** Short tags drawn on the row, for example "source" or "destination". */
  tags: readonly string[];
  /** Draw the row muted, for a row the mode will not accept. */
  muted?: boolean;
}

/** A dialog or a mode of yours, mounted in the flow's one slot. */
export interface HistoryMutationModal {
  /**
   * overlay: a dialog over the list that takes every key.
   * docked: a panel under the list. The list stays visible and live, and the flow's navigation keys keep working.
   */
  presentation: "overlay" | "docked";
  render(frame: HistoryMutationModalFrame): ReactNode;
  /** Docked only: how many terminal rows your panel takes. The flow takes them from the bottom of the list. */
  rows?(frame: HistoryMutationModalFrame): number;
  /** Docked only: the sentence that replaces the view's status line while the mode is open. */
  statusLine?(frame: HistoryMutationModalFrame): string;
  /** Docked only: the mark for one visible row, or null. Called for visible rows on every render, so keep it cheap and pure. */
  rowMark?(
    commit: ExtensionVcsHistoryCommit,
    frame: HistoryMutationModalFrame,
  ): HistoryMutationRowMark | null;
  /**
   * Every key except Ctrl+C, which the flow handles itself. Return true when you took the key.
   * `frame` is built at the moment of the key: `highlighted` is read from the controller then, not from the last render.
   */
  handleKey(key: KeyEvent, frame: HistoryMutationModalFrame): boolean;
}

export interface HistoryMutationFlow {
  /** Applies the target rule, the arity and the immutable-row check. Shows the refusal dialog and returns null when refused. */
  resolveTargets(arity: HistoryMutationArity): readonly ExtensionVcsHistoryCommit[] | null;
  /** Runs prepare, confirmation, Apply, refresh and result for one request. */
  start(request: ExtensionVcsMutationRequest, options?: HistoryMutationStartOptions): void;
  /** Mounts your picker or mode in the flow's one modal slot. Returns the function that closes it without a choice. */
  openModal(modal: HistoryMutationModal): () => void;
  /** Moves the history's highlight to this revision when it is a loaded row. Returns false when it is not loaded. */
  highlight(commit: ExtensionVcsHistoryCommit): boolean;
}

/** Builds the references a request names its history rows by, keeping the list non-empty for the request's type. */
export function toHistoryMutationRevisionRefs(
  commits: readonly [ExtensionVcsHistoryCommit, ...ExtensionVcsHistoryCommit[]],
): [ExtensionVcsMutationRevisionRef, ...ExtensionVcsMutationRevisionRef[]] {
  const [first, ...rest] = commits;
  return [toHistoryMutationRevisionRef(first), ...rest.map(toHistoryMutationRevisionRef)];
}

/** Builds the reference a request names a history row by. */
export function toHistoryMutationRevisionRef(
  commit: ExtensionVcsHistoryCommit,
): ExtensionVcsMutationRevisionRef {
  return { revisionId: commit.revisionId, logicalId: commit.logicalId };
}
