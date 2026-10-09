import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { resolveSystemAppearanceMode } from "../../packages/hunk/src/core/theme/systemAppearance";
import {
  createTestTerminalResponder,
  TEST_TERMINAL_LIGHT_PALETTE_A,
  TEST_TERMINAL_LIGHT_PALETTE_B,
  TEST_TERMINAL_LIGHT_PALETTE_C,
  TEST_TERMINAL_PALETTE_A,
  TEST_TERMINAL_PALETTE_B,
  TEST_TERMINAL_PALETTE_C,
  waitForForegroundTest as waitForForeground,
} from "../helpers/terminalResponderTest";
import { createPtyHarness, sleep } from "./harness";

const nativeMode = resolveSystemAppearanceMode();
const nativeUnavailable = process.platform !== "darwin" || nativeMode === null;

const harness = createPtyHarness();

/** Give PTY startup and terminal appearance exchanges enough headroom on slower CI machines. */
setDefaultTimeout(30_000);

afterEach(() => {
  harness.cleanup();
});

/** Send one native notification plus the foreground and background colors OpenTUI queries. */
async function reportTerminalColors(
  session: Awaited<ReturnType<typeof harness.launchHunk>>,
  foreground: string,
  background: string,
) {
  session.writeRaw("\x1b[?997;2n");
  await sleep(10);
  session.writeRaw(`\x1b]10;rgb:${foreground}\x1b\\`);
  session.writeRaw(`\x1b]11;rgb:${background}\x1b\\`);
  await session.waitIdle({ timeout: 200 });
}

/** Report one unambiguous light or dark terminal appearance. */
async function reportTerminalAppearance(
  session: Awaited<ReturnType<typeof harness.launchHunk>>,
  mode: "light" | "dark",
) {
  const foreground = mode === "light" ? "0000/0000/0000" : "ffff/ffff/ffff";
  const background = mode === "light" ? "ffff/ffff/ffff" : "0000/0000/0000";
  await reportTerminalColors(session, foreground, background);
}

/** Open the selector and wait until one theme row is visibly active. */
async function activeThemeFrame(
  session: Awaited<ReturnType<typeof harness.launchHunk>>,
  themeId: string,
) {
  await session.press("t");
  return harness.waitForSnapshot(
    session,
    (text) =>
      text.split("\n").some((line) => line.includes(`›  ${themeId}`) && line.includes("active")),
    5_000,
  );
}

/** Resolve the theme expected after macOS authority or a terminal fallback. */
function expectedThemeId(terminalMode: "light" | "dark"): string {
  return (resolveSystemAppearanceMode() ?? terminalMode) === "light" ? "catppuccin-latte" : "nord";
}

