import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import { useEffect, type MutableRefObject } from "react";
import { ModalFrame } from "../components/chrome/ModalFrame";
import { fitText, wrapText } from "../lib/text";
import type { AppTheme } from "../themes";
import {
  REVSET_DRAFT_MAX_UNITS,
  REVSET_EDITOR_TITLE,
  REVSET_FIELD_PREFIX,
  TOO_SMALL_MESSAGE,
  type EditorActionId,
  type EditorLayout,
  type EditorRow,
  type RevsetEditorState,
} from "./revsetEditor";

/**
 * The field's renderable surface that the log surface drives. It writes the field's own buffer
 * the moment the draft changes elsewhere, so the next key in the same chunk edits the new text.
 */
export interface FieldHandle {
  value: string;
  focus: () => void;
  blur: () => void;
  gotoBufferEnd: () => void;
}

/**
 * Draw the revset editor over history.
 *
 * It draws the layout `planRevsetEditor` computed and routes the mouse: a click on a previous
 * input inserts it, a click on an action runs it, the wheel scrolls an overflowing notice, and a
 * click outside or on `[Esc]` closes. Keys are the log surface's: it captures every key while the
 * editor is open and leaves typing to the focused field.
 */
export function RevsetEditorDialog({
  state,
  layout,
  terminalWidth,
  terminalHeight,
  theme,
  onDraftChange,
  onInsert,
  onAction,
  onScrollNotice,
  onClose,
  fieldRef,
}: {
  /** Where the log surface finds the field's buffer; set while the field is on screen. */
  fieldRef: MutableRefObject<FieldHandle | null>;
  state: RevsetEditorState;
  layout: EditorLayout;
  terminalWidth: number;
  terminalHeight: number;
  theme: AppTheme;
  onDraftChange: (draft: string) => void;
  onInsert: (index: number) => void;
  onAction: (id: EditorActionId) => void;
  onScrollNotice: (delta: number) => void;
  onClose: () => void;
}) {
  // The field is gone when the dialog is: a later key must not find a dead buffer.
  useEffect(() => () => void (fieldRef.current = null), [fieldRef]);

  if (layout.kind === "too-small") {
    const width = Math.max(1, terminalWidth - 2);
    return (
      <>
        <box
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: terminalWidth,
            height: terminalHeight,
            zIndex: 55,
            backgroundColor: theme.panel,
            flexDirection: "column",
            paddingLeft: 1,
            paddingRight: 1,
          }}
          onMouseUp={onClose}
        >
          <text fg={theme.text}>{fitText(REVSET_EDITOR_TITLE, width)}</text>
          <text fg={theme.text}> </text>
          {wrapText(TOO_SMALL_MESSAGE, width).map((line, index) => (
            <text key={index} fg={theme.muted}>
              {line}
            </text>
          ))}
          <box onMouseUp={onClose}>
            <text fg={theme.badgeNeutral}>[Esc] Cancel</text>
          </box>
        </box>
      </>
    );
  }

  const busy = state.phase !== "editing";
  const fieldWidth = Math.max(1, layout.bodyWidth - REVSET_FIELD_PREFIX.length);
  const renderRow = (row: EditorRow, index: number) => {
    switch (row.kind) {
      case "field":
        return (
          <box key={index} style={{ width: "100%", height: 1, flexDirection: "row" }}>
            <text fg={theme.muted}>{REVSET_FIELD_PREFIX}</text>
            <input
              ref={(node: unknown) => {
                fieldRef.current = node as FieldHandle | null;
              }}
              width={fieldWidth}
              value={state.draft}
              maxLength={REVSET_DRAFT_MAX_UNITS}
              scrollMargin={0}
              focused={!busy}
              onInput={onDraftChange}
            />
          </box>
        );
      case "mode":
        return (
          <text key={index} style={{ height: 1 }} fg={theme.muted}>
            {fitText(row.text, layout.bodyWidth)}
          </text>
        );
      case "blank":
        return <box key={index} style={{ width: "100%", height: 1 }} />;
      case "text":
        return (
          <text
            key={index}
            style={{ height: 1 }}
            fg={
              row.tone === "error"
                ? theme.badgeRemoved
                : row.tone === "muted"
                  ? theme.muted
                  : theme.text
            }
          >
            {row.text}
          </text>
        );
      case "item":
        return (
          <box
            key={index}
            style={{ width: "100%", height: 1, flexDirection: "row" }}
            onMouseUp={(event: TuiMouseEvent) => {
              event.stopPropagation();
              onInsert(row.index);
            }}
          >
            <text fg={row.highlighted ? theme.accent : theme.muted}>
              {row.highlighted ? "> " : "  "}
            </text>
            <text fg={theme.text}>{fitText(row.text, Math.max(1, layout.bodyWidth - 2), "…")}</text>
          </box>
        );
      case "hint":
        return (
          <text key={index} style={{ height: 1 }} fg={theme.muted}>
            {row.text}
          </text>
        );
      case "actions":
        return (
          <box key={index} style={{ width: "100%", height: 1, flexDirection: "row" }}>
            {row.items.map((item, itemIndex) => (
              <box
                key={item.id}
                style={{ flexDirection: "row" }}
                onMouseUp={(event: TuiMouseEvent) => {
                  event.stopPropagation();
                  onAction(item.id);
                }}
              >
                {itemIndex > 0 ? <text>{"  "}</text> : null}
                <text fg={busy && item.id !== "cancel" ? theme.muted : theme.accent}>
                  {item.label}
                </text>
              </box>
            ))}
          </box>
        );
    }
  };

  return (
    <ModalFrame
      title={REVSET_EDITOR_TITLE}
      compact={layout.compact}
      fitTitle
      top={layout.frame.top}
      width={layout.frame.width}
      height={layout.frame.height}
      terminalWidth={terminalWidth}
      terminalHeight={terminalHeight}
      theme={theme}
      onClose={onClose}
      onMouseScroll={(event: TuiMouseEvent) => {
        const direction = event.scroll?.direction;
        if (direction === "up") onScrollNotice(-1);
        else if (direction === "down") onScrollNotice(1);
      }}
    >
      {layout.rows.map(renderRow)}
    </ModalFrame>
  );
}
