/** Border, title, and padding rows ModalFrame reserves around its children. */
export const MODAL_FRAME_CHROME_ROWS = 5;

/** Concrete dimensions and placement of a modal inside one terminal viewport. */
export interface ModalGeometry {
  width: number;
  height: number;
  left: number;
  top: number;
}

/**
 * Clamp requested modal dimensions before either measurement or rendering.
 *
 * Callers use the returned width to wrap content, so their row plans always
 * match the frame ModalFrame eventually draws, including narrow terminals.
 */
export function resolveModalGeometry({
  height,
  terminalHeight,
  terminalWidth,
  width,
  compact = false,
  top: requestedTop,
}: {
  width: number;
  height: number;
  terminalWidth: number;
  terminalHeight: number;
  /** Let a short-terminal dialog use all but one row, as its compact frame has no padding rows. */
  compact?: boolean;
  /** Place the top edge here instead of centering, clamped to stay on screen. */
  top?: number;
}): ModalGeometry {
  const availableWidth = Math.max(1, terminalWidth - 2);
  const availableHeight = Math.max(1, terminalHeight - (compact ? 1 : 2));
  const resolvedWidth = Math.max(1, Math.min(width, availableWidth));
  const resolvedHeight = Math.max(1, Math.min(height, availableHeight));

  return {
    width: resolvedWidth,
    height: resolvedHeight,
    left: Math.max(0, Math.floor((terminalWidth - resolvedWidth) / 2)),
    top:
      requestedTop === undefined
        ? Math.max(0, Math.floor((terminalHeight - resolvedHeight) / 2))
        : Math.max(0, Math.min(requestedTop, terminalHeight - resolvedHeight)),
  };
}
