import { CliRenderEvents, type ThemeMode } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveConfiguredCliInput } from "../core/config";
import { loadAppBootstrap } from "../core/loaders";
import type {
  resolveSystemAppearanceMode,
  subscribeToSystemAppearanceMode,
} from "../core/systemAppearance";
import { resolveRuntimeCliInput } from "../core/terminal";
import { resolveConfiguredThemeInput } from "../core/themePreference";
import type { AppBootstrap, CliInput } from "../core/types";
import type { UpdateNotice } from "../core/updateNotice";
import {
  createInitialSessionSnapshot,
  updateSessionRegistration,
} from "../hunk-session/sessionRegistration";
import {
  createSessionReloadBounds,
  validateSessionReloadWithinBounds,
} from "../hunk-session/sessionFileBounds";
import type { HunkSessionBrokerClient } from "../hunk-session/types";
import { App } from "./App";
import { useStartupUpdateNotice } from "./hooks/useStartupUpdateNotice";

const NO_SYSTEM_APPEARANCE: typeof resolveSystemAppearanceMode = () => null;
const NO_SYSTEM_APPEARANCE_SUBSCRIPTION: typeof subscribeToSystemAppearanceMode = () => ({
  dispose: () => undefined,
});

/** Keep one live Hunk app mounted while allowing daemon-driven session reloads. */
export function AppHost({
  bootstrap,
  hostClient,
  onQuit = () => process.exit(0),
  loadAppBootstrapImpl = loadAppBootstrap,
  startupNoticeResolver,
  systemAppearanceResolver,
  systemAppearanceSubscriber,
}: {
  bootstrap: AppBootstrap;
  hostClient?: HunkSessionBrokerClient;
  onQuit?: () => void;
  loadAppBootstrapImpl?: typeof loadAppBootstrap;
  startupNoticeResolver?: () => Promise<UpdateNotice | null>;
  systemAppearanceResolver?: typeof resolveSystemAppearanceMode;
  systemAppearanceSubscriber?: typeof subscribeToSystemAppearanceMode;
}) {
  const renderer = useRenderer();
  const resolveSystemAppearance = systemAppearanceResolver ?? NO_SYSTEM_APPEARANCE;
  const subscribeSystemAppearance = systemAppearanceSubscriber ?? NO_SYSTEM_APPEARANCE_SUBSCRIPTION;
  const [activeBootstrap, setActiveBootstrap] = useState(bootstrap);
  const [appVersion, setAppVersion] = useState(0);
  const [initialAppearance] = useState(() => {
    const systemMode = resolveSystemAppearance();
    return {
      mode: systemMode ?? renderer.themeMode ?? bootstrap.initialThemeMode,
      systemResolved: systemMode !== null,
    };
  });
  const [terminalThemeMode, setTerminalThemeMode] = useState<ThemeMode | undefined>(
    initialAppearance.mode,
  );
  const activeBootstrapRef = useRef(bootstrap);
  const terminalThemeModeRef = useRef(initialAppearance.mode);
  const systemAppearanceAuthoritativeRef = useRef(initialAppearance.systemResolved);
  const reloadQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [sessionFileBounds] = useState(() =>
    createSessionReloadBounds(bootstrap, {
      cwd: hostClient?.getRegistration().cwd,
    }),
  );
  const startupNoticeText = useStartupUpdateNotice({
    enabled: !bootstrap.input.options.pager,
    resolver: startupNoticeResolver,
  });

  useEffect(() => {
    /** Preserve one latest valid mode across App remounts and queued reloads. */
    const applyThemeMode = (mode: ThemeMode) => {
      if (terminalThemeModeRef.current === mode) {
        return;
      }
      terminalThemeModeRef.current = mode;
      setTerminalThemeMode(mode);
    };

    /** Use terminal notifications only until macOS has supplied an authoritative appearance. */
    const handleThemeMode = (mode: ThemeMode) => {
      if (systemAppearanceAuthoritativeRef.current) {
        return;
      }
      applyThemeMode(mode);
    };

    /** Reassert macOS appearance when the user returns to the terminal. */
    const handleFocus = () => {
      const systemMode = resolveSystemAppearance();
      if (systemMode !== null) {
        systemAppearanceAuthoritativeRef.current = true;
        applyThemeMode(systemMode);
      }
    };

    renderer.on(CliRenderEvents.FOCUS, handleFocus);
    renderer.on(CliRenderEvents.THEME_MODE, handleThemeMode);
    const systemAppearanceSubscription = subscribeSystemAppearance((mode) => {
      systemAppearanceAuthoritativeRef.current = true;
      applyThemeMode(mode);
    });
    // Subscribe before re-reading so a change between lazy initialization and this effect is
    // either observed by the watcher or included in the post-subscription reconciliation read.
    handleFocus();
    // The renderer starts before React mounts. Subscribe first, then reconcile the current value
    // only when a successful pre-render system read did not establish macOS authority.
    if (!initialAppearance.systemResolved && renderer.themeMode !== null) {
      handleThemeMode(renderer.themeMode);
    }
    return () => {
      systemAppearanceSubscription.dispose();
      renderer.off(CliRenderEvents.FOCUS, handleFocus);
      renderer.off(CliRenderEvents.THEME_MODE, handleThemeMode);
    };
  }, [
    initialAppearance.systemResolved,
    renderer,
    resolveSystemAppearance,
    subscribeSystemAppearance,
  ]);

  const reloadSession = useCallback(
    (nextInput: CliInput, options?: { resetApp?: boolean; sourcePath?: string }) => {
      const reloadResult = reloadQueueRef.current.then(async () => {
        const currentBootstrap = activeBootstrapRef.current;
        // Re-run the same startup normalization pipeline used on first launch so reloads honor
        // runtime defaults and config layering instead of assuming `nextInput` is already final.
        // `sourcePath` matters for daemon-driven reloads that ask Hunk to reopen content from a
        // different working directory than the process originally started in.
        const runtimeInput = resolveRuntimeCliInput(nextInput);
        const incomingCliThemeOverride =
          typeof runtimeInput.options.theme === "string" ? runtimeInput.options.theme : undefined;
        const nextCliThemeOverride = incomingCliThemeOverride ?? currentBootstrap.cliThemeOverride;
        const configInput: CliInput = {
          ...runtimeInput,
          options: {
            ...runtimeInput.options,
            theme: nextCliThemeOverride,
          },
        };
        const { cwd } = validateSessionReloadWithinBounds(sessionFileBounds, runtimeInput, {
          sourcePath: options?.sourcePath,
        });
        const configured = resolveConfiguredCliInput(configInput, { cwd });
        const resolvedInput = resolveConfiguredThemeInput(
          configured.input,
          terminalThemeModeRef.current,
        );
        const nextBootstrap = await loadAppBootstrapImpl(resolvedInput, {
          configuredThemePreference: configured.input.options.theme,
          cwd,
          customThemes: configured.customThemes,
        });
        nextBootstrap.initialThemeMode = terminalThemeModeRef.current;
        nextBootstrap.cliThemeOverride = nextCliThemeOverride;
        const nextSnapshot = createInitialSessionSnapshot(nextBootstrap);

        let sessionId = "local-session";
        if (hostClient) {
          // Keep the daemon-facing session registration in sync with whatever the UI is about to
          // show. Replacing both registration and snapshot here means external session commands see
          // the new source, title, and selection baseline immediately after reload.
          const nextRegistration = updateSessionRegistration(
            hostClient.getRegistration(),
            nextBootstrap,
          );
          sessionId = nextRegistration.sessionId;
          hostClient.replaceSession(nextRegistration, nextSnapshot);
        }

        activeBootstrapRef.current = nextBootstrap;
        setActiveBootstrap(nextBootstrap);
        if (options?.resetApp !== false) {
          // Bumping the key forces a full App remount. Callers that pass `resetApp: false` get a
          // soft reload that preserves in-memory UI state like selection, filter text, and pane size.
          setAppVersion((current) => current + 1);
        }

        return {
          sessionId,
          inputKind: nextBootstrap.input.kind,
          title: nextBootstrap.changeset.title,
          sourceLabel: nextBootstrap.changeset.sourceLabel,
          fileCount: nextBootstrap.changeset.files.length,
          selectedFilePath: nextSnapshot.state.selectedFilePath,
          selectedHunkIndex: nextSnapshot.state.selectedHunkIndex,
        };
      });

      // Keep later reloads ordered even if one request fails, while returning the original result
      // to the caller that owns this command.
      reloadQueueRef.current = reloadResult.then(
        () => undefined,
        () => undefined,
      );
      return reloadResult;
    },
    [hostClient, loadAppBootstrapImpl, sessionFileBounds],
  );

  return (
    <App
      key={appVersion}
      bootstrap={activeBootstrap}
      hostClient={hostClient}
      noticeText={startupNoticeText}
      onQuit={onQuit}
      onReloadSession={reloadSession}
      terminalThemeMode={terminalThemeMode}
    />
  );
}
