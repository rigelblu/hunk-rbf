import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { CliRenderEvents } from "@opentui/core";
import {
  FALLBACK_TERMINAL_COLORS,
  getDetectedTerminalColors,
  setDetectedTerminalColors,
  type TerminalColors,
} from "../../core/theme/terminalColors";
import { resolveThemePreference } from "../../core/themePreference";
import { resolveTheme } from "../themes";
import { ThemeController, type ThemeSnapshot } from "./controller";
import { trackLiveAppearance } from "./liveAppearance";
import { watchTerminalColors } from "./terminalColorWatcher";

interface TestPaletteReport {
  palette?: (string | undefined)[];
  defaultForeground?: string;
  defaultBackground?: string;
}

/**
 * Creates an event-driven test renderer for exercising theme controller lifecycle events.
 */
function createTestThemeRenderer(initialMode: "light" | "dark" | null = null) {
  const emitter = new EventEmitter();
  const handlers: ((seq: string) => boolean | void)[] = [];
  let paletteReport: TestPaletteReport | undefined | null = undefined;
  let paletteThrows = false;

  const renderer = {
    themeMode: initialMode,
    cacheClears: 0,
    on(event: string, listener: (...args: any[]) => void) {
      emitter.on(event, listener);
      return renderer as never;
    },
    off(event: string, listener: (...args: any[]) => void) {
      emitter.off(event, listener);
      return renderer as never;
    },
    emit: emitter.emit.bind(emitter),
    prependInputHandler(handler: (seq: string) => boolean | void) {
      handlers.unshift(handler);
    },
    removeInputHandler(handler: (seq: string) => boolean | void) {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    },
    feedInput(seq: string) {
      for (const h of handlers) {
        if (h(seq)) return true;
      }
      return false;
    },
    clearPaletteCache() {
      renderer.cacheClears += 1;
    },
    async getPalette() {
      if (paletteThrows) throw new Error("OSC query unsupported / timed out");
      return paletteReport as never;
    },
    setPaletteReport(report: TestPaletteReport | undefined) {
      paletteReport = report;
      paletteThrows = false;
    },
    setPaletteThrows(throws: boolean) {
      paletteThrows = throws;
    },
    listenerCount(event: string) {
      return emitter.listenerCount(event);
    },
  };
  return renderer;
}

