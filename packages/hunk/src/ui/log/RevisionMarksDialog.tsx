import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import type { RevisionMarkResolution, RevisionMarkStatus } from "../../core/history/revisionMarks";
import { sanitizeTerminalLine } from "../../lib/terminalText";
import { ConfirmDialog, confirmDialogHeight } from "../components/chrome/ConfirmDialog";
import { RevisionIdControl } from "../components/RevisionIdControl";
import { fitText, wrapText } from "../lib/text";
import type { AppTheme } from "../themes";

/** Focus recovery on unresolved intent; otherwise let the user inspect every retained mark. */
export function revisionMarksEntries(marks: readonly RevisionMarkResolution[]) {
  const unresolved = marks.filter((entry) => entry.kind === "unresolved");
  return unresolved.length ? unresolved : marks;
}

/** Keep the keyboard page step and the rendered recovery window identical. */
export function revisionMarksVisibleCount(terminalHeight: number, count: number) {
  return Math.max(
    1,
    Math.min(
      count,
      Math.floor(
        (terminalHeight - 9 - (terminalHeight >= 14 ? 3 : terminalHeight >= 12 ? 1 : 0)) / 2,
      ),
    ),
  );
}

/** Review retained identities and remove unresolved intent only on an explicit action. */
export function RevisionMarksDialog({
  marks,
  selectedIndex,
  terminalHeight,
  terminalWidth,
  theme,
  notice,
  status,
  onClose,
  onSelect,
  onCopy,
  onRemove,
}: {
  marks: readonly RevisionMarkResolution[];
  selectedIndex: number;
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
  notice: string;
  status: RevisionMarkStatus;
  onClose: () => void;
  onSelect: (index: number) => void;
  onCopy: (revisionId: string) => void;
  onRemove: () => void;
}) {
  const entries = revisionMarksEntries(marks);
  const unresolved = marks.some((entry) => entry.kind === "unresolved");
  const width = Math.max(1, Math.min(70, terminalWidth - 2));
  const bodyWidth = Math.max(1, width - 4);
  const availableRows = Math.max(0, terminalHeight - 2 - confirmDialogHeight(0));
  const noticeLines = notice ? wrapText(notice, bodyWidth) : [];
  const showHeader = availableRows >= 5 + noticeLines.length;
  const showNotice = noticeLines.length > 0 && availableRows >= noticeLines.length + 1;
  const showCounter = showHeader || (!showNotice && availableRows >= 3);
  const fixedRows =
    (showHeader ? 2 : 0) + (showCounter ? 1 : 0) + (showNotice ? noticeLines.length : 0);
  const entryHeight = availableRows - fixedRows >= 2 ? 2 : 1;
  const count = Math.max(
    1,
    Math.min(entries.length, Math.floor((availableRows - fixedRows) / entryHeight)),
  );
  const focus = Math.max(0, Math.min(entries.length - 1, selectedIndex));
  const start = Math.max(0, Math.min(entries.length - count, focus - Math.floor(count / 2)));
  const height = Math.max(
    1,
    Math.min(confirmDialogHeight(fixedRows + count * entryHeight), terminalHeight - 2),
  );
  const message =
    status === "checking"
      ? "Checking marked revisions…"
      : status === "refresh-failed"
        ? "Marks could not be checked. Refresh history or clear selection."
        : unresolved
          ? "These marks could not be matched to history."
          : "Marked revisions in this history.";
  const actions = [
    ...(unresolved && status !== "checking"
      ? [{ keyLabel: "r", label: "Remove unresolved marks", run: onRemove }]
      : []),
    ...(!unresolved || width >= 60 ? [{ keyLabel: "Esc", label: "Close", run: onClose }] : []),
  ];
  return (
    <ConfirmDialog
      title="Review marks"
      width={width}
      height={height}
      terminalWidth={terminalWidth}
      terminalHeight={terminalHeight}
      theme={theme}
      onClose={onClose}
      actions={actions}
    >
      {showHeader ? (
        <text style={{ height: 1, flexShrink: 0 }} fg={theme.muted}>
          {fitText(sanitizeTerminalLine(message), bodyWidth)}
        </text>
      ) : null}
      {showCounter ? (
        <text style={{ height: 1, flexShrink: 0 }} fg={theme.muted}>
          {entries.length
            ? `${start + 1}–${Math.min(start + count, entries.length)} of ${entries.length}`
            : "No marks"}
        </text>
      ) : null}
      {entries.slice(start, start + count).map((entry, offset) => {
        const index = start + offset;
        const selected = index === focus;
        const reason =
          entry.kind === "resolved"
            ? "Marked"
            : entry.reason === "incomplete"
              ? "Incomplete history"
              : entry.reason === "ambiguous"
                ? "Ambiguous"
                : "Missing";
        return (
          <box
            key={entry.mark.revisionId}
            style={{
              width: "100%",
              height: entryHeight,
              flexShrink: 0,
              flexDirection: "column",
              backgroundColor: selected ? theme.accentMuted : theme.panel,
            }}
            onMouseUp={(event: TuiMouseEvent) => {
              event.stopPropagation();
              onSelect(index);
            }}
          >
            <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
              <text style={{ height: 1, flexShrink: 0 }} fg={theme.accent}>
                {selected ? "> " : "  "}
              </text>
              <RevisionIdControl
                displayRevision={fitText(
                  sanitizeTerminalLine(entry.mark.revisionId),
                  Math.max(1, bodyWidth - 25),
                )}
                revisionColor={theme.accent}
                copyColor={theme.muted}
                onCopy={() => onCopy(entry.mark.revisionId)}
              />
              <text style={{ height: 1, flexShrink: 0 }} fg={theme.muted}>{`  ${reason}`}</text>
            </box>
            {entryHeight === 2 ? (
              <text style={{ height: 1, flexShrink: 0 }} fg={theme.text}>
                {fitText(`  ${sanitizeTerminalLine(entry.mark.subject)}`, bodyWidth)}
              </text>
            ) : null}
          </box>
        );
      })}
      {showHeader ? (
        <text style={{ height: 1, flexShrink: 0 }} fg={theme.muted}>
          {fitText("y Copy revision ID", bodyWidth)}
        </text>
      ) : null}
      {showNotice
        ? noticeLines.map((line, index) => (
            <text key={index} style={{ height: 1, flexShrink: 0 }} fg={theme.muted}>
              {line}
            </text>
          ))
        : null}
    </ConfirmDialog>
  );
}
