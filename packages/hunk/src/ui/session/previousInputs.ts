import type { LogQueryRequest, LogQueryResult } from "../log/controller";

/** Most expressions one session remembers. */
export const PREVIOUS_INPUTS_LIMIT = 50;

/**
 * Remembers the custom revsets this session applied, so the editor can offer them again.
 *
 * `HunkSessionHost` owns one list for the whole session: it survives opening a diff from history
 * and returning, and it dies with the session. Nothing is written to disk. The list is never
 * filtered, and it holds only expressions a provider accepted: a failed, aborted or obsolete
 * Apply, and every Reset, leave it alone.
 */
export class PreviousInputs {
  private entries: string[] = [];

  /** The remembered expressions, most recently applied first. */
  list(): readonly string[] {
    return Object.freeze([...this.entries]);
  }

  /** Remember one expression at the front; applying it again moves it, never duplicates it. */
  record(expression: string) {
    const text = expression.trim();
    if (!text) return;
    this.entries = [text, ...this.entries.filter((entry) => entry !== text)].slice(
      0,
      PREVIOUS_INPUTS_LIMIT,
    );
  }

  /** Remember the expression of an Apply that a provider accepted, and nothing else. */
  recordOutcome(request: LogQueryRequest, result: LogQueryResult) {
    if (request.kind === "apply" && result.status === "applied") this.record(request.expression);
  }
}
