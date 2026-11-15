/** Plan ordinary-history selection copy and clickable actions with effective key bindings. */
import type { LogSnapshot } from "./controller";
import type { HistoryCommandId } from "./commands";
import { formatKeyChord } from "../lib/keymap";
import type { ConfirmDialogAction } from "../components/chrome/ConfirmDialog";
import { layoutDialogActionRows } from "../lib/dialogActions";
import { measureTextWidth, wrapText } from "../lib/text";

/** Reflow oversized history actions without dropping their effective chord or label. */
function historyFooterActionRows(actions: ConfirmDialogAction[], width: number) {
  const rows: ConfirmDialogAction[][] = [];
  let pending: ConfirmDialogAction[] = [];
  const flush = () => {
    rows.push(...layoutDialogActionRows(pending, width, 0));
    pending = [];
  };
  for (const action of actions) {
    if (measureTextWidth(`${action.keyLabel} ${action.label}`) <= width) {
      pending.push(action);
    } else {
      flush();
      rows.push(
        ...wrapText(action.keyLabel, Math.max(1, width - 1)).map((keyLabel) => [
          { ...action, keyLabel, label: "" },
        ]),
      );
      rows.push(
        ...wrapText(action.label, Math.max(1, width - 1)).map((label) => [
          { ...action, keyLabel: "", label },
        ]),
      );
    }
  }
  flush();
  return rows;
}

/** Reflow required selection controls before optional repeated navigation hints. */
export function planHistorySelectionFooter(
  snapshot: LogSnapshot,
  width: number,
  keys: ReadonlyMap<string, readonly string[]>,
  run: (id: HistoryCommandId) => unknown,
  openMenu: () => void,
  reviewUnresolved: () => void,
  reviewRangeCount: number | null = null,
  context?: { provider: string; editableQuery: boolean },
) {
  const selected = snapshot.marks.some(
    (mark) =>
      mark.kind === "resolved" &&
      mark.revisionId === snapshot.rows[snapshot.selected]?.commit.revisionId,
  );
  const unresolved = snapshot.marks.filter((mark) => mark.kind === "unresolved").length;
  const blocked =
    snapshot.markStatus !== "ready" || unresolved > 0 || Boolean(snapshot.pendingMarkEdits);
  const actions: ConfirmDialogAction[] = [];
  const add = (id: HistoryCommandId, label: string) => {
    const key = keys.get(id)?.[0];
    if (key)
      actions.push({
        id,
        keyLabel: formatKeyChord(key),
        label,
        run: () => {
          run(id);
        },
      });
  };
  if (!blocked)
    add(
      "hunk.history.toggleRevisionSelection",
      `${selected ? "Unselect" : "Select"}${width < 42 ? " revision" : ""}`,
    );
  if (snapshot.marks.length || snapshot.pendingMarkEdits)
    add("hunk.history.clearRevisionSelection", "Clear selected revisions");
  if (unresolved)
    actions.push({
      id: "unresolved",
      keyLabel: "r",
      label: "Review unresolved",
      run: reviewUnresolved,
    });
  if (width >= 42 && !blocked) {
    add("hunk.history.squash", "Squash");
    add("hunk.history.openSelection", "Open");
  }
  actions.push({ id: "menu", keyLabel: "F10", label: "Menu", run: openMenu });
  const selectionStatus = snapshot.pendingMarkEdits
    ? `${snapshot.marks.length} selected · checking`
    : !snapshot.marks.length
      ? "No explicit selection"
      : `${snapshot.marks.length} selected${snapshot.markStatus === "checking" ? " · checking" : snapshot.markStatus === "refresh-failed" ? " · refresh failed" : unresolved ? ` · ${unresolved} unresolved` : ""}`;
  const fixedStatus =
    selectionStatus + (reviewRangeCount === null ? "" : ` · Review range: ${reviewRangeCount}`);
  const queryKey = context?.editableQuery ? keys.get("hunk.history.editRevset")?.[0] : undefined;
  const rangeKey = keys.get("hunk.history.startVisualSelection")?.[0];
  const contextHint =
    width >= 80
      ? [
          ...(queryKey ? [`${formatKeyChord(queryKey)} edit revset`] : []),
          ...(rangeKey ? [`${formatKeyChord(rangeKey)} Review range`] : []),
        ]
          .map((hint) => ` · ${hint}`)
          .join("")
      : "";
  const status =
    (width >= 60 && context
      ? `${context.provider} · ${snapshot.rows.length}${snapshot.historyDone ? " commits" : "+ commits"} · `
      : "") +
    fixedStatus +
    contextHint;
  return {
    status,
    actionRows: historyFooterActionRows(actions, Math.max(1, width - 2)),
  };
}
