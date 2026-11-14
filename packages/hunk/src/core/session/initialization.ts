import type { TerminalThemeMode } from "../theme/detection";
import type { NamedCustomThemeConfig } from "../../extension-api/types";
import type { PersistedViewPreferences } from "../run/config";

/** Theme inputs finalized during startup and retained for every surface in one session. */
export interface SessionThemeInitialization {
  initialTheme?: string;
  initialThemeMode?: TerminalThemeMode;
  customThemes: readonly NamedCustomThemeConfig[];
}

/**
 * Carries launch inputs shared by every interactive surface in one Hunk session.
 * Add a concern here only when the session host owns its lifetime across routed surfaces.
 */
export interface InteractiveSessionInitialization {
  theme: SessionThemeInitialization;
  /** Resolved launch preferences that routed review surfaces may update in memory. */
  viewPreferences: PersistedViewPreferences;
  /** Initial history watcher state; the session host owns later F10 overrides. */
  historyAutoRefreshEnabled?: boolean;
}

/** Package finalized cross-surface inputs into one interactive-session launch record. */
export function createInteractiveSessionInitialization({
  theme,
  viewPreferences,
  historyAutoRefreshEnabled,
}: {
  theme: Omit<SessionThemeInitialization, "customThemes"> & {
    customThemes?: readonly NamedCustomThemeConfig[];
  };
  viewPreferences: PersistedViewPreferences;
  historyAutoRefreshEnabled?: boolean;
}): InteractiveSessionInitialization {
  return {
    theme: {
      ...(theme.initialTheme === undefined ? {} : { initialTheme: theme.initialTheme }),
      ...(theme.initialThemeMode === undefined ? {} : { initialThemeMode: theme.initialThemeMode }),
      customThemes: theme.customThemes ?? [],
    },
    viewPreferences,
    ...(historyAutoRefreshEnabled === undefined ? {} : { historyAutoRefreshEnabled }),
  };
}
