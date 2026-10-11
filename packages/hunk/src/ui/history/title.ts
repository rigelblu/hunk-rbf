import type { HistoryCommit } from "../../core/history/types";
import { sanitizeTerminalLine } from "../../lib/terminalText";
import { fitText } from "../lib/text";

const emptyMarker = "(empty)";

/** Fit a display title while preserving a complete known-empty marker whenever seven cells fit. */
export function formatHistoryTitle(
  commit: Pick<HistoryCommit, "subject" | "isEmpty">,
  width?: number,
  overflowMarker = ".",
) {
  const subject = sanitizeTerminalLine(commit.subject).replaceAll("\t", " ");
  const title = commit.isEmpty === true ? `${emptyMarker} ${subject}` : subject;
  if (width === undefined) return title;
  if (commit.isEmpty !== true || width < emptyMarker.length) {
    return fitText(title, width, overflowMarker);
  }
  if (width <= emptyMarker.length + 1) return emptyMarker;
  return `${emptyMarker} ${fitText(subject, width - emptyMarker.length - 1, overflowMarker)}`;
}
