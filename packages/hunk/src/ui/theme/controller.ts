import { themeModeForTerminalColors, type TerminalThemeMode } from "../../core/theme/detection";
import {
  getDetectedTerminalColors,
  setDetectedTerminalColors,
  type TerminalColors,
} from "../../core/theme/terminalColors";
import type { NamedCustomThemeConfig } from "../../extension-api/types";
import { availableThemes, resolveTheme } from "../themes";

export interface ThemeSnapshot {
  themeId: string;
  customThemes: readonly NamedCustomThemeConfig[];
  themeMode: TerminalThemeMode | undefined;
  terminalColors: TerminalColors | undefined;
}

/**
 * Own the committed theme, the live light/dark appearance, reloadable catalog, and live terminal
 * colors across one Hunk session.
 *
 * The committed identity is the launch theme until the picker commits one, and appearance never
 * changes it, so quit prompts and routed surfaces only see what the user chose. Surfaces derive
 * the appearance-following theme they display from `themeMode`. Terminal color updates adopt
 * fresh palette colors while preserving authoritative system appearance.
 */
export class ThemeController {
  readonly initialThemeId: string;
  private listeners = new Set<() => void>();
  private snapshot: ThemeSnapshot;
  private liveThemeMode: TerminalThemeMode | undefined;
  private pickedThemeId: string | null = null;
  private systemAppearanceAuthoritative: boolean;

  constructor({
    initialTheme,
    initialThemeMode,
    customThemes,
    systemAppearanceResolved = false,
  }: {
    initialTheme?: string;
    initialThemeMode?: TerminalThemeMode | null;
    customThemes?: readonly NamedCustomThemeConfig[];
    /** Whether `initialThemeMode` came from a successful macOS read, which stays authoritative. */
    systemAppearanceResolved?: boolean;
  }) {
    this.initialThemeId = resolveTheme(initialTheme, initialThemeMode ?? null, customThemes).id;
    this.liveThemeMode = initialThemeMode ?? undefined;
    this.systemAppearanceAuthoritative = systemAppearanceResolved;
    this.snapshot = {
      themeId: this.initialThemeId,
      customThemes: customThemes ?? [],
      themeMode: this.liveThemeMode,
      terminalColors: getDetectedTerminalColors(),
    };
  }

  /** Return the latest valid light or dark appearance reported for this session. */
  get themeMode() {
    return this.liveThemeMode;
  }

  /** Return the theme the picker committed this session, which beats appearance until quit. */
  get sessionThemeId() {
    return this.pickedThemeId;
  }

  /** Return the immutable committed-theme snapshot. */
  getSnapshot = () => this.snapshot;

  /** Subscribe one mounted surface to committed theme and appearance changes. */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Commit one picked theme identity for all current and future surfaces. */
  commitTheme(themeId: string) {
    if (themeId === this.pickedThemeId) return;
    this.pickedThemeId = themeId;
    this.publish({ ...this.snapshot, themeId });
  }

  /** Record one successful macOS appearance read, which stays authoritative for the session. */
  reportSystemThemeMode(mode: TerminalThemeMode) {
    this.systemAppearanceAuthoritative = true;
    this.applyThemeMode(mode);
  }

  /** Record one terminal appearance report, which counts only until macOS appearance is read. */
  reportTerminalThemeMode(mode: TerminalThemeMode) {
    if (!this.systemAppearanceAuthoritative) {
      this.applyThemeMode(mode);
    }
  }

  /**
   * Replace the reloadable custom-theme catalog without changing the committed identity. A picked
   * theme the new catalog no longer offers is cleared, so surfaces fall back to their configured
   * theme.
   */
  replaceCustomThemes(customThemes: readonly NamedCustomThemeConfig[]) {
    if (customThemes === this.snapshot.customThemes) return;
    const pickRemoved =
      this.pickedThemeId !== null &&
      !availableThemes(customThemes, this.liveThemeMode ?? null).some(
        (theme) => theme.id === this.pickedThemeId,
      );
    if (pickRemoved) this.pickedThemeId = null;
    this.publish({
      ...this.snapshot,
      themeId: pickRemoved ? this.initialThemeId : this.snapshot.themeId,
      customThemes,
    });
  }

  /** Adopt freshly probed terminal colors after the user's terminal switched themes. */
  updateTerminalColors(terminalColors: TerminalColors) {
    if (terminalColors === this.snapshot.terminalColors) return;
    setDetectedTerminalColors(terminalColors);
    if (!this.systemAppearanceAuthoritative) {
      const mode = themeModeForTerminalColors(terminalColors);
      if (mode) {
        this.liveThemeMode = mode;
      }
    }
    this.publish({
      ...this.snapshot,
      terminalColors,
      themeMode: this.liveThemeMode,
    });
  }

  /** Store one new appearance and republish so surfaces re-derive the theme they display. */
  private applyThemeMode(mode: TerminalThemeMode) {
    if (mode === this.liveThemeMode) return;
    this.liveThemeMode = mode;
    this.publish({ ...this.snapshot, themeMode: this.liveThemeMode });
  }

  /** Swap in one snapshot and notify every subscribed surface. */
  private publish(snapshot: ThemeSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
