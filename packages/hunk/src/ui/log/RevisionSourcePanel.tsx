/**
 * Show editable operation sources beside the retained history list.
 * Space, source-cell clicks and the docked legend share host callbacks; the host settles
 * navigation, validates sources and replaces ordinary history hints before routing input.
 * Destination choice and execution stay with the shared host. It removes this panel when
 * sources lock, but retains the selected indicators through confirmation reopen.
 */
import { MouseButton, type KeyEvent, type MouseEvent as TuiMouseEvent } from "@opentui/core";
import type { HistoryOperationTargets } from "../../core/history/revisionMarks";
import { DialogActionRow, type ConfirmDialogAction } from "../components/chrome/ConfirmDialog";
import { fitText, measureTextWidth, wrapText } from "../lib/text";
import type { AppTheme } from "../themes";

/** Project the controller's membership and the host's separate progression refusal. */
export interface RevisionSourcePanelState {
  targets: HistoryOperationTargets;
  /** Count all retained intent, including unresolved marks. */
  selectedCount: number;
  /** Keep eligibility and arity judgments with the operation host. */
  continueRefusal?: string;
}

/** Share actions between mouse and source-phase keys without a global listener. */
export interface RevisionSourcePanelActions {
  toggle: () => void;
  continue: () => void;
  cancel: () => void;
  reviewMarks?: () => void;
}

/** Describe exactly the rows the host must reserve for this docked panel. */
export interface RevisionSourcePanelLayout {
  title: string;
  status: readonly string[];
  actionRows: ConfirmDialogAction[][];
  rows: number;
}

/** Allow edits only when the controller has completed its identity check. */
function canToggleSources(state: RevisionSourcePanelState) {
  return state.targets.kind !== "blocked" || state.targets.reason === "unresolved";
}

/** Require explicit ready sources and preserve the host's eligibility/arity veto. */
function canContinueSources(state: RevisionSourcePanelState) {
  return (
    state.targets.kind === "ready" &&
    state.targets.source === "marks" &&
    state.targets.revisionIds.length > 0 &&
    state.continueRefusal === undefined
  );
}

/** Offer the existing recovery overlay only when the host supplies its route. */
function canReviewSources(state: RevisionSourcePanelState, actions: RevisionSourcePanelActions) {
  return (
    state.targets.kind === "blocked" &&
    state.targets.reason !== "checking" &&
    actions.reviewMarks !== undefined
  );
}

/** Route only plain source-phase keys; the host still owns navigation and overlay priority. */
export function handleRevisionSourcePanelKey(
  key: KeyEvent,
  state: RevisionSourcePanelState,
  actions: RevisionSourcePanelActions,
): boolean {
  if (
    key.eventType === "release" ||
    key.ctrl ||
    key.meta ||
    key.option ||
    key.shift ||
    key.super ||
    key.hyper
  )
    return false;
  // A held source key must not repeatedly change membership or progress a phase.
  if (key.eventType === "repeat" || key.repeated) {
    return (
      ["space", "return", "enter", "escape"].includes(key.name) ||
      (key.name === "r" && canReviewSources(state, actions))
    );
  }
  if (key.name === "space") {
    if (canToggleSources(state)) actions.toggle();
    return true;
  }
  if (key.name === "return" || key.name === "enter") {
    if (canContinueSources(state)) actions.continue();
    return true;
  }
  if (key.name === "escape") {
    actions.cancel();
    return true;
  }
  if (key.name === "r" && canReviewSources(state, actions)) {
    actions.reviewMarks?.();
    return true;
  }
  return false;
}

/** Measure each shared legend action including its two padding cells. */
function sourceActionWidth(action: ConfirmDialogAction) {
  return measureTextWidth(`${action.keyLabel} ${action.label}`) + 2;
}

