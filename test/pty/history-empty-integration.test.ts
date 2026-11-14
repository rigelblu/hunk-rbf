import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPtyHarness } from "./harness";
import { resolveTheme } from "../../packages/hunk/src/ui/themes";
import { resolveHistoryTitlePalette } from "../../packages/hunk/src/ui/history/titlePalette";

const harness = createPtyHarness();
const tempDirs: string[] = [];
const jjTest = Bun.which("jj") ? test : test.skip;
setDefaultTimeout(45_000);

/** Run a JJ command only in a disposable test repository. */
function runTestJj(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(
    [
      "jj",
      "--config",
      'user.name="Empty History Tester"',
      "--config",
      'user.email="empty@example.invalid"',
      ...args,
    ],
    { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

/** Create described and undescribed empty ancestors beside one changed revision. */
function createEmptyHistoryTestRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "hunk-empty-history-"));
  tempDirs.push(cwd);
  runTestJj(cwd, "git", "init", "--no-colocate");
  runTestJj(cwd, "new");
  writeFileSync(join(cwd, "base.txt"), "base\n");
  runTestJj(cwd, "commit", "-m", "Changed revision");
  runTestJj(cwd, "describe", "-m", "Empty revision");
  return cwd;
}

afterEach(async () => {
  await harness.cleanup();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("PTY known-empty JJ history", () => {
  jjTest("renders yellow labels on selected and ordinary rows and honors color never", async () => {
    const cwd = createEmptyHistoryTestRepo();
    const theme = resolveTheme("github-dark-default", "dark");
    for (const color of ["always", "never"]) {
      const session = await harness.launchHunk({
        args: [
          "log",
          "--vcs",
          "jj",
          "--all",
          "--no-extensions",
          "--theme",
          theme.id,
          "--color",
          color,
        ],
        cwd,
        cols: 80,
        rows: 24,
      });
      try {
        await harness.waitForSnapshot(
          session,
          (text) =>
            text.includes("(empty) Empty revision") && text.includes("(no description set)"),
          15_000,
        );
        if (color === "always") {
          const selected = resolveHistoryTitlePalette(theme, theme.selectedHunk);
          const ordinary = resolveHistoryTitlePalette(theme);
          expect(await session.text({ only: { foreground: selected.empty } })).toContain("(empty)");
          expect(await session.text({ only: { foreground: ordinary.undescribed } })).toContain(
            "(no description set)",
          );
          expect(await session.text({ only: { foreground: selected.empty } })).not.toContain(
            "Empty revision",
          );
          await session.press("down");
          await session.waitIdle();
          expect(await session.text({ only: { foreground: selected.undescribed } })).toContain(
            "(no description set)",
          );
        } else {
          const screen = await session.text({ only: { foreground: "#ffffff" } });
          expect(screen).toContain("(empty) Empty revision");
          expect(screen).toContain("(no description set)");
        }
        await session.press("q");
      } finally {
        session.close();
      }
    }
  });
  jjTest(
    "keeps narrow labels visible with graph, ASCII and refs controls independent",
    async () => {
      const cwd = createEmptyHistoryTestRepo();
      const configHome = mkdtempSync(join(tmpdir(), "hunk-empty-controls-"));
      tempDirs.push(configHome);
      mkdirSync(join(configHome, "hunk"));
      writeFileSync(
        join(configHome, "hunk", "config.toml"),
        '[keybindings]\n"hunk.history.toggleDecorations" = "d"\n"hunk.history.toggleGraph" = "g"\n"hunk.history.toggleUnicode" = "u"\n',
      );
      const session = await harness.launchHunk({
        args: ["log", "--vcs", "jj", "--all", "--no-extensions"],
        cwd,
        cols: 40,
        rows: 18,
        env: { XDG_CONFIG_HOME: configHome },
      });
      try {
        await session.waitForText(/\(empty\) Empty/, { timeout: 15_000 });
        const controls = [
          { key: "d", changed: (text: string) => !text.includes("(@)") },
          { key: "g", changed: (text: string) => text.includes("●") },
          { key: "u", changed: (text: string) => text.includes("*") },
          { key: "d", changed: (text: string) => text.includes("(@)") },
        ] as const;
        for (const control of controls) {
          const screen = await harness.pressAndWaitForSnapshot(
            session,
            control.key,
            (text) =>
              control.changed(text) &&
              text.includes("(empty) Empty") &&
              text.includes("Changed revision"),
            5_000,
          );
          expect(screen.split("\n").filter((line) => line.includes("(empty)")).length).toBe(2);
          expect(
            screen.split("\n").find((line) => line.includes("Changed revision")),
          ).not.toContain("(empty)");
        }
        await session.press("q");
      } finally {
        session.close();
      }
    },
  );

  jjTest(
    "updates emptiness on manual and opted-in refresh while preserving ID copying",
    async () => {
      const cwd = createEmptyHistoryTestRepo();
      const session = await harness.launchHunk({
        args: ["log", "--vcs", "jj", "--all", "--no-extensions"],
        cwd,
        cols: 80,
        rows: 18,
      });
      try {
        await session.waitForText(/\(empty\) Empty revision/, { timeout: 15_000 });
        const revisionId = runTestJj(
          cwd,
          "--ignore-working-copy",
          "log",
          "--no-graph",
          "-r",
          "@",
          "-T",
          "self.commit_id()",
        ).trim();
        const beforeCopy = session.getRawOutput().length;
        await harness.pressAndWaitForText(session, "y", /Copied [k-z]{8}/, { timeout: 5_000 });
        expect(session.getRawOutput().slice(beforeCopy)).toContain(
          Buffer.from(revisionId).toString("base64"),
        );

        writeFileSync(join(cwd, "base.txt"), "changed\n");
        runTestJj(cwd, "status");
        const changed = await harness.pressAndWaitForSnapshot(
          session,
          "r",
          (text) =>
            text.includes("History refreshed") &&
            text.includes("Empty revision") &&
            !text.includes("(empty) Empty revision"),
          15_000,
        );
        expect(changed).toContain("Changed revision");
        writeFileSync(join(cwd, "base.txt"), "base\n");
        runTestJj(cwd, "status");
        await harness.pressAndWaitForText(session, "r", /\(empty\) Empty revision/, {
          timeout: 15_000,
        });

        await harness.pressAndWaitForText(session, "f10", /Auto-refresh history: off/, {
          timeout: 5_000,
        });
        await session.press(["down", "down", "down", "enter"]);
        await session.press("f10");
        await session.waitForText(/Auto-refresh history: on/, { timeout: 5_000 });
        await session.press("escape");
        writeFileSync(join(cwd, "base.txt"), "auto-changed\n");
        runTestJj(cwd, "status");
        await harness.waitForSnapshot(
          session,
          (text) =>
            text.includes("History refreshed") &&
            text.includes("Empty revision") &&
            !text.includes("(empty) Empty revision"),
          15_000,
        );
        writeFileSync(join(cwd, "base.txt"), "base\n");
        runTestJj(cwd, "status");
        await session.waitForText(/\(empty\) Empty revision/, { timeout: 15_000 });
        await session.press("q");
      } finally {
        session.close();
      }
    },
  );
});
