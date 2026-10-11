import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "tuistory";
import { createPtyHarness, rightmostColumnOf, rowCellBackgrounds, sleep } from "./harness";

const harness = createPtyHarness();
const tempDirs: string[] = [];
setDefaultTimeout(45_000);

/** Run one Git fixture command with deterministic author identity. */
function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "History Tester",
      GIT_AUTHOR_EMAIL: "history@example.com",
      GIT_COMMITTER_NAME: "History Tester",
      GIT_COMMITTER_EMAIL: "history@example.com",
      ...env,
    },
  });
  if (proc.exitCode !== 0) throw new Error(proc.stderr?.toString() ?? "Git fixture failed.");
}

/** Return from review only after history-specific chrome replaces the shared commit title. */
async function returnToHistory(session: Session) {
  return harness.pressAndWaitForSnapshot(
    session,
    "q",
    (text) => text.includes("Git history") && text.includes("Enter open"),
    15_000,
  );
}

/** Create two commits whose selected diff is visible in ordinary Hunk review. */
function createHistoryRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "hunk-log-pty-"));
  tempDirs.push(cwd);
  git(cwd, ["init", "-q"]);
  writeFileSync(join(cwd, "history.ts"), "export const historyValue = 'first';\n");
  writeFileSync(join(cwd, "root-only.ts"), "export const rootOnly = true;\n");
  git(cwd, ["add", "history.ts", "root-only.ts"]);
  const firstDate = new Date(2026, 8, 5, 12).toISOString();
  git(cwd, ["commit", "-qm", "First history commit"], {
    GIT_AUTHOR_DATE: firstDate,
    GIT_COMMITTER_DATE: firstDate,
  });
  writeFileSync(join(cwd, "history.ts"), "export const historyValue = 'second';\n");
  const secondDate = new Date(2026, 8, 6, 12).toISOString();
  git(cwd, ["commit", "-qam", "Second history commit", "-m", "Responsive description"], {
    GIT_AUTHOR_DATE: secondDate,
    GIT_COMMITTER_DATE: secondDate,
  });
  return cwd;
}

/** Create a merge whose second-parent comparison exposes only the main-side file. */
function createMergeHistoryRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "hunk-log-merge-pty-"));
  tempDirs.push(cwd);
  git(cwd, ["init", "-q"]);
  writeFileSync(join(cwd, "base.ts"), "export const base = true;\n");
  git(cwd, ["add", "base.ts"]);
  git(cwd, ["commit", "-qm", "Root"]);
  const defaultBranch = Bun.spawnSync(["git", "branch", "--show-current"], {
    cwd,
    stdout: "pipe",
  })
    .stdout.toString()
    .trim();
  git(cwd, ["checkout", "-qb", "side"]);
  writeFileSync(join(cwd, "side.ts"), "export const side = true;\n");
  git(cwd, ["add", "side.ts"]);
  git(cwd, ["commit", "-qm", "Side"]);
  git(cwd, ["checkout", "-q", defaultBranch]);
  writeFileSync(join(cwd, "main.ts"), "export const main = true;\n");
  git(cwd, ["add", "main.ts"]);
  git(cwd, ["commit", "-qm", "Main"]);
  git(cwd, ["merge", "--no-ff", "-qm", "Merge side", "side"]);
  return cwd;
}