/** Prepare compact source copy and reflow shared action rows within the host's width. */
export function revisionSourcePanelLayout({
  operationLabel,
  width,
  state,
  actions,
}: {
  operationLabel: "rebase" | "squash";
  width: number;
  state: RevisionSourcePanelState;
  actions: RevisionSourcePanelActions;
}): RevisionSourcePanelLayout {
  const contentWidth = Math.max(1, Math.floor(width) - 2);
  const count = `${state.selectedCount} selected`;
  let message = "";
  if (state.targets.kind === "empty") message = "Select at least one revision to continue.";
  else if (state.targets.kind === "blocked") {
    switch (state.targets.reason) {
      case "checking":
        message = "Checking marked revisions…";
        break;
      case "unresolved":
        message = "Resolve your marks before changing revisions.";
        break;
      case "refresh-failed":
        message =
          width < 60
            ? "Refresh history or cancel."
            : "Marks could not be checked. Refresh history or clear selection.";
        break;
    }
  } else message = state.continueRefusal ?? "";
  const wrapped = wrapText(message ? `${count} · ${message}` : count, contentWidth);
  const status =
    wrapped.length <= 2
      ? wrapped
      : [wrapped[0]!, fitText(`${wrapped.slice(1).join(" ")}…`, contentWidth, "…")];
  const available: ConfirmDialogAction[] = [];
  if (canToggleSources(state))
    available.push({ keyLabel: "Space", label: "Select/unselect", run: actions.toggle });
  if (canContinueSources(state))
    available.push({ keyLabel: "Enter", label: "Continue", run: actions.continue });
  if (canReviewSources(state, actions))
    available.push({ keyLabel: "R", label: "Review marks", run: () => actions.reviewMarks?.() });
  available.push({ keyLabel: "Esc", label: "Cancel", run: actions.cancel });
  const actionRows: ConfirmDialogAction[][] = [];
  let used = 0;
  for (const action of available) {
    // Shared rows add three separator cells; fit a lone action at very small widths.
    const keyLabel = fitText(action.keyLabel, Math.max(1, contentWidth - 2));
    const fitted = {
      ...action,
      keyLabel,
      label: fitText(action.label, Math.max(0, contentWidth - measureTextWidth(keyLabel) - 3), "…"),
    };
    const cells = sourceActionWidth(fitted);
    if (!actionRows.length || used + 3 + cells > contentWidth) {
      actionRows.push([fitted]);
      used = cells;
    } else {
      actionRows[actionRows.length - 1]!.push(fitted);
      used += 3 + cells;
    }
  }
  return {
    title: fitText(`Choose ${operationLabel} sources`, contentWidth, "…"),
    status,
    actionRows,
    rows: 1 + status.length + actionRows.length,
  };
}

/** Render the prepared dock; production mounting and live action validation stay with the host. */
export function RevisionSourcePanel({
  operationLabel,
  width,
  state,
  actions,
  theme,
}: {
  operationLabel: "rebase" | "squash";
  width: number;
  state: RevisionSourcePanelState;
  actions: RevisionSourcePanelActions;
  theme: AppTheme;
}) {
  const layout = revisionSourcePanelLayout({ operationLabel, width, state, actions });
  return (
    <box
      style={{
        width,
        height: layout.rows,
        flexDirection: "column",
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: theme.panel,
      }}
    >
      <text style={{ height: 1 }} fg={theme.text}>
        {layout.title}
      </text>
      {layout.status.map((line, index) => (
        <text key={index} style={{ height: 1 }} fg={theme.muted}>
          {line}
        </text>
      ))}
      {layout.actionRows.map((row, index) => (
        <DialogActionRow key={index} actions={row} theme={theme} primaryMouseOnly />
      ))}
    </box>
  );
}

/** Draw membership in the existing four-cell mark slot without moving history focus. */
export function RevisionSourceMark({
  selected,
  editable,
  height = 1,
  onToggle,
  theme,
}: {
  selected: boolean;
  editable: boolean;
  height?: number;
  onToggle: () => void;
  theme: AppTheme;
}) {
  return (
    <box
      style={{ width: 4, height, flexShrink: 0 }}
      onMouseUp={(event: TuiMouseEvent) => {
        event.stopPropagation();
        if (editable && event.button === MouseButton.LEFT) onToggle();
      }}
    >
      <text style={{ height: 1 }} fg={theme.accent}>
        {selected ? "✓   " : "    "}
      </text>
    </box>
  );
}
