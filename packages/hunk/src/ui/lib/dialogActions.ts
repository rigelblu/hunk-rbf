/** Fit shared dialog legends to their available terminal cells and wrap reachable actions. */
import { fitText, measureTextWidth } from "./text";

/** Describe one clickable dialog choice; its caller owns keyboard routing. */
export interface ConfirmDialogAction {
  keyLabel: string;
  id?: string;
  focused?: boolean;
  label: string;
  run: () => void;
}
/** Include the shared legend's two padding cells and three-cell separators in every row. */
export function layoutDialogActionRows(
  actions: readonly ConfirmDialogAction[],
  width: number,
  padding = 1,
): ConfirmDialogAction[][] {
  const rows: ConfirmDialogAction[][] = [];
  let used = 0;
  for (const action of actions) {
    const keyLabel = fitText(action.keyLabel, Math.max(0, width - 1 - 2 * padding));
    const fitted = {
      ...action,
      keyLabel,
      label: fitText(
        action.label,
        Math.max(0, width - measureTextWidth(keyLabel) - 1 - 2 * padding),
        "…",
      ),
    };
    const cells = measureTextWidth(`${fitted.keyLabel} ${fitted.label}`) + 2 * padding;
    if (!rows.length || used + 3 + cells > width) {
      rows.push([fitted]);
      used = cells;
    } else {
      rows[rows.length - 1]!.push(fitted);
      used += 3 + cells;
    }
  }
  return rows;
}
