import type { HistoryCommit } from "../../core/history/types";
import { sanitizeTerminalLine } from "../../lib/terminalText";
import { fitText } from "../lib/text";

const emptyMarker = "(empty)";
const descriptionPlaceholder = "(no description set)";

export type HistoryTitleRole = "empty" | "undescribed" | "text";
export interface HistoryTitleSpan {
  text: string;
  role: HistoryTitleRole;
}

/** Split an already fitted title into surviving label spans without changing its text or width. */
export function splitHistoryTitle(
  commit: Pick<HistoryCommit, "subject" | "isEmpty">,
  title: string,
): HistoryTitleSpan[] {
  const spans: HistoryTitleSpan[] = [];
  let offset = 0;
  if (commit.isEmpty === true) {
    const length = Math.min(emptyMarker.length, title.length);
    spans.push({ text: title.slice(0, length), role: "empty" });
    offset = length;
    if (title[offset] === " ") {
      spans.push({ text: " ", role: "text" });
      offset += 1;
    }
  }
  if (commit.subject === descriptionPlaceholder && offset < title.length) {
    const length = Math.min(descriptionPlaceholder.length, title.length - offset);
    spans.push({ text: title.slice(offset, offset + length), role: "undescribed" });
    offset += length;
  }
  if (offset < title.length) spans.push({ text: title.slice(offset), role: "text" });
  return spans;
}

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
