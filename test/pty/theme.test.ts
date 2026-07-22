import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { resolveSystemAppearanceMode } from "../../src/core/systemAppearance";
import { createPtyHarness, sleep } from "./harness";

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
});
