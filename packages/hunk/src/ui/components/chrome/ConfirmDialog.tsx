import { MouseButton, type MouseEvent as TuiMouseEvent } from "@opentui/core";
import type { ReactNode } from "react";
import { useState } from "react";
import { MODAL_FRAME_CHROME_ROWS, resolveModalGeometry } from "../../lib/modalGeometry";
import type { AppTheme } from "../../themes";
import { ModalFrame } from "./ModalFrame";

import type { ConfirmDialogAction } from "../../lib/dialogActions";
export type { ConfirmDialogAction } from "../../lib/dialogActions";

/** Rows ConfirmDialog adds around the body: ModalFrame chrome plus spacer and action row. */
const CONFIRM_DIALOG_CHROME_ROWS = MODAL_FRAME_CHROME_ROWS + 2;

/** Modal height for a ConfirmDialog whose body renders the given number of rows. */
export function confirmDialogHeight(bodyRows: number, compact = false) {
  return bodyRows + CONFIRM_DIALOG_CHROME_ROWS - (compact ? 2 : 0);
}

/** Render the shared mouse-clickable key legend used by modal action footers. */
export function DialogActionRow({
  actions,
  theme,
  primaryMouseOnly = false,
}: {
  actions: ConfirmDialogAction[];
  theme: AppTheme;
  /** Let source controls ignore secondary clicks without changing existing dialogs. */
  primaryMouseOnly?: boolean;
}) {
  const [hoveredActionKey, setHoveredActionKey] = useState<string | null>(null);

  return (
    <box style={{ width: "100%", height: 1, flexDirection: "row" }}>
      {actions.map((action, index) => {
        const actionId = action.id ?? action.keyLabel;
        const hovered = hoveredActionKey === actionId || action.focused === true;
        return (
          <box key={actionId} style={{ flexDirection: "row" }}>
            {index > 0 ? <text fg={theme.badgeNeutral}> · </text> : null}
            <box
              style={{
                flexDirection: "row",
                paddingLeft: 1,
                paddingRight: 1,
                backgroundColor: hovered ? theme.accentMuted : undefined,
              }}
              onMouseOver={() => setHoveredActionKey(actionId)}
              onMouseOut={() =>
                setHoveredActionKey((current) => (current === actionId ? null : current))
              }
              onMouseUp={(event: TuiMouseEvent) => {
                event.stopPropagation();
                if (!primaryMouseOnly || event.button === MouseButton.LEFT) action.run();
              }}
            >
              <text fg={theme.accent}>{action.keyLabel}</text>
              <text fg={hovered ? theme.text : theme.muted}> {action.label}</text>
            </box>
          </box>
        );
      })}
    </box>
  );
}

/**
 * Hunk's standard confirm modal shape: a ModalFrame with arbitrary body rows and
 * one bottom action legend (`key label · key label · …`).
 *
 * Actions are mouse-clickable and highlight on hover. Keyboard shortcuts for the
 * same actions are intentionally not handled here — wire them through
 * useAppKeyboardShortcuts so all key handling stays in one place, and keep each
 * action's `keyLabel` in sync with the keys that hook accepts.
 *
 * New confirmation prompts should reuse this component instead of composing
 * ModalFrame with a hand-rolled footer. Size it with
 * `confirmDialogHeight(bodyRows)` where `bodyRows` counts the 1-row boxes the
 * body renders.
 */
export function ConfirmDialog({
  actions,
  children,
  height,
  onClose,
  terminalHeight,
  terminalWidth,
  theme,
  title,
  width,
  primaryMouseOnly = false,
  actionRows,
  compact = false,
  onMouseScroll,
}: {
  actions: ConfirmDialogAction[];
  children: ReactNode;
  height: number;
  /** Invoked by the frame's backdrop click and [Esc] affordance. */
  onClose?: () => void;
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
  title: string;
  width: number;
  primaryMouseOnly?: boolean;
  /** Optional wrapped footer; existing callers retain their single action row. */
  actionRows?: ConfirmDialogAction[][];
  /** Reuse the existing compact frame for terminals too short for normal chrome. */
  compact?: boolean;
  onMouseScroll?: (event: TuiMouseEvent) => void;
}) {
  const frame = resolveModalGeometry({ width, height, terminalWidth, terminalHeight, compact });
  const chromeRows = MODAL_FRAME_CHROME_ROWS - (compact ? 2 : 0);
  const showActions = frame.height > chromeRows;
  const showActionGap = frame.height >= confirmDialogHeight(0, compact);

  return (
    <ModalFrame
      height={height}
      compact={compact}
      fitTitle={compact}
      terminalHeight={terminalHeight}
      terminalWidth={terminalWidth}
      theme={theme}
      title={title}
      width={width}
      onClose={onClose}
      primaryMouseOnly={primaryMouseOnly}
      onMouseScroll={onMouseScroll}
    >
      {children}
      {showActionGap ? <box style={{ width: "100%", height: 1 }} /> : null}
      {showActions
        ? (actionRows ?? [actions]).map((row, index) => (
            <DialogActionRow
              key={index}
              actions={row}
              theme={theme}
              primaryMouseOnly={primaryMouseOnly}
            />
          ))
        : null}
    </ModalFrame>
  );
}
