import { spawnSync } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TerminalThemeMode } from "./types";

export interface SystemAppearanceCommandResult {
  error?: Error;
  signal: NodeJS.Signals | null;
  status: number | null;
  stderr: string;
  stdout: string;
}

export interface ResolveSystemAppearanceModeOptions {
  platform?: NodeJS.Platform;
  readMacOSAppearance?: () => SystemAppearanceCommandResult;
}

export interface SystemAppearanceSubscription {
  dispose: () => void;
}

interface SubscribeToSystemAppearanceModeOptions {
  debounceMs?: number;
  platform?: NodeJS.Platform;
  preferencesDirectory?: string;
  resolveAppearance?: () => TerminalThemeMode | null;
  watchPreferences?: (
    directory: string,
    listener: (eventType: string, filename: string | Buffer | null) => void,
  ) => Pick<FSWatcher, "close" | "on">;
}

const MACOS_APPEARANCE_READ_TIMEOUT_MS = 500;
const MISSING_APPEARANCE_PREFERENCE =
  "The domain/default pair of (kCFPreferencesAnyApplication, AppleInterfaceStyle) does not exist";
const GLOBAL_PREFERENCES_FILENAME = ".GlobalPreferences.plist";
const APPEARANCE_WATCH_DEBOUNCE_MS = 50;

/** Read the macOS global appearance preference without invoking a shell. */
function readMacOSAppearance(): SystemAppearanceCommandResult {
  const result = spawnSync("/usr/bin/defaults", ["read", "-g", "AppleInterfaceStyle"], {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: MACOS_APPEARANCE_READ_TIMEOUT_MS,
  });

  return {
    error: result.error,
    signal: result.signal,
    status: result.status,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

/** Identify only the expected missing-key response that represents macOS Light mode. */
function isMissingAppearancePreference(result: SystemAppearanceCommandResult): boolean {
  return (
    result.status === 1 &&
    result.stdout.trim() === "" &&
    result.stderr.includes(MISSING_APPEARANCE_PREFERENCE)
  );
}

/** Watch the macOS preferences directory without keeping the Hunk process alive by itself. */
function watchPreferencesDirectory(
  directory: string,
  listener: (eventType: string, filename: string | Buffer | null) => void,
) {
  return watch(directory, { persistent: false }, listener);
}

/** Resolve macOS Light or Dark while leaving every other platform terminal-owned. */
export function resolveSystemAppearanceMode({
  platform = process.platform,
  readMacOSAppearance: readMacOSAppearanceImpl = readMacOSAppearance,
}: ResolveSystemAppearanceModeOptions = {}): TerminalThemeMode | null {
  if (platform !== "darwin") {
    return null;
  }

  let result: SystemAppearanceCommandResult;
  try {
    result = readMacOSAppearanceImpl();
  } catch {
    return null;
  }

  if (result.error || result.signal !== null || result.status === null) {
    return null;
  }

  // macOS omits AppleInterfaceStyle in Light mode, and `defaults read` exits 1 for that key.
  if (isMissingAppearancePreference(result)) {
    return "light";
  }

  if (result.status !== 0) {
    return null;
  }

  return result.stdout.trim() === "Dark" ? "dark" : null;
}

/** Emit macOS appearance changes while Hunk remains focused, without polling. */
export function subscribeToSystemAppearanceMode(
  onMode: (mode: TerminalThemeMode) => void,
  {
    debounceMs = APPEARANCE_WATCH_DEBOUNCE_MS,
    platform = process.platform,
    preferencesDirectory = join(homedir(), "Library", "Preferences"),
    resolveAppearance = resolveSystemAppearanceMode,
    watchPreferences = watchPreferencesDirectory,
  }: SubscribeToSystemAppearanceModeOptions = {},
): SystemAppearanceSubscription {
  if (platform !== "darwin") {
    return { dispose: () => undefined };
  }

  let disposed = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let watcher: Pick<FSWatcher, "close" | "on">;

  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    watcher.close();
  };

  try {
    watcher = watchPreferences(preferencesDirectory, (_eventType, filename) => {
      if (disposed || (filename !== null && String(filename) !== GLOBAL_PREFERENCES_FILENAME)) {
        return;
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (disposed) {
          return;
        }
        const mode = resolveAppearance();
        if (mode !== null) {
          onMode(mode);
        }
      }, debounceMs);
    });
  } catch {
    return { dispose: () => undefined };
  }

  watcher.on("error", dispose);
  return { dispose };
}
