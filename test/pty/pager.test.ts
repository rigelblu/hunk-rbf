import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "tuistory";
import { resolveSystemAppearanceMode } from "../../src/core/systemAppearance";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

/** Give PTY-backed startup, redraws, and wheel retries enough headroom for slower CI machines. */
setDefaultTimeout(45_000);

afterEach(() => {
  harness.cleanup();
});

/** Retry PTY wheel ticks one at a time so slow CI does not drop a whole scroll burst. */
async function scrollWheelUntil(
  session: Session,
  direction: "down" | "up",
  predicate: (text: string) => boolean,
) {
  let lastErrorMessage = `Timed out waiting for pager wheel scroll ${direction}.`;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (direction === "down") {
      await session.scrollDown(1);
    } else {
      await session.scrollUp(1);
    }

    try {
      return await harness.waitForSnapshot(session, predicate, 700);
    } catch (error) {
      lastErrorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(lastErrorMessage);
}

/** Mirror production startup authority while retaining terminal coverage on non-macOS hosts. */
function expectedStartupTheme(
  terminalMode: "light" | "dark",
  themes: { light: string; dark: string },
): string {
  return themes[resolveSystemAppearanceMode() ?? terminalMode];
}

describe("PTY pager", () => {
  test("pager mode hides chrome and pages forward on space", async () => {
    const fixture = harness.createPagerPatchFixture();
    const session = await harness.launchHunk({
      args: ["patch", fixture.patchFile, "--pager"],
      cols: 120,
      rows: 20,
    });

    try {
      const initial = await session.waitForText(/scroll\.ts/, { timeout: 15_000 });

      expect(initial).not.toContain("View  Navigate  Agent  Help");
      expect(initial).toContain("before_01");
      expect(initial).not.toContain("before_23");

      // CI can surface the pager header before the first page is fully ready to consume keys.
      await session.waitIdle({ timeout: 200 });
      await session.press("space");
      const paged = await harness.waitForSnapshot(
        session,
        (text) => text.includes("before_23") || text.includes("after_06"),
        5_000,
      );

      expect(paged).not.toContain("View  Navigate  Agent  Help");
      expect(paged).toContain("before_23");
    } finally {
      session.close();
    }
  });

  test("pager mode handles half-page, page-up, and content-jump keyboard navigation", async () => {
    const fixture = harness.createPagerPatchFixture(60);
    const session = await harness.launchHunk({
      args: ["patch", fixture.patchFile, "--pager"],
      cols: 120,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/scroll\.ts/, { timeout: 15_000 });

      expect(initial).toContain("before_01");
      expect(initial).not.toContain("before_12");

      await session.press("d");
      const halfPaged = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("before_01"),
        5_000,
      );

      expect(halfPaged).not.toContain("before_01");

      await session.press("u");
      const halfPageRestored = await harness.waitForSnapshot(
        session,
        (text) => text.includes("before_01"),
        5_000,
      );

      expect(halfPageRestored).toContain("before_01");

      await session.press("space");
      const paged = await harness.waitForSnapshot(
        session,
        (text) => text.includes("before_18") || text.includes("after_02"),
        5_000,
      );

      expect(paged.includes("before_18") || paged.includes("after_02")).toBe(true);

      await session.press("b");
      const pageRestored = await harness.waitForSnapshot(
        session,
        (text) => text.includes("before_01") && !text.includes("after_02"),
        5_000,
      );

      expect(pageRestored).toContain("before_01");
      expect(pageRestored).not.toContain("after_02");

      await session.press("end");
      const bottom = await harness.waitForSnapshot(
        session,
        (text) => text.includes("after_60"),
        5_000,
      );

      expect(bottom).toContain("after_60");

      await session.press("home");
      const top = await harness.waitForSnapshot(
        session,
        (text) => text.includes("before_01") && !text.includes("after_60"),
        5_000,
      );

      expect(top).toContain("before_01");
      expect(top).not.toContain("after_60");
    } finally {
      session.close();
    }
  });

  test("piped stdin still allows concrete-theme app startup to read terminal input", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchShellCommand({
      command: `printf ignored | ${harness.buildHunkCommand(["diff", "--theme", "github-dark-default"])}`,
      cwd: fixture.dir,
      cols: 120,
      rows: 14,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });
      expect(initial).toContain("alpha.ts");

      await session.press("q");
      await session.waitIdle({ timeout: 500 });
    } finally {
      session.close();
    }
  });

  test("stdin patch mode enables mouse wheel scrolling in pager UI", async () => {
    const fixture = harness.createPagerPatchFixture(60);
    const session = await harness.launchHunkWithFileBackedStdin({
      stdinFile: fixture.patchFile,
      args: ["patch", "-"],
      cols: 120,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/scroll\.ts/, { timeout: 15_000 });

      expect(initial).not.toContain("View  Navigate  Agent  Help");
      expect(initial).toContain("before_01");
      expect(initial).not.toContain("before_12");

      await session.waitIdle({ timeout: 200 });
      const scrolled = await scrollWheelUntil(
        session,
        "down",
        (text) => !text.includes("before_01") && text.includes("before_12"),
      );

      expect(scrolled).not.toContain("View  Navigate  Agent  Help");
      expect(scrolled).not.toContain("before_01");
      expect(scrolled).toContain("before_12");

      const restored = await scrollWheelUntil(
        session,
        "up",
        (text) => text.includes("before_01") && !text.includes("before_12"),
      );

      expect(restored).toContain("before_01");
      expect(restored).not.toContain("before_12");
    } finally {
      session.close();
    }
  });

  test("stdin patch auto theme still enables mouse wheel scrolling", async () => {
    const fixture = harness.createPagerPatchFixture(60);
    const session = await harness.launchHunkWithFileBackedStdin({
      stdinFile: fixture.patchFile,
      args: ["patch", "-", "--theme", "auto"],
      cols: 120,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/scroll\.ts/, { timeout: 15_000 });

      expect(initial).toContain("before_01");
      expect(initial).not.toContain("before_12");

      await session.waitIdle({ timeout: 200 });
      const scrolled = await scrollWheelUntil(
        session,
        "down",
        (text) => !text.includes("before_01") && text.includes("before_12"),
      );

      expect(scrolled).toContain("before_12");
    } finally {
      session.close();
    }
  });

  test.each([
    ["light", "\x1b]11;rgb:ffff/ffff/ffff\x1b\\"],
    ["dark", "\x1b]11;rgb:0000/0000/0000\x1b\\"],
  ] as const)(
    "paired configured themes honor startup authority for a %s terminal",
    async (mode, response) => {
      const fixture = harness.createPagerPatchFixture();
      const themeId = expectedStartupTheme(mode, {
        light: "catppuccin-latte",
        dark: "nord",
      });
      const configHome = join(fixture.dir, "config");
      mkdirSync(join(configHome, "hunk"), { recursive: true });
      writeFileSync(
        join(configHome, "hunk", "config.toml"),
        'theme = { light = "catppuccin-latte", dark = "nord" }\n',
      );
      const session = await harness.launchHunk({
        args: ["patch", fixture.patchFile],
        cwd: fixture.dir,
        cols: 140,
        rows: 24,
        env: { XDG_CONFIG_HOME: configHome },
      });

      try {
        // Queue the terminal's OSC 11 reply immediately so startup consumes it during its bounded probe.
        session.writeRaw(response);
        await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
        await session.press("t");
        const modal = await harness.waitForSnapshot(
          session,
          (text) =>
            text
              .split("\n")
              .some((line) => line.includes(`›  ${themeId}`) && line.includes("active")),
          5_000,
        );

        expect(
          modal
            .split("\n")
            .some((line) => line.includes(`›  ${themeId}`) && line.includes("active")),
        ).toBe(true);
      } finally {
        session.close();
      }
    },
  );

  test.each([
    ["light", "\x1b]11;rgb:ffff/ffff/ffff\x1b\\"],
    ["dark", "\x1b]11;rgb:0000/0000/0000\x1b\\"],
  ] as const)(
    "named custom theme pairs honor startup authority for a %s terminal",
    async (mode, response) => {
      const fixture = harness.createPagerPatchFixture();
      const label = expectedStartupTheme(mode, { light: "My Light", dark: "My Dark" });
      const configHome = join(fixture.dir, "config");
      mkdirSync(join(configHome, "hunk"), { recursive: true });
      writeFileSync(
        join(configHome, "hunk", "config.toml"),
        [
          'theme = { light = "my-light", dark = "my-dark" }',
          "",
          "[custom_themes.my-light]",
          'base = "github-light-default"',
          'label = "My Light"',
          "",
          "[custom_themes.my-dark]",
          'base = "github-dark-default"',
          'label = "My Dark"',
        ].join("\n"),
      );
      const session = await harness.launchHunk({
        args: ["patch", fixture.patchFile],
        cwd: fixture.dir,
        cols: 140,
        rows: 24,
        env: { XDG_CONFIG_HOME: configHome },
      });

      try {
        session.writeRaw(response);
        await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
        await session.press("t");
        const modal = await harness.waitForSnapshot(
          session,
          (text) =>
            text
              .split("\n")
              .some((line) => line.includes(`›  ${label}`) && line.includes("active")),
          5_000,
        );

        expect(
          modal.split("\n").some((line) => line.includes(`›  ${label}`) && line.includes("active")),
        ).toBe(true);
      } finally {
        session.close();
      }
    },
  );

  test("paired config keeps file-backed patch stdin interactive", async () => {
    const fixture = harness.createPagerPatchFixture();
    const configHome = join(fixture.dir, "config");
    mkdirSync(join(configHome, "hunk"), { recursive: true });
    writeFileSync(
      join(configHome, "hunk", "config.toml"),
      'theme = { light = "catppuccin-latte", dark = "nord" }\n',
    );
    const session = await harness.launchHunkWithFileBackedStdin({
      stdinFile: fixture.patchFile,
      args: ["patch", "-"],
      cwd: fixture.dir,
      cols: 120,
      rows: 14,
      env: { XDG_CONFIG_HOME: configHome },
    });

    try {
      session.writeRaw("\x1b]11;rgb:0000/0000/0000\x1b\\");
      const initial = await session.waitForText(/scroll\.ts/, { timeout: 15_000 });
      expect(initial).toContain("before_01");

      await session.waitIdle({ timeout: 200 });
      await session.press("s");
      const sidebarRow = /\bM scroll\.ts\s+\+40 -40/;
      const withSidebar = await harness.waitForSnapshot(
        session,
        (text) => sidebarRow.test(text),
        5_000,
      );
      expect(withSidebar).toMatch(sidebarRow);
    } finally {
      session.close();
    }
  });

  test("general pager mode enables mouse wheel scrolling for diff-like stdin", async () => {
    const fixture = harness.createPagerPatchFixture(60);
    const session = await harness.launchHunkWithFileBackedStdin({
      stdinFile: fixture.patchFile,
      args: ["pager"],
      cols: 120,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/scroll\.ts/, { timeout: 15_000 });

      expect(initial).not.toContain("View  Navigate  Agent  Help");
      expect(initial).toContain("before_01");
      expect(initial).not.toContain("before_12");

      await session.waitIdle({ timeout: 200 });
      const scrolled = await scrollWheelUntil(
        session,
        "down",
        (text) => !text.includes("before_01") && text.includes("before_12"),
      );

      expect(scrolled).not.toContain("View  Navigate  Agent  Help");
      expect(scrolled).not.toContain("before_01");
      expect(scrolled).toContain("before_12");

      const restored = await scrollWheelUntil(
        session,
        "up",
        (text) => text.includes("before_01") && !text.includes("before_12"),
      );

      expect(restored).toContain("before_01");
      expect(restored).not.toContain("before_12");
    } finally {
      session.close();
    }
  });

  test("general pager mode can display the sidebar file tree", async () => {
    const fixture = harness.createPagerPatchFixture();
    const session = await harness.launchHunkWithFileBackedStdin({
      stdinFile: fixture.patchFile,
      args: ["pager"],
      cols: 120,
      rows: 14,
    });

    try {
      const initial = await session.waitForText(/scroll\.ts/, { timeout: 15_000 });

      expect(initial).not.toContain("View  Navigate  Agent  Help");
      expect(harness.countMatches(initial, /scroll\.ts/g)).toBe(1);

      // CI can surface the pager content before the file-backed stdin path is ready for keys.
      await session.waitIdle({ timeout: 200 });
      await session.press("s");
      const sidebarRow = /\bM scroll\.ts\s+\+40 -40/;
      const withSidebar = await harness.waitForSnapshot(
        session,
        (text) => sidebarRow.test(text),
        5_000,
      );

      expect(withSidebar).not.toContain("View  Navigate  Agent  Help");
      expect(withSidebar).toMatch(sidebarRow);
    } finally {
      session.close();
    }
  });

  test("explicit pager mode still supports mouse wheel scrolling on a TTY", async () => {
    const fixture = harness.createPagerPatchFixture(60);
    const session = await harness.launchHunk({
      args: ["patch", fixture.patchFile, "--pager"],
      cols: 120,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/scroll\.ts/, { timeout: 15_000 });

      expect(initial).not.toContain("View  Navigate  Agent  Help");
      expect(initial).toContain("before_01");
      expect(initial).not.toContain("before_12");

      await session.waitIdle({ timeout: 200 });
      const scrolled = await scrollWheelUntil(
        session,
        "down",
        (text) => !text.includes("before_01") && text.includes("before_12"),
      );

      expect(scrolled).not.toContain("View  Navigate  Agent  Help");
      expect(scrolled).not.toContain("before_01");
      expect(scrolled).toContain("before_12");

      const restored = await scrollWheelUntil(
        session,
        "up",
        (text) => text.includes("before_01") && !text.includes("before_12"),
      );

      expect(restored).toContain("before_01");
      expect(restored).not.toContain("before_12");
    } finally {
      session.close();
    }
  });
});
