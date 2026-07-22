import { CliRenderEvents, type CliRenderer } from "@opentui/core";
import type { TerminalThemeMode } from "../../core/theme/detection";
import type {
  resolveSystemAppearanceMode,
  subscribeToSystemAppearanceMode,
} from "../../core/theme/systemAppearance";
import type { ThemeController } from "./controller";

/** macOS appearance sources; tests and callers without a macOS source leave them unset. */
export interface SystemAppearanceSources {
  resolveSystemAppearance?: typeof resolveSystemAppearanceMode;
  subscribeSystemAppearance?: typeof subscribeToSystemAppearanceMode;
}

type AppearanceRenderer = Pick<CliRenderer, "off" | "on" | "themeMode">;

const trackedRenderers = new WeakSet<AppearanceRenderer>();

/**
 * Feed one renderer's focus and theme-mode events, plus macOS preference changes, into a theme
 * controller, and return the disposer that removes every listener.
 *
 * A successful macOS read, at mount, on focus return, or after a preference change, stays
 * authoritative for the session; renderer theme-mode events count only before it. One renderer
 * accepts one tracker at a time, so a session never runs two appearance watchers.
 */
export function trackLiveAppearance(
  renderer: AppearanceRenderer,
  controller: ThemeController,
  { resolveSystemAppearance, subscribeSystemAppearance }: SystemAppearanceSources,
): () => void {
  if (trackedRenderers.has(renderer)) {
    throw new Error("Live appearance is already tracked for this renderer.");
  }
  trackedRenderers.add(renderer);

  /** Reassert macOS appearance when the user returns to the terminal. */
  const handleFocus = () => {
    const systemMode = resolveSystemAppearance?.() ?? null;
    if (systemMode !== null) controller.reportSystemThemeMode(systemMode);
  };
  const handleThemeMode = (mode: TerminalThemeMode) => controller.reportTerminalThemeMode(mode);

  renderer.on(CliRenderEvents.FOCUS, handleFocus);
  renderer.on(CliRenderEvents.THEME_MODE, handleThemeMode);
  const subscription = subscribeSystemAppearance?.((mode) =>
    controller.reportSystemThemeMode(mode),
  );
  // Subscribe before re-reading so the watcher or this reconciliation read sees any race.
  handleFocus();
  if (renderer.themeMode !== null) handleThemeMode(renderer.themeMode);

  return () => {
    subscription?.dispose();
    renderer.off(CliRenderEvents.FOCUS, handleFocus);
    renderer.off(CliRenderEvents.THEME_MODE, handleThemeMode);
    trackedRenderers.delete(renderer);
  };
}