describe("ThemeController", () => {
  afterEach(() => setDetectedTerminalColors(undefined));

  test("resolves launch state once and publishes committed identities", () => {
    const controller = new ThemeController({
      initialTheme: "auto",
      initialThemeMode: "light",
    });
    let publications = 0;
    const unsubscribe = controller.subscribe(() => {
      publications += 1;
    });

    expect(controller.initialThemeId).toBe("github-light-default");
    expect(controller.getSnapshot().themeId).toBe("github-light-default");
    expect(controller.themeMode).toBe("light");

    controller.commitTheme("dracula");
    controller.commitTheme("dracula");
    expect(controller.getSnapshot().themeId).toBe("dracula");
    expect(publications).toBe(1);

    unsubscribe();
    controller.commitTheme("github-dark-default");
    expect(publications).toBe(1);
  });

  test("publishes catalog replacements without changing the committed identity", () => {
    const initialThemes = [{ id: "team", accent: "#123456" }];
    const replacementThemes = [{ id: "team", accent: "#abcdef" }];
    const controller = new ThemeController({
      initialTheme: "team",
      customThemes: initialThemes,
    });
    let publications = 0;
    controller.subscribe(() => {
      publications += 1;
    });

    controller.replaceCustomThemes(replacementThemes);
    controller.replaceCustomThemes(replacementThemes);

    expect(controller.getSnapshot()).toMatchObject({
      themeId: "team",
      customThemes: replacementThemes,
    });
    expect(publications).toBe(1);
  });

  test("adopts switched terminal colors so the terminal theme repaints", () => {
    setDetectedTerminalColors({ foreground: "#c0caf5", background: "#1a1b26", palette: [] });
    const controller = new ThemeController({ initialTheme: "terminal", initialThemeMode: "dark" });
    let publications = 0;
    controller.subscribe(() => {
      publications += 1;
    });
    const before = resolveTheme("terminal", controller.themeMode ?? null);

    const lightColors = {
      foreground: "#4c4f69",
      background: "#eff1f5",
      palette: [undefined, "#d20f39", "#40a02b"],
    };
    controller.updateTerminalColors(lightColors);
    controller.updateTerminalColors(lightColors);

    expect(publications).toBe(1);
    expect(getDetectedTerminalColors()).toBe(lightColors);
    expect(controller.getSnapshot()).toMatchObject({
      themeId: "terminal",
      themeMode: "light",
      terminalColors: lightColors,
    });
    const after = resolveTheme("terminal", controller.themeMode ?? null);
    expect(after).not.toBe(before);
    expect(after).toMatchObject({ appearance: "light", background: "#eff1f5" });
    expect(after.removedSignColor).not.toBe(before.removedSignColor);
  });

  test("preserves authoritative system mode when terminal colors report opposing appearance", () => {
    const controller = new ThemeController({
      initialTheme: "auto",
      initialThemeMode: "light",
      systemAppearanceResolved: true,
    });
    expect(controller.themeMode).toBe("light");
    expect(controller.getSnapshot().themeMode).toBe("light");

    let publications = 0;
    controller.subscribe(() => {
      publications += 1;
    });

    const darkTerminalColors = {
      foreground: "#c0caf5",
      background: "#1a1b26",
      palette: ["#1a1b26", "#f7768e", "#9ece6a"],
    };
    controller.updateTerminalColors(darkTerminalColors);

    expect(publications).toBe(1);
    expect(controller.themeMode).toBe("light");
    expect(controller.getSnapshot().themeMode).toBe("light");
    expect(getDetectedTerminalColors()).toBe(darkTerminalColors);
    expect(controller.getSnapshot().terminalColors).toBe(darkTerminalColors);
  });

  test("republishes fresh palette colors when appearance classification is unchanged", () => {
    const darkColors1 = {
      foreground: "#c0caf5",
      background: "#1a1b26",
      palette: ["#1a1b26", "#f7768e"],
    };
    setDetectedTerminalColors(darkColors1);
    const controller = new ThemeController({
      initialTheme: "terminal",
      initialThemeMode: "dark",
    });

    let publications = 0;
    controller.subscribe(() => {
      publications += 1;
    });

    const darkColors2 = {
      foreground: "#d0d0d0",
      background: "#101010",
      palette: ["#101010", "#ff0000"],
    };
    controller.updateTerminalColors(darkColors2);

    expect(publications).toBe(1);
    expect(controller.themeMode).toBe("dark");
    expect(controller.getSnapshot().themeMode).toBe("dark");
    expect(controller.getSnapshot().terminalColors).toBe(darkColors2);
    expect(getDetectedTerminalColors()).toBe(darkColors2);
  });

  test("retains picked theme identity across terminal palette updates", () => {
    const controller = new ThemeController({
      initialTheme: "github-dark-default",
      initialThemeMode: "dark",
    });
    controller.commitTheme("dracula");
    expect(controller.getSnapshot().themeId).toBe("dracula");
    expect(controller.sessionThemeId).toBe("dracula");

    let publications = 0;
    controller.subscribe(() => {
      publications += 1;
    });

    const newColors = {
      foreground: "#4c4f69",
      background: "#eff1f5",
      palette: ["#eff1f5", "#d20f39"],
    };
    controller.updateTerminalColors(newColors);

    expect(publications).toBe(1);
    expect(controller.getSnapshot().themeId).toBe("dracula");
    expect(controller.sessionThemeId).toBe("dracula");
    expect(controller.getSnapshot().terminalColors).toBe(newColors);
  });

  test("accepts terminal mode fallback before native read, then locks to native authority", () => {
    const controller = new ThemeController({
      initialTheme: "auto",
      initialThemeMode: null,
      systemAppearanceResolved: false,
    });
    expect(controller.themeMode).toBeUndefined();

    // Pre-native terminal report provides fallback
    controller.reportTerminalThemeMode("light");
    expect(controller.themeMode).toBe("light");
    expect(controller.getSnapshot().themeMode).toBe("light");

    // Native macOS appearance establishes authority
    controller.reportSystemThemeMode("dark");
    expect(controller.themeMode).toBe("dark");
    expect(controller.getSnapshot().themeMode).toBe("dark");

    // Subsequent terminal reports cannot override authoritative macOS mode
    controller.reportTerminalThemeMode("light");
    expect(controller.themeMode).toBe("dark");
    expect(controller.getSnapshot().themeMode).toBe("dark");

    // Opposing terminal colors also cannot override
    const lightColors = {
      foreground: "#4c4f69",
      background: "#eff1f5",
      palette: ["#eff1f5"],
    };
    controller.updateTerminalColors(lightColors);
    expect(controller.themeMode).toBe("dark");
    expect(controller.getSnapshot().themeMode).toBe("dark");
    expect(controller.getSnapshot().terminalColors).toBe(lightColors);
  });

  test("retains last valid native mode when later native resolver returns null or errors", () => {
    const renderer = createTestThemeRenderer();
    let systemResolver: () => "light" | "dark" | null = () => "dark";
    const controller = new ThemeController({
      initialTheme: "auto",
      initialThemeMode: null,
    });

    const stopTracking = trackLiveAppearance(renderer, controller, {
      resolveSystemAppearance: () => systemResolver(),
    });

    // Native resolver succeeded on startup: native mode is authoritative
    expect(controller.themeMode).toBe("dark");

    // Later native check returns null: native authority survives
    systemResolver = () => null;
    renderer.emit(CliRenderEvents.FOCUS);
    expect(controller.themeMode).toBe("dark");

    // Later native check throws an error: native authority survives
    systemResolver = () => {
      throw new Error("spawnSync defaults error");
    };
    renderer.emit(CliRenderEvents.FOCUS);
    expect(controller.themeMode).toBe("dark");

    // Terminal reports cannot override authoritative native mode
    renderer.emit(CliRenderEvents.THEME_MODE, "light");
    expect(controller.themeMode).toBe("dark");
    expect(controller.getSnapshot().themeMode).toBe("dark");

    stopTracking();
  });

  test("resolves terminal theme as a pair member using actual terminal palette even under opposing native mode", () => {
    const opposingTerminalColors: TerminalColors = {
      foreground: "#ffffff",
      background: "#111111",
      palette: ["#111111", "#ff0000", "#00ff00"],
    };
    const controller = new ThemeController({
      initialThemeMode: "light",
      systemAppearanceResolved: true,
    });

    // Pair preference where light selects terminal and dark selects github-dark-default
    const pairPreference = { light: "terminal", dark: "github-dark-default" };

    // Real resolveThemePreference resolves "terminal" because native mode is light
    const selectedLightId = resolveThemePreference(pairPreference, controller.themeMode);
    expect(selectedLightId).toBe("terminal");

    // Now update terminal colors with opposing (dark) colors
    controller.updateTerminalColors(opposingTerminalColors);

    // Native authority holds light mode despite dark terminal palette
    expect(controller.themeMode).toBe("light");

    // Re-resolve pair preference: still selects "terminal" because native mode is authoritative
    const activePairThemeId = resolveThemePreference(pairPreference, controller.themeMode);
    expect(activePairThemeId).toBe("terminal");

    // The selected terminal theme renders the actual opposing terminal colors
    const resolvedTheme = resolveTheme(activePairThemeId, controller.themeMode ?? null);
    expect(resolvedTheme.id).toBe("terminal");
    expect(resolvedTheme.background).toBe("#111111");
    expect(resolvedTheme.text).toBe("#ffffff");
  });

  test("falls back to bounded default palette when terminal color queries are unsupported or fail", async () => {
    setDetectedTerminalColors(undefined);
    const renderer = createTestThemeRenderer();
    renderer.setPaletteThrows(true);
    const signals = new EventEmitter();

    let publishedColors: TerminalColors | undefined;
    const stopWatcher = watchTerminalColors({
      renderer,
      current: () => publishedColors,
      onChange: (colors) => {
        publishedColors = colors;
      },
      signals,
    });

    // Trigger watcher probe via SIGWINCH; renderer rejects
    signals.emit("SIGWINCH");
    await Bun.sleep(120);

    // No valid colors were published; probe error was caught safely
    expect(publishedColors).toBeUndefined();
    expect(getDetectedTerminalColors()).toBeUndefined();

    // Resolver safely falls back to bounded default palettes
    const darkTheme = resolveTheme("terminal", "dark");
    expect(darkTheme.id).toBe("terminal");
    expect(darkTheme.background).toBe(FALLBACK_TERMINAL_COLORS.dark.background);
    expect(darkTheme.text).toBe(FALLBACK_TERMINAL_COLORS.dark.foreground);

    const lightTheme = resolveTheme("terminal", "light");
    expect(lightTheme.id).toBe("terminal");
    expect(lightTheme.background).toBe(FALLBACK_TERMINAL_COLORS.light.background);
    expect(lightTheme.text).toBe(FALLBACK_TERMINAL_COLORS.light.foreground);

    stopWatcher();
  });

  test("combined lifecycle: native success -> fresh opposing terminal palette -> same-mode fresh palette -> later native null -> native authority survives", async () => {
    const renderer = createTestThemeRenderer();
    const signals = new EventEmitter();
    let nativeModeResult: "light" | "dark" | null = "light";

    const controller = new ThemeController({
      initialTheme: "auto",
      initialThemeMode: null,
      systemAppearanceResolved: false,
    });

    // Track publications
    const publications: ThemeSnapshot[] = [];
    controller.subscribe(() => {
      publications.push(controller.getSnapshot());
    });

    // Retained configured pair preference
    const configuredPair = { light: "terminal", dark: "nord" } as const;

    // 1. Injected trackLiveAppearance + watchTerminalColors
    const stopLiveAppearance = trackLiveAppearance(renderer, controller, {
      resolveSystemAppearance: () => nativeModeResult,
    });

    const stopColorWatcher = watchTerminalColors({
      renderer,
      current: () => controller.getSnapshot().terminalColors,
      onChange: (colors) => controller.updateTerminalColors(colors),
      signals,
    });

    // Native success establishes authority
    expect(controller.themeMode).toBe("light");
    expect(resolveThemePreference(configuredPair, controller.themeMode)).toBe("terminal");

    // 2. Fresh opposing terminal palette (dark palette reported by terminal)
    const opposingDarkPalette = {
      defaultForeground: "#f0f0f0",
      defaultBackground: "#101010",
      palette: ["#101010", "#ff4040", "#40ff40"],
    };
    renderer.setPaletteReport(opposingDarkPalette);
    renderer.feedInput("\x1b[?997;1n");
    await Bun.sleep(120);

    // Terminal colors adopted, but native authority ("light") survives
    expect(controller.themeMode).toBe("light");
    expect(controller.getSnapshot().terminalColors?.background).toBe("#101010");
    expect(controller.getSnapshot().terminalColors?.foreground).toBe("#f0f0f0");
    // Configured pair selects "terminal" (via native light mode), and renders actual terminal colors!
    const activeThemeId1 = resolveThemePreference(configuredPair, controller.themeMode);
    expect(activeThemeId1).toBe("terminal");
    const activeTheme1 = resolveTheme(activeThemeId1, controller.themeMode ?? null);
    expect(activeTheme1.id).toBe("terminal");
    expect(activeTheme1.background).toBe("#101010");
    expect(activeTheme1.text).toBe("#f0f0f0");

    // 3. Same-mode fresh palette (still dark, but different colors)
    const sameModeFreshPalette = {
      defaultForeground: "#e8e8e8",
      defaultBackground: "#202020",
      palette: ["#202020", "#dd3355", "#00aa55"],
    };
    renderer.setPaletteReport(sameModeFreshPalette);
    signals.emit("SIGWINCH");
    await Bun.sleep(120);

    expect(controller.themeMode).toBe("light");
    expect(controller.getSnapshot().terminalColors?.background).toBe("#202020");
    expect(controller.getSnapshot().terminalColors?.foreground).toBe("#e8e8e8");
    const activeTheme2 = resolveTheme("terminal", controller.themeMode ?? null);
    expect(activeTheme2.background).toBe("#202020");
    expect(activeTheme2.text).toBe("#e8e8e8");

    // 4. User preview / pick identity retention
    controller.commitTheme("dracula");
    expect(controller.sessionThemeId).toBe("dracula");
    expect(controller.getSnapshot().themeId).toBe("dracula");

    // Another palette update arrives while a theme is picked:
    const palette3 = {
      defaultForeground: "#cccccc",
      defaultBackground: "#181818",
      palette: ["#181818"],
    };
    renderer.setPaletteReport(palette3);
    signals.emit("SIGWINCH");
    await Bun.sleep(120);

    // Picked identity is retained!
    expect(controller.sessionThemeId).toBe("dracula");
    expect(controller.getSnapshot().themeId).toBe("dracula");
    expect(controller.getSnapshot().terminalColors?.background).toBe("#181818");

    // 5. Later native resolver returns null: native authority survives
    nativeModeResult = null;
    renderer.emit(CliRenderEvents.FOCUS);
    expect(controller.themeMode).toBe("light");

    // Terminal mode events cannot displace native authority
    renderer.emit(CliRenderEvents.THEME_MODE, "dark");
    expect(controller.themeMode).toBe("light");

    // 6. Disposal of watchers and suppression of in-flight palette replies
    let pendingPaletteResolve: ((val: unknown) => void) | undefined;
    let onProbeStart: (() => void) | undefined;
    const probeStarted = new Promise<void>((resolve) => {
      onProbeStart = resolve;
    });

    renderer.getPalette = () => {
      onProbeStart?.();
      return new Promise((resolve) => {
        pendingPaletteResolve = resolve;
      }) as never;
    };

    signals.emit("SIGWINCH");
    await Promise.race([
      probeStarted,
      Bun.sleep(1_000).then(() => Promise.reject(new Error("Probe did not start within timeout"))),
    ]);
    expect(pendingPaletteResolve).toBeDefined();

    const publicationsCountBefore = publications.length;
    const snapshotBefore = controller.getSnapshot();

    // Dispose while in flight
    stopLiveAppearance();
    stopColorWatcher();

    // Resolve in-flight reply after disposal
    pendingPaletteResolve!({
      defaultForeground: "#999999",
      defaultBackground: "#999999",
      palette: ["#999999"],
    });
    await Bun.sleep(120);

    // Publications, palette, selected/picked identity and authoritative mode remain unchanged
    expect(publications.length).toBe(publicationsCountBefore);
    expect(controller.getSnapshot().terminalColors?.background).toBe(
      snapshotBefore.terminalColors?.background,
    );
    expect(controller.getSnapshot().terminalColors?.foreground).toBe(
      snapshotBefore.terminalColors?.foreground,
    );
    expect(controller.sessionThemeId).toBe("dracula");
    expect(controller.getSnapshot().themeId).toBe("dracula");
    expect(controller.themeMode).toBe("light");
    expect(controller.getSnapshot().themeMode).toBe("light");

    // Verify listeners removed from renderer
    expect(renderer.listenerCount(CliRenderEvents.FOCUS)).toBe(0);
    expect(renderer.listenerCount(CliRenderEvents.THEME_MODE)).toBe(0);
  });
});