afterEach(() => {
  harness.cleanup();
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("direct revision reviews", () => {
  test("shows commit information for hunk show", async () => {
    const cwd = createHistoryRepo();
    const session = await harness.launchHunk({
      args: ["show", "HEAD", "--no-extensions"],
      cwd,
      cols: 100,
      rows: 20,
    });

    try {
      const review = await session.waitForText(/Second history commit/, { timeout: 15_000 });
      expect(review).toContain("historyValue = 'second'");
      expect(review).toMatch(/Second history commit.*[0-9a-f]{8}\s+⧉/);
      expect(review).toMatch(/history · (?:in .*|.* ago)/);
    } finally {
      session.close();
    }
  });

  test("shows included commits for a direct revision comparison", async () => {
    const cwd = createHistoryRepo();
    writeFileSync(join(cwd, "history.ts"), "export const historyValue = 'third';\n");
    git(cwd, ["commit", "-qam", "Third history commit"]);
    const session = await harness.launchHunk({
      args: ["diff", "HEAD~2", "HEAD", "--no-extensions"],
      cwd,
      cols: 100,
      rows: 20,
    });

    try {
      const review = await session.waitForText(/Third history commit/, { timeout: 15_000 });
      expect(review).toContain("Second history commit");
      expect(review).toContain("historyValue = 'third'");
      expect(review.match(/[0-9a-f]{8} ⧉/g)).toHaveLength(2);
    } finally {
      session.close();
    }
  });
});

describe("interactive hunk log", () => {
  test("cancels a slow bundled Git review without blocking terminal input", async () => {
    const cwd = createHistoryRepo();
    const binDir = mkdtempSync(join(tmpdir(), "hunk-slow-git-bin-"));
    tempDirs.push(binDir);
    const gitPath = Bun.which("git");
    if (!gitPath) throw new Error("Git is required for the PTY history fixture.");
    const wrapper = join(binDir, "git");
    writeFileSync(
      wrapper,
      `#!/bin/sh\ncase " $* " in *" show "*|*" diff "*) sleep 10 ;; esac\nexec ${JSON.stringify(gitPath)} "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    const session = await harness.launchHunk({
      args: ["log", "--color", "never", "--no-extensions"],
      cwd,
      cols: 100,
      rows: 20,
      env: { PATH: `${binDir}:${process.env.PATH ?? ""}` },
    });

    try {
      await session.waitForText(/Second history commit/, { timeout: 15_000 });
      await harness.pressAndWaitForText(session, "enter", /Preparing review/, { timeout: 5_000 });
      const cancelledAt = Date.now();
      session.writeRaw("\x03");
      while (
        !session.getRawOutput().slice(-2_000).includes("\x1b[?1049l") &&
        Date.now() - cancelledAt < 3_000
      ) {
        await Bun.sleep(25);
      }
      expect(Date.now() - cancelledAt).toBeLessThan(3_000);
      expect(session.getRawOutput().slice(-2_000)).toContain("\x1b[?1049l");
      expect(session.getRawOutput()).not.toContain("historyValue = 'second'");
    } finally {
      session.writeRaw("\x03");
    }
  });

  test("opens an inclusive root range and retains it when returning", async () => {
    const cwd = createHistoryRepo();
    const session = await harness.launchHunk({
      args: ["log", "--color", "never", "--no-extensions"],
      cwd,
      cols: 100,
      rows: 20,
    });

    try {
      const history = await session.waitForText(/Second history commit/, { timeout: 15_000 });
      const rootRowIndex = history
        .split("\n")
        .findIndex((line) => line.includes("First history commit"));
      session.writeRaw("v");
      await session.waitForText(/1 commit selected/, { timeout: 5_000 });
      session.writeRaw("j");
      await session.waitForText(/2 commits selected/, { timeout: 5_000 });
      const review = await harness.pressAndWaitForText(session, "enter", /rootOnly = true/, {
        timeout: 15_000,
      });
      expect(review).toContain("historyValue = 'second'");
      expect(review).toContain("Second history commit");
      expect(review).toContain("First history commit");
      expect(review).toMatch(/history · .* ago\s+[0-9a-f]{8} ⧉/);
      await harness.pressAndWaitForText(session, "q", /2 commits selected/, { timeout: 15_000 });

      // Escape collapses visual mode before direct Shift selection starts another range.
      await harness.pressAndWaitForSnapshot(
        session,
        "escape",
        (text) => !text.includes("commits selected"),
        5_000,
      );
      session.writeRaw("k");

      // SGR mouse modifier bit 4 forwards Shift+click through capable terminals.
      session.writeRaw(`\x1b[<4;50;${rootRowIndex + 1}M\x1b[<4;50;${rootRowIndex + 1}m`);
      await session.waitForText(/2 commits selected/, { timeout: 5_000 });
      await session.press("q");
    } finally {
      session.close();
    }
  });

  test("opens the selected immutable commit and returns to the retained history", async () => {
    const cwd = createHistoryRepo();
    const session = await harness.launchHunk({
      args: ["log", "--color", "never", "--no-extensions"],
      cwd,
      cols: 100,
      rows: 20,
    });

    try {
      const history = await session.waitForText(/Second history commit/, {
        timeout: 15_000,
      });
      expect(history).toContain("First history commit");
      expect(history).toContain("File  View  Navigate  Commit  Help");
      expect(history).toContain("Enter open");

      // Mouse and keyboard share the same menu model and actions.
      session.writeRaw("\x1b[<0;2;1M\x1b[<0;2;1m");
      await session.waitForText(/Open selection/, { timeout: 5_000 });
      await session.press("right");
      await harness.pressAndWaitForText(session, "enter", /Theme selector/, { timeout: 5_000 });
      await session.press("down");
      await harness.pressAndWaitForText(session, "enter", /Second history commit/, {
        timeout: 5_000,
      });

      // The first row's right-aligned commit id opens immediately without a double-click.
      const firstRowIndex = history
        .split("\n")
        .findIndex((line) => line.includes("Second history commit"));
      const firstRow = history.split("\n")[firstRowIndex] ?? "";
      const commitColumn = firstRow.search(/[0-9a-f]{8}\s+⧉\s*$/);
      expect(commitColumn).toBeGreaterThan(0);
      const transitionOutputStart = session.getRawOutput().length;
      session.writeRaw(
        `\x1b[<0;${commitColumn + 1};${firstRowIndex + 1}M\x1b[<0;${commitColumn + 1};${firstRowIndex + 1}m`,
      );
      const review = await session.waitForText(/historyValue = 'second'/, {
        timeout: 15_000,
      });
      expect(review).toContain("history.ts");
      expect(review).toMatch(/Second history commit.*[0-9a-f]{8}\s+⧉/);
      expect(review).toMatch(/history · (?:in .*|.* ago)/);
      expect(review).not.toContain("history · Git");
      expect(session.getRawOutput().slice(transitionOutputStart)).not.toContain("\x1b[?1049l");

      const returnOutputStart = session.getRawOutput().length;
      const returned = await harness.pressAndWaitForSnapshot(
        session,
        "q",
        (text) => text.includes("Second history commit") && text.includes("Enter open"),
        15_000,
      );
      expect(returned).toContain("Enter open");
      expect(session.getRawOutput().slice(returnOutputStart)).not.toContain("\x1b[?1049l");

      // The adjacent icon copies without opening the review.
      session.writeRaw(
        `\x1b[<0;${commitColumn + 10};${firstRowIndex + 1}M\x1b[<0;${commitColumn + 10};${firstRowIndex + 1}m`,
      );
      await session.waitForText(/Copied [0-9a-f]{8}/, { timeout: 5_000 });

      // Scrolling the history body dismisses an open dropdown before moving selection.
      await harness.pressAndWaitForText(session, "f10", /Open selection/, { timeout: 5_000 });
      session.writeRaw("\x1b[<65;50;5M");
      await harness.waitForSnapshot(session, (text) => !text.includes("Open selection"), 5_000);

      // Clicking outside the id selects the second row without opening it.
      session.writeRaw("\x1b[<0;50;5M\x1b[<0;50;5m");
      const rootReview = await harness.pressAndWaitForText(
        session,
        "enter",
        /historyValue = 'first'/,
        { timeout: 15_000 },
      );
      expect(rootReview).toContain("history.ts");
      await returnToHistory(session);

      // A command key closes an open menu and falls through to canonical dispatch.
      await harness.pressAndWaitForText(session, "f10", /Open selection/, { timeout: 5_000 });
      session.writeRaw("k\r");
      await session.waitForText(/historyValue = 'second'/, { timeout: 15_000 });
      await returnToHistory(session);

      // Opening again without moving proves return restored the immutable-id selection. The
      // coalesced trailing q must be consumed by the log transition rather than closing the child.
      session.writeRaw("\rq");
      await session.waitForText(/historyValue = 'second'/, { timeout: 15_000 });
      await returnToHistory(session);
      await session.press("q");
    } finally {
      session.close();
    }
  });

  test("searches commits through the status-line prompt and repeats the query", async () => {
    const cwd = createHistoryRepo();
    const session = await harness.launchHunk({
      args: ["log", "--color", "never", "--no-extensions"],
      cwd,
      cols: 100,
      rows: 20,
    });

    try {
      await session.waitForText(/Second history commit/, { timeout: 15_000 });
      await session.waitForText(/Git · 2 commits/, { timeout: 5_000 });

      // `/` opens a real inline input with a placeholder; typing paints in place.
      session.writeRaw("/");
      await harness.waitForSnapshot(session, (text) => text.includes("/ search commits"), 5_000);
      await session.type("first");
      await harness.waitForSnapshot(session, (text) => text.includes("/ first"), 5_000);

      // While the prompt is open, a bound key is text rather than a command.
      await session.type("q");
      await harness.waitForSnapshot(session, (text) => text.includes("/ firstq"), 5_000);
      await session.press("backspace");

      // Enter selects the match, closes the prompt, and leaves the query on the row.
      await session.press("enter");
      const found = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("/ first") && text.includes("/first"),
        5_000,
      );
      expect(found).toContain("Git · 2 commits");
      await session.press("enter");
      const review = await session.waitForText(/historyValue = 'first'/, { timeout: 15_000 });
      expect(review).toContain("First history commit");
      await returnToHistory(session);

      // Reopening starts from the retained query; Escape clears a non-empty buffer first, then
      // leaves the prompt on the second press without touching the retained query.
      session.writeRaw("/");
      await harness.waitForSnapshot(session, (text) => text.includes("/ first"), 5_000);
      await session.press("escape");
      await harness.waitForSnapshot(session, (text) => text.includes("/ search commits"), 5_000);
      await session.press("escape");
      const closed = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("/ search commits"),
        5_000,
      );
      expect(closed).toContain("/first");
    } finally {
      session.close();
    }
  });

  test("resolves canonical history command remaps from user keybindings", async () => {
    const cwd = createHistoryRepo();
    const configHome = mkdtempSync(join(tmpdir(), "hunk-log-keybindings-"));
    tempDirs.push(configHome);
    const configDir = join(configHome, "hunk");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.toml"),
      '[keybindings]\n"hunk.history.nextCommit" = "ctrl+n"\n"hunk.history.startVisualSelection" = "x"\n',
    );
    const session = await harness.launchHunk({
      args: ["log", "--color", "never", "--no-extensions"],
      cwd,
      cols: 100,
      rows: 20,
      env: { XDG_CONFIG_HOME: configHome },
    });

    try {
      const remapped = await session.waitForText(/Second history commit/, { timeout: 15_000 });
      expect(remapped).toContain("x select");
      expect(remapped).not.toContain("v select");
      session.writeRaw("x");
      await session.waitForText(/1 commit selected/, { timeout: 5_000 });
      await harness.pressAndWaitForSnapshot(
        session,
        "escape",
        (text) => !text.includes("commit selected"),
      );
      await session.press("down");
      await harness.pressAndWaitForText(session, "enter", /historyValue = 'second'/, {
        timeout: 15_000,
      });
      await returnToHistory(session);
      session.writeRaw("\x0e");
      await harness.pressAndWaitForText(session, "enter", /historyValue = 'first'/, {
        timeout: 15_000,
      });
      await returnToHistory(session);
      await session.press("q");
    } finally {
      session.close();
    }
  });

  test("prompts to save a changed theme when the history session quits", async () => {
    const cwd = createHistoryRepo();
    const configHome = mkdtempSync(join(tmpdir(), "hunk-log-view-preferences-"));
    tempDirs.push(configHome);
    const session = await harness.launchHunk({
      args: ["log", "--color", "never", "--no-extensions"],
      cwd,
      cols: 100,
      rows: 20,
      env: { XDG_CONFIG_HOME: configHome },
    });

    try {
      await session.waitForText(/Second history commit/, { timeout: 15_000 });
      await harness.pressAndWaitForText(session, "t", /Theme selector/, { timeout: 5_000 });
      await session.press("down");
      await session.press("enter");
      const prompt = await harness.pressAndWaitForText(session, "q", /Save view preferences\?/, {
        timeout: 5_000,
      });
      expect(prompt).toContain('- theme = "github-dark-default"');
      expect(prompt).toContain('+ theme = "github-dark-dimmed"');

      await session.press("s");
      const configPath = join(configHome, "hunk", "config.toml");
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !existsSync(configPath)) await Bun.sleep(50);
      expect(readFileSync(configPath, "utf8")).toContain('theme = "github-dark-dimmed"');
    } finally {
      session.close();
    }
  });

  test("retains changed review layout across repeated history reviews", async () => {
    const cwd = createHistoryRepo();
    const configHome = mkdtempSync(join(tmpdir(), "hunk-log-layout-preferences-"));
    tempDirs.push(configHome);
    const configDir = join(configHome, "hunk");
    const configPath = join(configDir, "config.toml");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, 'mode = "split"\n');
    const session = await harness.launchHunk({
      args: ["log", "--color", "never", "--no-extensions"],
      cwd,
      cols: 120,
      rows: 20,
      env: { XDG_CONFIG_HOME: configHome },
    });

    try {
      await session.waitForText(/Second history commit/, { timeout: 15_000 });
      const split = await harness.pressAndWaitForText(session, "enter", /historyValue = 'second'/, {
        timeout: 15_000,
      });
      expect(split).toMatch(/▌.*▌/);

      // Preserve the coalesced layout-and-return input; only history chrome proves q committed.
      session.writeRaw("1q");
      await harness.waitForSnapshot(
        session,
        (text) => text.includes("Git history") && text.includes("Enter open"),
        15_000,
      );

      const retained = await harness.pressAndWaitForSnapshot(
        session,
        "enter",
        (text) => !/▌.*▌/.test(text) && text.includes("historyValue = 'second'"),
        15_000,
      );
      expect(retained).not.toMatch(/▌.*▌/);

      await returnToHistory(session);
      const prompt = await harness.pressAndWaitForText(session, "q", /Save view preferences\?/, {
        timeout: 5_000,
      });
      expect(prompt).toContain('- mode = "split"');
      expect(prompt).toContain('+ mode = "unified"');

      await session.press("q");
      expect(readFileSync(configPath, "utf8")).toBe('mode = "split"\n');
    } finally {
      session.close();
    }
  });

  test("adapts GitHub-style grouped rows and right-aligned ids on resize", async () => {
    const cwd = createHistoryRepo();
    const displayId = Bun.spawnSync(["git", "rev-parse", "--short=8", "HEAD"], {
      cwd,
      stdout: "pipe",
    })
      .stdout.toString()
      .trim();
    const session = await harness.launchHunk({
      args: ["log", "--color", "never", "--no-extensions"],
      cwd,
      cols: 110,
      rows: 20,
    });
    try {
      const wide = await session.waitForText(/Commits on Sep 6, 2026/, { timeout: 15_000 });
      expect(wide).toContain("history ·");
      expect(wide).toContain("○─ Commits on Sep 6, 2026");
      expect(wide).toContain("Commits on Sep 5, 2026");
      expect(wide).toMatch(/Commits on Sep 6, 2026\n\s*│\s*\n\s*│\s+Second history commit/);
      expect(wide).not.toContain("Responsive description");
      expect(rightmostColumnOf(wide, displayId)).toBeGreaterThan(95);

      session.writeRaw("t");
      await session.waitForText(/Theme selector/, { timeout: 5_000 });
      await harness.pressAndWaitForText(session, "escape", /Commits on Sep 6, 2026/, {
        timeout: 5_000,
      });

      session.resize({ cols: 70, rows: 20 });
      await harness.waitForSnapshot(
        session,
        (text) =>
          text.includes("Second history commit") &&
          text.includes("history ·") &&
          text.includes(displayId),
        5_000,
      );
      const medium = await session.text({ immediate: true });
      expect(medium).toContain("history ·");
      expect(rightmostColumnOf(medium, displayId)).toBeGreaterThan(55);
      session.resize({ cols: 42, rows: 18 });
      await harness.waitForSnapshot(
        session,
        (text) =>
          text.includes("Second history commit") &&
          !text.includes("2026-") &&
          text.includes(displayId),
        5_000,
      );
      const narrow = await session.text({ immediate: true });
      const narrowCommitLine = narrow
        .split("\n")
        .find((line) => line.includes("Second history commit"));
      expect(narrow).toContain("history ·");
      expect(narrowCommitLine).toContain(displayId);
      expect(narrowCommitLine?.trimStart()).toStartWith("│");
      expect(rightmostColumnOf(narrow, displayId)).toBeGreaterThan(27);
      await session.press("q");
    } finally {
      session.close();
    }
  });

  test("forces static scrollback output on a terminal", async () => {
    const cwd = createHistoryRepo();
    const session = await harness.launchHunk({
      args: ["log", "--static", "--color", "never", "--no-extensions"],
      cwd,
      cols: 80,
      rows: 24,
    });
    try {
      const output = await session.waitForText(/Author: History Tester/, { timeout: 15_000 });
      expect(output).toContain("Second history commit");
      expect(output).not.toContain("File  View  Navigate");
    } finally {
      session.close();
    }
  });

  test("uses an ASCII timeline by default and preserves the optional graph view", async () => {
    const cwd = createHistoryRepo();
    const session = await harness.launchHunk({
      args: ["log", "--ascii", "--no-extensions"],
      cwd,
      cols: 80,
      rows: 16,
      env: { TERM: "dumb", NO_COLOR: "" },
    });
    try {
      const history = await session.waitForText(/Second history commit/, { timeout: 15_000 });
      expect(history).toContain("o- Commits on Sep 6, 2026");
      expect(history).toContain("|");

      await session.press("f10");
      await session.press("right");
      await session.press("down");
      const graph = await harness.pressAndWaitForSnapshot(
        session,
        "enter",
        (text) => text.includes("*") && !text.includes("Commits on Sep 6, 2026"),
        5_000,
      );
      expect(graph).not.toContain("●");
      await session.press("q");
    } finally {
      session.close();
    }
  });

  test("refreshes from a new provider cursor and reveals a new commit", async () => {
    const cwd = createHistoryRepo();
    const session = await harness.launchHunk({
      args: ["log", "--color", "never", "--no-extensions"],
      cwd,
      cols: 90,
      rows: 18,
    });
    try {
      await session.waitForText(/Second history commit/, { timeout: 15_000 });
      writeFileSync(join(cwd, "history.ts"), "export const historyValue = 'third';\n");
      git(cwd, ["commit", "-qam", "Third history commit"]);
      const refreshed = await harness.pressAndWaitForText(session, "r", /Third history commit/, {
        timeout: 15_000,
      });
      expect(refreshed).toContain("History refreshed");
      await session.press("q");
    } finally {
      session.close();
    }
  });

  test("keeps automatic history refresh opt-in and reveals new commits when enabled", async () => {
    const cwd = createHistoryRepo();
    const session = await harness.launchHunk({
      args: ["log", "--color", "never", "--no-extensions"],
      cwd,
      cols: 90,
      rows: 18,
    });
    try {
      await session.waitForText(/Second history commit/, { timeout: 15_000 });
      await harness.pressAndWaitForText(session, "f10", /Auto-refresh history: off/, {
        timeout: 5_000,
      });
      await session.press("down");
      await session.press("down");
      await session.press("down");
      await session.press("enter");
      await session.press("f10");
      await session.waitForText(/Auto-refresh history: on/, { timeout: 5_000 });
      await sleep(500);

      writeFileSync(join(cwd, "history.ts"), "export const historyValue = 'third';\n");
      git(cwd, ["commit", "-qam", "Third history commit"]);
      await sleep(750);
      expect(await session.text({ immediate: true })).not.toContain("Third history commit");
      await session.press("escape");
      const refreshed = await session.waitForText(/Third history commit/, { timeout: 15_000 });
      expect(refreshed).toContain("Second history commit");
      expect(refreshed).toContain("History refreshed.");

      await session.press("f10");
      await session.press("down");
      await session.press("down");
      await session.press("down");
      await session.press("enter");
      await session.press("f10");
      await session.waitForText(/Auto-refresh history: off/, { timeout: 5_000 });
      await session.press("escape");
      writeFileSync(join(cwd, "history.ts"), "export const historyValue = 'fourth';\n");
      git(cwd, ["commit", "-qam", "Fourth history commit"]);
      await sleep(750);
      expect(await session.text({ immediate: true })).not.toContain("Fourth history commit");
      await session.press("q");
    } finally {
      session.close();
    }
  });

  test("starts history auto-refresh from repository config and keeps F10 session-local", async () => {
    const cwd = createHistoryRepo();
    mkdirSync(join(cwd, ".hunk"), { recursive: true });
    writeFileSync(join(cwd, ".hunk", "config.toml"), "history_auto_refresh = true\n");
    const session = await harness.launchHunk({
      args: ["log", "--color", "never", "--no-extensions"],
      cwd,
      cols: 90,
      rows: 18,
    });
    try {
      await session.waitForText(/Second history commit/, { timeout: 15_000 });
      await harness.pressAndWaitForText(session, "f10", /Auto-refresh history: on/, {
        timeout: 5_000,
      });
      await session.press("escape");
      await sleep(500);

      writeFileSync(join(cwd, "history.ts"), "export const historyValue = 'third';\n");
      git(cwd, ["commit", "-qam", "Third history commit"]);
      const refreshed = await session.waitForText(/Third history commit/, { timeout: 15_000 });
      expect(refreshed).toContain("History refreshed.");

      await session.press("f10");
      await session.press("down");
      await session.press("down");
      await session.press("down");
      await session.press("enter");
      await session.press("f10");
      await session.waitForText(/Auto-refresh history: off/, { timeout: 5_000 });
      expect(readFileSync(join(cwd, ".hunk", "config.toml"), "utf8")).toBe(
        "history_auto_refresh = true\n",
      );
      await session.press("escape");
      await session.press("q");
    } finally {
      session.close();
    }
  });

  test("defers refresh while the search prompt is active and keeps the query", async () => {
    const cwd = createHistoryRepo();
    const session = await harness.launchHunk({
      args: ["log", "--color", "never", "--no-extensions"],
      cwd,
      cols: 90,
      rows: 18,
    });
    try {
      await session.waitForText(/Second history commit/, { timeout: 15_000 });
      await session.press("f10");
      await session.press("down");
      await session.press("down");
      await session.press("down");
      await session.press("enter");
      await session.press("f10");
      await session.waitForText(/Auto-refresh history: on/, { timeout: 5_000 });
      await session.press("escape");

      session.writeRaw("/");
      await harness.waitForSnapshot(session, (text) => text.includes("/ search commits"), 5_000);
      await session.type("Sec");
      await harness.waitForSnapshot(session, (text) => text.includes("/ Sec"), 5_000);
      writeFileSync(join(cwd, "history.ts"), "export const historyValue = 'third';\n");
      git(cwd, ["commit", "-qam", "Search prompt refresh"]);
      await sleep(750);
      const prompt = await session.text({ immediate: true });
      expect(prompt).toContain("/ Sec");
      expect(prompt).not.toContain("Search prompt refresh");

      await session.press("enter");
      const refreshed = await session.waitForText(/Search prompt refresh/, { timeout: 15_000 });
      expect(refreshed).toContain("History refreshed.");
      expect(refreshed).toContain("/Sec");
      await session.press("q");
    } finally {
      session.close();
    }
  });

  test("keeps auto-refresh enabled across an embedded review", async () => {
    const cwd = createHistoryRepo();
    const session = await harness.launchHunk({
      args: ["log", "--color", "never", "--no-extensions"],
      cwd,
      cols: 90,
      rows: 18,
    });
    try {
      await session.waitForText(/Second history commit/, { timeout: 15_000 });
      await session.press("f10");
      await session.press("down");
      await session.press("down");
      await session.press("down");
      await session.press("enter");
      await session.press("f10");
      await session.waitForText(/Auto-refresh history: on/, { timeout: 5_000 });
      await session.press("escape");

      await session.press("enter");
      await session.waitForText(/historyValue = 'second'/, { timeout: 15_000 });
      writeFileSync(join(cwd, "history.ts"), "export const historyValue = 'third';\n");
      git(cwd, ["commit", "-qam", "Third history commit"]);
      const history = await returnToHistory(session);
      expect(history).toContain("Third history commit");
      await session.press("f10");
      await session.waitForText(/Auto-refresh history: on/, { timeout: 5_000 });
      await session.press("q");
    } finally {
      session.close();
    }
  });

  test("opens a merge against the provider-selected parent", async () => {
    const cwd = createMergeHistoryRepo();
    const session = await harness.launchHunk({
      args: ["log", "--color", "never", "--no-extensions"],
      cwd,
      cols: 100,
      rows: 20,
    });
    try {
      await session.waitForText(/Merge side/, { timeout: 15_000 });
      await session.press("f10");
      await session.press("right");
      await session.press("down");
      const graph = await harness.pressAndWaitForText(session, "enter", /╯/, { timeout: 5_000 });
      expect(graph).not.toContain("Commits on");

      await session.press("f10");
      await session.press("right");
      await session.press("right");
      await harness.pressAndWaitForText(session, "right", /Compare with parent/, {
        timeout: 5_000,
      });
      await session.press("down");
      await session.press("down");
      await session.press("down");
      await session.press("enter");
      await session.waitForText(/Compare with parent/, { timeout: 5_000 });
      session.writeRaw("\x1b[<65;50;10M");
      await session.waitIdle();
      const review = await harness.pressAndWaitForText(session, "enter", /main\.ts/, {
        timeout: 15_000,
      });
      expect(review).not.toContain("side.ts");
      await returnToHistory(session);
      await session.press("q");
    } finally {
      session.close();
    }
  });
});

/** Quote generated fixture paths as literal shell arguments. */
function quoteTestShellArgument(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/** Wait for the provider's explicit paging handshake, not a guessed execution delay. */
async function waitForTestFile(path: string) {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error("History provider did not reach its refresh gate.");
    await sleep(20);
  }
}

const refreshRaceTest = process.platform === "win32" ? test.skip : test;
const groupedRefreshTest = Bun.which("jj") ? test : test.skip;
groupedRefreshTest("keeps the physical reading row after JJ authored-day rewrites", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hunk-log-day-refresh-"));
  tempDirs.push(cwd);
  const jj = (...args: string[]) => {
    const result = Bun.spawnSync(
      [
        "jj",
        "--config",
        'user.name="History Tester"',
        "--config",
        'user.email="history@example.com"',
        ...args,
      ],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  jj("git", "init", "--no-colocate", ".");
  jj("describe", "-m", "Dated entry 0");
  for (let index = 1; index < 50; index += 1) jj("new", "-m", `Dated entry ${index}`);
  jj("metaedit", "-r", "all() ~ root()", "--author-timestamp", "2026-01-01T12:00:00Z");
  const identities = jj(
    "log",
    "--no-graph",
    "-r",
    "all() ~ root()",
    "-T",
    'change_id ++ "\\n"',
  ).split("\n");
  const session = await harness.launchHunk({
    args: ["log", "--vcs", "jj", "--all", "--color", "never", "--no-extensions"],
    cwd,
    cols: 90,
    rows: 26,
  });
  try {
    await session.waitForText(/Dated entry 49/, { timeout: 15_000 });
    for (let index = 0; index < 8; index += 1) await session.press("down");
    session.resize({ cols: 90, rows: 43 });
    await session.waitIdle();
    const selectedPhysicalRow = () =>
      session.getTerminalData().lines.findIndex((line) =>
        line.spans
          .map((span) => span.text)
          .join("")
          .includes("Dated entry 41"),
      );
    const selectedRow = selectedPhysicalRow();
    expect(selectedRow).toBeGreaterThan(10);
    const selectedBackground = rowCellBackgrounds(session, selectedRow);
    jj(
      "metaedit",
      "-r",
      identities.slice(7).join(" | "),
      "--author-timestamp",
      "2026-01-06T12:00:00Z",
    );
    for (let index = 3; index < 7; index += 1)
      jj(
        "metaedit",
        "-r",
        identities[index]!,
        "--author-timestamp",
        `2026-01-0${index - 1}T12:00:00Z`,
      );
    await session.press("r");
    const after = await session.waitForText(/History refreshed\./, { timeout: 15_000 });
    expect(selectedPhysicalRow()).toBe(selectedRow);
    expect(after).toContain("Commits on Jan 6");
    expect(rowCellBackgrounds(session, selectedRow)).toEqual(selectedBackground);
  } finally {
    session.close();
  }
});

refreshRaceTest(
  "keeps a newer keyboard selection while manual refresh stages provider history",
  async () => {
    const cwd = createHistoryRepo();
    const bin = join(cwd, "test-bin");
    mkdirSync(bin);
    const enabled = join(cwd, "delay-history");
    const started = join(cwd, "history-read-started");
    const release = join(cwd, "release-history");
    const realGit = Bun.which("git");
    if (!realGit) throw new Error("Git test executable missing.");
    const wrapper = join(bin, "git");
    writeFileSync(
      wrapper,
      `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = log ] && [ -e ${quoteTestShellArgument(enabled)} ] && [ ! -e ${quoteTestShellArgument(started)} ]; then\n    : > ${quoteTestShellArgument(started)}\n    while [ ! -e ${quoteTestShellArgument(release)} ]; do sleep 0.01; done\n  fi\ndone\nexec ${quoteTestShellArgument(realGit)} "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    const session = await harness.launchHunk({
      args: ["log", "--color", "never", "--no-extensions"],
      cwd,
      cols: 90,
      rows: 18,
      env: { PATH: bin + ":" + process.env.PATH },
    });
    try {
      await session.waitForText(/Second history commit/, { timeout: 15_000 });
      writeFileSync(join(cwd, "history.ts"), "export const historyValue = 'third';\n");
      git(cwd, ["commit", "-qam", "Third history commit"]);
      writeFileSync(enabled, "");
      await session.press("r");
      await waitForTestFile(started);
      await session.press("down");
      writeFileSync(release, "");
      await session.waitForText(/History refreshed\./, { timeout: 15_000 });
      const review = await harness.pressAndWaitForText(session, "enter", /rootOnly = true/, {
        timeout: 15_000,
      });
      expect(review).toContain("root-only.ts");
      expect(review).toContain("First history commit");
    } finally {
      writeFileSync(release, "");
      session.close();
    }
  },
);

/** Create JJ work on mainline and old bases with a configured protected boundary. */
function createHk93PtyTestRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "hunk-hk93-pty-"));
  const configHome = mkdtempSync(join(tmpdir(), "hunk-hk93-pty-config-"));
  const env = { ...process.env, XDG_CONFIG_HOME: configHome };
  tempDirs.push(cwd, configHome);
  const jj = (...args: string[]) => {
    const result = Bun.spawnSync(
      [
        "jj",
        "--config",
        'user.name="History Tester"',
        "--config",
        'user.email="history@example.com"',
        ...args,
      ],
      { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  jj("git", "init", "--no-colocate", ".");
  jj("config", "set", "--repo", 'revset-aliases."trunk()"', "none()");
  const add = (bookmark: string, subject: string, parent: string) => {
    jj("new", parent);
    writeFileSync(join(cwd, `${bookmark}.ts`), `export const ${bookmark} = true;\n`);
    jj("describe", "-m", subject);
    const id = jj("log", "--no-graph", "-r", "@", "-T", "commit_id");
    jj("bookmark", "create", bookmark, "-r", id);
    return id;
  };
  const old = add("old", "Hidden older history", "root()");
  const main = add("main", "Mainline boundary", old);
  add("side", "Old-based branch", old);
  const protectedId = add("protected", "Protected branch", main);
  add("feature", "Feature current work", main);
  jj("config", "set", "--repo", 'revset-aliases."trunk()"', "main");
  jj("config", "set", "--repo", 'revset-aliases."immutable_heads()"', `main | ${protectedId}`);
  return { cwd, jj, env };
}

describe("HK-93 focused working history", () => {
  (Bun.which("jj") ? test : test.skip)(
    "HK-93 terminal cuts remain local through graph, resize, selection and real-parent review",
    async () => {
      const { cwd, env } = createHk93PtyTestRepo();
      const session = await harness.launchHunk({
        args: ["log", "--vcs", "jj", "--color", "never", "--no-extensions"],
        cwd,
        env,
        cols: 80,
        rows: 26,
      });
      try {
        const initial = await session.waitForText(/~ older history hidden/, { timeout: 15_000 });
        for (const subject of [
          "Feature current work",
          "Mainline boundary",
          "Old-based branch",
          "Protected branch",
        ])
          expect(initial).toContain(subject);
        expect(initial).not.toContain("Hidden older history");
        expect(initial.match(/~ older history hidden/g)).toHaveLength(1);
        expect(initial.split("\n").filter((line) => line.trim() === "~")).toHaveLength(2);
        const stubRow = session.getTerminalData().lines.findIndex(
          (line) =>
            line.spans
              .map((span) => span.text)
              .join("")
              .trim() === "~",
        );
        expect(stubRow).toBeGreaterThan(0);
        session.writeRaw(`\x1b[<0;3;${stubRow + 1}M\x1b[<0;3;${stubRow + 1}m`);
        const review = await harness.pressAndWaitForText(
          session,
          "enter",
          /export const feature = true/,
          { timeout: 15_000 },
        );
        expect(review).not.toContain("export const old = true");
        await harness.pressAndWaitForSnapshot(
          session,
          "q",
          (text) => text.includes("Enter open") && text.includes("~ older history hidden"),
          15_000,
        );
        session.writeRaw("v");
        await session.waitForText(/1 commit selected/, { timeout: 5_000 });
        session.writeRaw("j");
        await session.waitForText(/2 commits selected/, { timeout: 5_000 });
        await session.press("escape");
        await session.press("f10");
        await session.press("right");
        await session.press("down");
        await session.press("enter");
        const graph = await harness.waitForSnapshot(
          session,
          (text) => text.includes("●") && text.includes("~ older history hidden"),
          5_000,
        );
        expect(graph).not.toContain("Hidden older history");
        session.resize({ cols: 40, rows: 20 });
        await harness.waitForSnapshot(
          session,
          (text) => text.includes("~ older history hidden"),
          5_000,
        );
        await session.press("end");
        const bottom = await harness.waitForSnapshot(
          session,
          (text) =>
            text.includes("Mainline boundary") &&
            text.split("\n").some((line) => line.trim().includes("~") && !line.includes("hidden")),
          5_000,
        );
        expect(bottom).not.toContain("Hidden older history");
        session.resize({ cols: 120, rows: 26 });
        await harness.waitForSnapshot(
          session,
          (text) => text.includes("Mainline boundary") && text.includes("~ older history hidden"),
          5_000,
        );
        const mainReview = await harness.pressAndWaitForText(
          session,
          "enter",
          /export const main = true/,
          { timeout: 15_000 },
        );
        expect(mainReview).not.toContain("export const old = true");
      } finally {
        session.close();
      }
    },
  );

  (Bun.which("jj") ? test : test.skip)(
    "HK-93 fallback survives transient copy and refresh and wraps without displacing status",
    async () => {
      const { cwd, jj, env } = createHk93PtyTestRepo();
      jj("config", "set", "--repo", 'revset-aliases."trunk()"', "none()");
      const session = await harness.launchHunk({
        args: ["log", "--vcs", "jj", "--color", "never", "--no-extensions"],
        cwd,
        env,
        cols: 80,
        rows: 28,
      });
      try {
        const initial = await session.waitForText(
          /Mainline unavailable; showing visible history./,
          { timeout: 15_000 },
        );
        expect(initial).toContain("Hidden older history");
        expect(initial).not.toContain("~ older history hidden");
        const copied = await harness.pressAndWaitForText(session, "y", /Copied/, {
          timeout: 5_000,
        });
        expect(copied).toContain("Mainline unavailable; showing visible history.");
        session.resize({ cols: 40, rows: 24 });
        const narrow = await harness.waitForSnapshot(
          session,
          (text) =>
            text.includes("Mainline unavailable; showing visible") &&
            text.includes("history.") &&
            text.includes("Jujutsu · 5 commits"),
          5_000,
        );
        expect(narrow).not.toContain("~ older history hidden");
        jj("config", "set", "--repo", 'revset-aliases."trunk()"', "main");
        session.resize({ cols: 120, rows: 28 });
        await session.waitIdle();
        await harness.pressAndWaitForText(session, "r", /History refreshed/, { timeout: 10_000 });
        const bounded = await session.text({ immediate: true });
        expect(bounded).not.toContain("Mainline unavailable");
        expect(bounded).not.toContain("Hidden older history");
        jj("config", "set", "--repo", 'revset-aliases."trunk()"', "unknown_function()");
        expect(() =>
          jj("log", "--no-graph", "-r", "present(trunk())", "-T", "commit_id"),
        ).toThrow();
        await harness.pressAndWaitForText(session, "r", /Config error:/, { timeout: 5_000 });
        expect(await session.text({ immediate: true })).toContain("~ older history hidden");
      } finally {
        session.close();
      }
    },
  );

  (Bun.which("jj") ? test : test.skip)(
    "HK-93 empty filtered fallback explains ambiguity without inventing cutoff rows",
    async () => {
      const { cwd, jj, env } = createHk93PtyTestRepo();
      jj("config", "set", "--repo", 'revset-aliases."trunk()"', "main | feature");
      const session = await harness.launchHunk({
        args: [
          "log",
          "--vcs",
          "jj",
          "--grep",
          "no-such-subject",
          "--color",
          "never",
          "--no-extensions",
        ],
        cwd,
        env,
        cols: 80,
        rows: 20,
      });
      try {
        const empty = await session.waitForText(/Mainline ambiguous; showing visible history./, {
          timeout: 15_000,
        });
        expect(empty).toContain("No commits found.");
        expect(empty).not.toContain("~ older history hidden");
      } finally {
        session.close();
      }
    },
  );
});

(Bun.which("jj") ? test : test.skip)(
  "HK-93 oversized cutoff tails are reachable with keyboard and mouse without inventing commits",
  async () => {
    const { cwd, jj, env } = createHk93PtyTestRepo();
    jj("config", "set", "--repo", 'revset-aliases."immutable_heads()"', "none()");
    const parents: string[] = [];
    for (let index = 0; index < 22; index += 1) {
      jj("new", "root()", "-m", `Older parent ${index}`);
      parents.push(jj("log", "--no-graph", "-r", "@", "-T", "commit_id"));
    }
    jj("new", ...parents, "-m", "Tall mainline boundary");
    const main = jj("log", "--no-graph", "-r", "@", "-T", "commit_id");
    jj("new", ...parents, "-m", "Tall cutoff commit");
    jj("config", "set", "--repo", 'revset-aliases."trunk()"', main);
    const session = await harness.launchHunk({
      args: ["log", "--vcs", "jj", "--color", "never", "--no-extensions"],
      cwd,
      env,
      cols: 80,
      rows: 24,
    });
    try {
      const initial = await session.waitForText(/Tall cutoff commit/, { timeout: 15_000 });
      expect(initial).toContain("~ older history hidden");
      const first = await harness.pressAndWaitForText(session, "y", /Copied/, { timeout: 5_000 });
      const identity = first.match(/Copied ([a-z0-9]+)/)?.[1];
      expect(identity).toBeDefined();
      await session.press("pagedown");
      const tail = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("Tall cutoff commit") && text.includes("~ older history hidden"),
        5_000,
      );
      expect(tail.split("\n").filter((line) => line.trim() === "~").length).toBeGreaterThan(15);
      await session.press("y");
      expect(await session.text({ immediate: true })).toContain(`Copied ${identity}`);
      await session.scrollUp(1);
      await session.scrollUp(1);
      await harness.waitForSnapshot(session, (text) => text.includes("Tall cutoff commit"), 5_000);
      await session.press("y");
      expect(await session.text({ immediate: true })).toContain(`Copied ${identity}`);
      await session.press("pagedown");
      await session.press("pagedown");
      await harness.waitForSnapshot(
        session,
        (text) => text.includes("Tall mainline boundary"),
        5_000,
      );
    } finally {
      session.close();
    }
  },
);
