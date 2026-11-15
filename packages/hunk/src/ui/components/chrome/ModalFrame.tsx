import { MouseButton, type MouseEvent as TuiMouseEvent } from "@opentui/core";
import type { ReactNode } from "react";
import { resolveModalGeometry } from "../../lib/modalGeometry";
import { fitText, padText } from "../../lib/text";
import type { AppTheme } from "../../themes";

/** Render a centered framed modal container that other dialogs can reuse. */
export function ModalFrame({
  children,
  compact = false,
  fitTitle = false,
  height,
  onClose,
  onMouseScroll,
  top: requestedTop,
  terminalHeight,
  terminalWidth,
  theme,
  title,
  width,
  primaryMouseOnly = false,
}: {
  children: ReactNode;
  /** Drop the title and bottom padding rows, for terminals too short for the normal frame. */
  compact?: boolean;
  /** Size the title so the title row and `[Esc]` fill the row exactly, with no wrapped blank row. */
  fitTitle?: boolean;
  height: number;
  onClose?: () => void;
  onMouseScroll?: (event: TuiMouseEvent) => void;
  /** Hold the top edge at this row instead of centering; off by default. */
  top?: number;
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
  title: string;
  width: number;
  primaryMouseOnly?: boolean;
}) {
  const {
    height: clampedHeight,
    left,
    top,
    width: clampedWidth,
  } = resolveModalGeometry({
    width,
    height,
    terminalWidth,
    terminalHeight,
    compact,
    top: requestedTop,
  });
  const closeText = onClose ? "[Esc]" : "";
  const titleWidth = Math.max(
    1,
    fitTitle
      ? clampedWidth - 4 - closeText.length
      : clampedWidth - 2 - (closeText ? closeText.length + 1 : 0),
  );

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
        }}
        onMouseUp={(event: TuiMouseEvent) => {
          if (!primaryMouseOnly || event.button === MouseButton.LEFT) onClose?.();
        }}
      />
      <box
        style={{
          position: "absolute",
          top,
          left,
          width: clampedWidth,
          height: clampedHeight,
          zIndex: 60,
          border: true,
          borderColor: theme.accent,
          backgroundColor: theme.panel,
          flexDirection: "column",
        }}
        onMouseScroll={(event: TuiMouseEvent) => {
          event.stopPropagation();
          onMouseScroll?.(event);
        }}
        onMouseUp={(event: TuiMouseEvent) => event.stopPropagation()}
      >
        <box
          style={{
            paddingLeft: 1,
            paddingRight: 1,
            paddingTop: compact ? 0 : 1,
            flexDirection: "row",
          }}
        >
          <text fg={theme.text}>{padText(fitText(title, titleWidth), titleWidth)}</text>
          {closeText ? (
            <box
              onMouseUp={(event: TuiMouseEvent) => {
                event.stopPropagation();
                if (!primaryMouseOnly || event.button === MouseButton.LEFT) onClose?.();
              }}
            >
              <text fg={theme.badgeNeutral}>{closeText}</text>
            </box>
          ) : null}
        </box>
        <box
          style={{
            paddingLeft: 1,
            paddingRight: 1,
            paddingBottom: compact ? 0 : 1,
            flexDirection: "column",
            flexGrow: 1,
          }}
        >
          {children}
        </box>
      </box>
    </>
  );
}