describe("PTY live terminal theme", () => {
  test("OpenTUI emits focus after a terminal focus-in sequence", async () => {
    const fixtureEntrypoint = join(import.meta.dir, "fixtures", "focus-event.tsx");
    const session = await harness.launchShellCommand({
      command: [
        harness.shellQuote(process.execPath),
        "run",
        harness.shellQuote(fixtureEntrypoint),
      ].join(" "),
    });

    try {
      await session.waitForText("FOCUS_READY", { timeout: 15_000 });
      session.writeRaw("\x1b[I");
      await session.waitForText("FOCUS_RECEIVED", { timeout: 5_000 });
    } finally {
      session.close();
    }
  });

  test("terminal appearance notifications remain fallback-only after system authority", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const configHome = harness.createConfigHome(
      'theme = { light = "catppuccin-latte", dark = "nord" }\n',
    );
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 140,
      rows: 20,
      env: { XDG_CONFIG_HOME: configHome },
    });

    try {
      // Queue the startup OSC 11 response before Hunk's bounded first-paint probe completes.
      session.writeRaw("\x1b]11;rgb:ffff/ffff/ffff\x1b\\");
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      await session.press(".");
      await harness.waitForSnapshot(session, (text) => text.includes("betaValue"), 5_000);

      let expectedTheme = expectedThemeId("light");
      let frame = await activeThemeFrame(session, expectedTheme);
      expect(frame).toContain(expectedTheme);
      await session.press("escape");
      await harness.waitForSnapshot(session, (text) => text.includes("betaValue"), 5_000);

      await reportTerminalAppearance(session, "dark");
      expectedTheme = expectedThemeId("dark");
      frame = await activeThemeFrame(session, expectedTheme);
      expect(frame).toContain(expectedTheme);
      await session.press("escape");
      await harness.waitForSnapshot(session, (text) => text.includes("betaValue"), 5_000);

      await reportTerminalAppearance(session, "light");
      expectedTheme = expectedThemeId("light");
      frame = await activeThemeFrame(session, expectedTheme);
      expect(frame).toContain(expectedTheme);
      await session.press("escape");
      await harness.waitForSnapshot(session, (text) => text.includes("betaValue"), 5_000);
    } finally {
      session.close();
    }
  });

  test("OpenTUI's live classifier remains fallback-only at a startup-boundary color", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const configHome = harness.createConfigHome(
      'theme = { light = "catppuccin-latte", dark = "nord" }\n',
    );
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 140,
      rows: 20,
      env: { XDG_CONFIG_HOME: configHome },
    });

    try {
      session.writeRaw("\x1b]11;rgb:ffff/ffff/ffff\x1b\\");
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });

      // Establish OpenTUI's light mode, then report #00b0e0: OpenTUI stays light while Hunk's
      // startup relative-luminance classifier deliberately names the same boundary color dark.
      await reportTerminalAppearance(session, "light");
      await reportTerminalColors(session, "0000/0000/0000", "0000/b0b0/e0e0");
      let expectedTheme = expectedThemeId("light");
      let frame = await activeThemeFrame(session, expectedTheme);
      expect(frame).toContain(expectedTheme);
      await session.press("escape");

      await reportTerminalAppearance(session, "dark");
      expectedTheme = expectedThemeId("dark");
      frame = await activeThemeFrame(session, expectedTheme);
      expect(frame).toContain(expectedTheme);
    } finally {
      session.close();
    }
  });

  test("quit after an appearance switch offers no save prompt", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const configHome = harness.createConfigHome(
      'theme = { light = "catppuccin-latte", dark = "nord" }\nprompt_save_view_preferences = true\n',
    );
    // Start on the member macOS is not showing, so macOS startup authority or the terminal report
    // below must switch away from the startup member the quit prompt compares against.
    const startupMode = resolveSystemAppearanceMode() === "light" ? "dark" : "light";
    const startupTheme = startupMode === "light" ? "catppuccin-latte" : "nord";
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 140,
      rows: 20,
      env: { XDG_CONFIG_HOME: configHome },
    });

    try {
      const startupBackground = startupMode === "light" ? "ffff/ffff/ffff" : "0000/0000/0000";
      session.writeRaw(`\x1b]11;rgb:${startupBackground}\x1b\\`);
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      await session.press(".");
      await harness.waitForSnapshot(session, (text) => text.includes("betaValue"), 5_000);

      await reportTerminalAppearance(session, "dark");
      const expectedTheme = expectedThemeId("dark");
      expect(expectedTheme).not.toBe(startupTheme);
      const frame = await activeThemeFrame(session, expectedTheme);
      expect(frame).toContain(expectedTheme);
      await session.press("escape");
      await harness.waitForSnapshot(session, (text) => text.includes("betaValue"), 5_000);

      await session.press("q");
      const exited = await session.waitForExit(5_000);
      if (!exited) expect(await session.text()).not.toContain("Save view preferences?");
      expect(exited).toBe(true);
    } finally {
      session.close();
    }
  });

  test.skipIf(nativeUnavailable)(
    "distinct pair with terminal in native active member preserves native authority against opposing mode, repaints from actual palette updates, retaining hunk and scroll without save prompt",
    async () => {
      const oppositeBuiltIn = nativeMode === "light" ? "nord" : "catppuccin-latte";
      const pairConfig =
        nativeMode === "light"
          ? 'theme = { light = "terminal", dark = "nord" }\n'
          : 'theme = { light = "catppuccin-latte", dark = "terminal" }\n';

      const paletteA =
        nativeMode === "light" ? TEST_TERMINAL_PALETTE_A : TEST_TERMINAL_LIGHT_PALETTE_A;
      const paletteB =
        nativeMode === "light" ? TEST_TERMINAL_PALETTE_B : TEST_TERMINAL_LIGHT_PALETTE_B;
      const paletteC =
        nativeMode === "light" ? TEST_TERMINAL_PALETTE_C : TEST_TERMINAL_LIGHT_PALETTE_C;
      const oppositeCode = nativeMode === "light" ? 1 : 2;

      const fixture = harness.createMultiHunkFilePair();
      const configHome = harness.createConfigHome(
        `${pairConfig}prompt_save_view_preferences = true\n`,
      );
      const terminal = createTestTerminalResponder(paletteA);
      const session = await harness.launchHunk({
        args: ["diff", "--files", fixture.before, fixture.after, "--mode", "unified"],
        cwd: fixture.dir,
        cols: 140,
        rows: 24,
        env: { XDG_CONFIG_HOME: configHome },
        testTerminalResponder: terminal.respond,
      });

      try {
        await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
        await session.waitForText("line1", { timeout: 5_000 });

        // Ensure keyboard is live before sending navigation key
        await harness.ensureKeyboardIsLive(session);

        // Jump to hunk 2 and wait for actual destination (line1 scrolled out of view and added line60 present)
        await harness.pressAndWaitForSnapshot(
          session,
          "]",
          (text) =>
            text.includes("export const line60 = 6000;") &&
            !text.includes("export const line1 = 100;"),
          5_000,
        );

        // Wait for initial palette A foreground to paint context line 58
        expect(await waitForForeground(session, paletteA.foreground, "line58")).toContain("line58");

        // Verify initial active theme is terminal and cancel back to review
        let frame = await activeThemeFrame(session, "terminal");
        expect(frame).toContain("terminal");
        await session.press("escape");

        const isSettledHunk2Geometry = (text: string) => {
          if (text.includes("Theme selector")) return false;
          const lines = text.split("\n");
          const l58 = lines.findIndex((line) => line.includes("export const line58 = 58;"));
          const l60 = lines.findIndex((line) => line.includes("export const line60 = 6000;"));
          return (
            l58 >= 0 &&
            l60 >= 0 &&
            l60 > l58 &&
            !text.includes("export const line1 = 100;") &&
            !text.includes("line1 = 100")
          );
        };

        const waitForSettledHunk2 = async () => {
          const start = Date.now();
          let prevText = "";
          let consecutiveMatches = 0;
          while (Date.now() - start < 5_000) {
            const currentText = await session.text({ immediate: true });
            if (isSettledHunk2Geometry(currentText)) {
              if (currentText === prevText) {
                consecutiveMatches += 1;
                if (consecutiveMatches >= 2) {
                  return currentText;
                }
              } else {
                prevText = currentText;
                consecutiveMatches = 1;
              }
            } else {
              prevText = "";
              consecutiveMatches = 0;
            }
            await session.waitIdle({ timeout: 50 });
            await sleep(25);
          }
          throw new Error("Timed out waiting for settled second hunk geometry");
        };

        // Capture baseline geometry from settled review
        const initialSnapshot = await waitForSettledHunk2();
        const initialLines = initialSnapshot.split("\n");
        const anchorRow = initialLines.findIndex((line) =>
          line.includes("export const line58 = 58;"),
        );
        const hunkIndicatorRow = initialLines.findIndex((line) =>
          line.includes("export const line60 = 6000;"),
        );
        expect(anchorRow).toBeGreaterThanOrEqual(0);
        expect(hunkIndicatorRow).toBeGreaterThanOrEqual(0);

        // Change responder A -> B and notify opposing color scheme
        terminal.setPalette(paletteB);
        session.writeRaw(`\x1b[?997;${oppositeCode}n`);

        // Wait for actual exact foreground color change on context line 58
        expect(await waitForForeground(session, paletteB.foreground, "line58")).toContain("line58");

        // Assert old color no longer paints anchor
        expect(
          await session.text({ immediate: true, only: { foreground: paletteA.foreground } }),
        ).not.toContain("line58");

        // Terminal is still active despite opposing classification, and opposite built-in is not active
        frame = await activeThemeFrame(session, "terminal");
        expect(frame).toContain("terminal");
        expect(frame).not.toContain(`›  ${oppositeBuiltIn} (active)`);
        expect(frame).not.toContain(`✓  ${oppositeBuiltIn} (active)`);
        await session.press("escape");
        const snapshotB = await waitForSettledHunk2();

        // Assert identical hunk and viewport line indices are preserved after palette B
        const linesB = snapshotB.split("\n");
        expect(linesB.findIndex((line) => line.includes("export const line58 = 58;"))).toBe(
          anchorRow,
        );
        expect(linesB.findIndex((line) => line.includes("export const line60 = 6000;"))).toBe(
          hunkIndicatorRow,
        );

        // Change to same-mode fresh palette C and assert actual colors repaint again
        terminal.setPalette(paletteC);
        session.writeRaw(`\x1b[?997;${oppositeCode}n`);
        expect(await waitForForeground(session, paletteC.foreground, "line58")).toContain("line58");
        expect(
          await session.text({ immediate: true, only: { foreground: paletteB.foreground } }),
        ).not.toContain("line58");

        frame = await activeThemeFrame(session, "terminal");
        expect(frame).toContain("terminal");
        expect(frame).not.toContain(`›  ${oppositeBuiltIn} (active)`);
        expect(frame).not.toContain(`✓  ${oppositeBuiltIn} (active)`);
        await session.press("escape");
        const snapshotC = await waitForSettledHunk2();

        // Assert identical hunk and viewport line indices are preserved after palette C
        const linesC = snapshotC.split("\n");
        expect(linesC.findIndex((line) => line.includes("export const line58 = 58;"))).toBe(
          anchorRow,
        );
        expect(linesC.findIndex((line) => line.includes("export const line60 = 6000;"))).toBe(
          hunkIndicatorRow,
        );

        // Quit cleanly without save prompt
        await session.press("q");
        const exited = await session.waitForExit(5_000);
        if (!exited) expect(await session.text()).not.toContain("Save view preferences?");
        expect(exited).toBe(true);
      } finally {
        session.close();
      }
    },
  );

  test.skipIf(nativeUnavailable)(
    "pair with terminal in native active member preserves native authority against opposing mode, retains picker preview, and exits clean",
    async () => {
      const oppositeBuiltIn = nativeMode === "light" ? "nord" : "catppuccin-latte";
      const pairConfig =
        nativeMode === "light"
          ? 'theme = { light = "terminal", dark = "nord" }\n'
          : 'theme = { light = "catppuccin-latte", dark = "terminal" }\n';

      const paletteA =
        nativeMode === "light" ? TEST_TERMINAL_PALETTE_A : TEST_TERMINAL_LIGHT_PALETTE_A;
      const paletteB =
        nativeMode === "light" ? TEST_TERMINAL_PALETTE_B : TEST_TERMINAL_LIGHT_PALETTE_B;
      const oppositeCode = nativeMode === "light" ? 1 : 2;

      const fixture = harness.createMultiHunkFilePair();
      const configHome = harness.createConfigHome(
        `${pairConfig}prompt_save_view_preferences = true\n`,
      );
      const terminal = createTestTerminalResponder(paletteA);
      const session = await harness.launchHunk({
        args: ["diff", "--files", fixture.before, fixture.after, "--mode", "unified"],
        cwd: fixture.dir,
        cols: 140,
        rows: 24,
        env: { XDG_CONFIG_HOME: configHome },
        testTerminalResponder: terminal.respond,
      });

      try {
        await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
        await session.waitForText("line1", { timeout: 5_000 });

        // Initial active theme is "terminal"
        let frame = await activeThemeFrame(session, "terminal");
        expect(frame).toContain("terminal");

        // Move one choice in selector to preview another theme
        await session.press("down");
        await sleep(100);

        // Capture exact preview ID from selected row
        const previewSnapshot = await session.text({ immediate: true });
        expect(previewSnapshot).toContain("Theme selector");
        const selectedLine = previewSnapshot.split("\n").find((line) => line.includes("›  "));
        expect(selectedLine).toBeDefined();
        const previewIdMatch = selectedLine!.match(/›\s+([\w-]+)/);
        expect(previewIdMatch).not.toBeNull();
        const previewId = previewIdMatch![1];
        expect(previewId).not.toBe("terminal");

        // Re-probe palette while preview is active
        terminal.setPalette(paletteB);
        session.writeRaw(`\x1b[?997;${oppositeCode}n`);
        await sleep(250);

        // Assert same exact preview ID remains selected after palette reprobe (not just dialog open)
        const afterReprobeSnapshot = await session.text({ immediate: true });
        expect(afterReprobeSnapshot).toContain("Theme selector");
        const afterSelectedLine = afterReprobeSnapshot
          .split("\n")
          .find((line) => line.includes("›  "));
        expect(afterSelectedLine).toBeDefined();
        expect(afterSelectedLine).toContain(`›  ${previewId}`);

        // Cancelling restores terminal with latest actual palette
        await session.press("escape");
        await harness.waitForSnapshot(session, (text) => !text.includes("Theme selector"), 5_000);

        // Terminal restored with palette B
        expect(await waitForForeground(session, paletteB.foreground, "line1")).toContain("line1");

        // Active theme remains terminal and opposite built-in is not active
        frame = await activeThemeFrame(session, "terminal");
        expect(frame).toContain("terminal");
        expect(frame).not.toContain(`›  ${oppositeBuiltIn} (active)`);
        await session.press("escape");

        // Clean exit without save prompt
        await session.press("q");
        const exited = await session.waitForExit(5_000);
        if (!exited) expect(await session.text()).not.toContain("Save view preferences?");
        expect(exited).toBe(true);
      } finally {
        session.close();
      }
    },
  );
});
