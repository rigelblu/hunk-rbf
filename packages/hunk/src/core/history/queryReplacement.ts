import type { HistoryExpressionInput } from "../run/commandInputs";
import type { VcsHistorySource } from "../vcs/types";

/** What a query replacement runs: the launch input again, or one custom expression. */
export type HistoryQueryTarget = { kind: "launch" } | HistoryExpressionInput;

/**
 * Replaces the query a history session runs. A session carries it only when the selected provider
 * accepts expression input, so its absence means the revset editor is unavailable.
 */
export interface HistoryQueryReplacement {
  /** Open a candidate source for `target` without changing what refresh and watch use. */
  open(target: HistoryQueryTarget, signal?: AbortSignal): Promise<VcsHistorySource>;
  /**
   * Make `source` and its query the ones refresh and watch use, and close the previous source.
   * Everything the session reads for the accepted query changes before the first await.
   */
  accept(target: HistoryQueryTarget, source: VcsHistorySource): Promise<void>;
}
