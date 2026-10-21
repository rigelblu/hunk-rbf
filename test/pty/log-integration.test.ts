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
import { measureTextWidth } from "../../packages/hunk/src/ui/lib/text";
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
    (text) =>
      text.includes("Git history") && (text.includes("Enter Open") || /\[[ x]\]/.test(text)),
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

/** Run JJ against an isolated history fixture with a deterministic identity. */
function jj(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(
    [
      "jj",
      "--config",
      'user.name="Workspace Tester"',
      "--config",
      'user.email="workspace@example.com"',
      ...args,
    ],
    {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

/** Create stable occupied commits so workspace moves change labels without rewriting history. */
function createWorkspaceHistoryTestRepo(workspaceName = "peer") {
  const root = mkdtempSync(join(tmpdir(), "hunk-workspace-log-pty-"));
  tempDirs.push(root);
  const cwd = join(root, "default");
  jj(root, "git", "init", "--no-colocate", cwd);
  writeFileSync(join(cwd, "history.ts"), "export const value = 'ancestor';\n");
  jj(cwd, "commit", "-m", "Workspace ancestor");
  writeFileSync(join(cwd, "history.ts"), "export const value = 'current';\n");
  jj(cwd, "describe", "-m", "Workspace current");
  const currentId = jj(cwd, "log", "--no-graph", "-r", "@", "-T", "commit_id").trim();
  const ancestorId = jj(cwd, "log", "--no-graph", "-r", "@-", "-T", "commit_id").trim();
  jj(cwd, "bookmark", "create", "current", "-r", currentId);
  jj(cwd, "bookmark", "create", "ancestor", "-r", ancestorId);
  const peer = join(root, "peer");
  jj(cwd, "workspace", "add", "--name", workspaceName, "-r", currentId, peer);
  jj(peer, "edit", currentId);
  return { cwd, peer, currentId, ancestorId };
}

/** Send a click at actual terminal cells, including Shift range extension. */
function clickWorkspaceTestCell(session: Session, x: number, y: number, shift = false) {
  const button = shift ? 4 : 0;
  session.writeRaw(`\x1b[<${button};${x + 1};${y + 1}M\x1b[<${button};${x + 1};${y + 1}m`);
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
  test("uses the root theme despite a conflicting show override", async () => {
    const cwd = createHistoryRepo();
    const configHome = mkdtempSync(join(tmpdir(), "hunk-log-theme-scope-"));
    tempDirs.push(configHome);
    mkdirSync(join(configHome, "hunk"), { recursive: true });
    writeFileSync(
      join(configHome, "hunk", "config.toml"),
      'theme = "nord"\nprompt_save_view_preferences = false\n[show]\ntheme = "github-dark-dimmed"\n',
    );
    const session = await harness.launchHunk({
      args: ["log", "--no-extensions"],
      cwd,
      cols: 100,
      rows: 24,
      env: { XDG_CONFIG_HOME: configHome, NO_COLOR: undefined, TERM: "xterm-256color" },
    });
    try {
      await session.waitForText(/Second history commit/, { timeout: 15_000 });
      expect(await session.text({ only: { foreground: "#d8dee9" } })).toContain(
        "Second history commit",
      );
      const picker = await harness.pressAndWaitForSnapshot(
        session,
        "t",
        (text) => /nord.*active/.test(text),
        15_000,
      );
      expect(picker).toMatch(/nord.*active/);
      await session.press("escape");
      await session.press("q");
    } finally {
      session.close();
    }
  });

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
      await session.waitForText(/Review range: 1/, { timeout: 5_000 });
      session.writeRaw("j");
      await session.waitForText(/Review range: 2/, { timeout: 5_000 });
      const review = await harness.pressAndWaitForText(session, "enter", /rootOnly = true/, {
        timeout: 15_000,
      });
      expect(review).toContain("historyValue = 'second'");
      expect(review).toContain("Second history commit");
      expect(review).toContain("First history commit");
      expect(review).toMatch(/history · .* ago\s+[0-9a-f]{8} ⧉/);
      await harness.pressAndWaitForText(session, "q", /Review range: 2/, { timeout: 15_000 });

      // Escape collapses visual mode before direct Shift selection starts another range.
      await harness.pressAndWaitForSnapshot(
        session,
        "escape",
        (text) => !text.includes("Review range:"),
        5_000,
      );
      session.writeRaw("k");

      // SGR mouse modifier bit 4 forwards Shift+click through capable terminals.
      session.writeRaw(`\x1b[<4;50;${rootRowIndex + 1}M\x1b[<4;50;${rootRowIndex + 1}m`);
      await session.waitForText(/Review range: 2/, { timeout: 5_000 });
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
      expect(history).toContain("Enter Open");

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
      const physicalLines = session
        .getTerminalData()
        .lines.map((line) => line.spans.map((span) => span.text).join(""));
      const firstRowIndex = physicalLines.findIndex((line) =>
        line.includes("Second history commit"),
      );
      const firstRow = physicalLines[firstRowIndex] ?? "";
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
        (text) => text.includes("Second history commit") && text.includes("Enter Open"),
        15_000,
      );
      expect(returned).toContain("Enter Open");
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
      await session.click("First history commit");
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
      expect(remapped).toContain("x Review range");
      expect(remapped).not.toContain("v Review range");
      session.writeRaw("x");
      await session.waitForText(/Review range: 1/, { timeout: 5_000 });
      await harness.pressAndWaitForSnapshot(
        session,
        "escape",
        (text) => !text.includes("Review range:"),
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
        (text) => text.includes("Git history") && text.includes("Enter Open"),
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
      expect(wide).toMatch(/Commits on Sep 6, 2026\n\s*│\s*\n\s+│\s+Second history commit/);
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
          text.includes("Second history com") &&
          !text.includes("2026-") &&
          text.includes(displayId),
        5_000,
      );
      const narrow = await session.text({ immediate: true });
      const narrowCommitLine = narrow
        .split("\n")
        .find((line) => line.includes("Second history com"));
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

  test("refreshes without moving the reading anchor and reveals the new commit on Home", async () => {
    const cwd = createHistoryRepo();
    const session = await harness.launchHunk({
      args: ["log", "--color", "never", "--no-extensions"],
      cwd,
      cols: 90,
      // Leave room for three dated cards beside ordinary selection controls.
      rows: 20,
    });
    try {
      await session.waitForText(/Second history commit/, { timeout: 15_000 });
      writeFileSync(join(cwd, "history.ts"), "export const historyValue = 'third';\n");
      git(cwd, ["commit", "-qam", "Third history commit"]);
      const before = (await session.text({ immediate: true }))
        .split("\n")
        .findIndex((line) => line.includes("Second history commit"));
      const refreshed = await harness.pressAndWaitForText(session, "r", /History refreshed/, {
        timeout: 15_000,
      });
      expect(
        refreshed.split("\n").findIndex((line) => line.includes("Second history commit")),
      ).toBe(before);
      await harness.pressAndWaitForText(session, "home", /Third history commit/, {
        timeout: 15_000,
      });
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
      // Leave room for three dated cards beside ordinary selection controls.
      rows: 20,
    });
    try {
      const initial = await session.waitForText(/Second history commit/, { timeout: 15_000 });
      const initialLines = initial.split("\n");
      const initialRow = initialLines.findIndex((line) => line.includes("Second history commit"));
      const headSummary = initialLines[initialRow + 1]!.match(/\([^()]+\)/)?.[0];
      expect(headSummary).toBeDefined();
      await harness.pressAndWaitForText(session, "f10", /Auto-refresh history: off/, {
        timeout: 5_000,
      });
      await session.press("down");
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
      const blocked = await session.text({ immediate: true });
      expect(blocked).not.toContain("Third history commit");
      expect(blocked).toContain(headSummary!);
      expect(blocked).not.toContain("History refreshed.");
      await session.press("escape");
      const refreshed = await session.waitForText(/History refreshed\./, { timeout: 15_000 });
      expect(refreshed).toContain("Second history commit");
      await harness.pressAndWaitForText(session, "home", /Third history commit/, {
        timeout: 15_000,
      });

      await session.press("f10");
      await session.press("down");
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
      await session.press("home");
      const stillThird = await session.waitForText(/Third history commit/);
      expect(stillThird).not.toContain("Fourth history commit");
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
      // Leave room for three dated cards beside ordinary selection controls.
      rows: 20,
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
      const refreshed = await session.waitForText(/History refreshed\./, { timeout: 15_000 });
      expect(refreshed).toContain("Second history commit");
      await harness.pressAndWaitForText(session, "home", /Third history commit/, {
        timeout: 15_000,
      });

      await session.press("f10");
      await session.press("down");
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
      // Leave room for three dated cards beside ordinary selection controls.
      rows: 20,
    });
    try {
      const initial = await session.waitForText(/Second history commit/, { timeout: 15_000 });
      const initialLines = initial.split("\n");
      const initialRow = initialLines.findIndex((line) => line.includes("Second history commit"));
      const headSummary = initialLines[initialRow + 1]!.match(/\([^()]+\)/)?.[0];
      expect(headSummary).toBeDefined();
      await session.press("f10");
      await session.press("down");
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
      expect(prompt).toContain(headSummary!);
      expect(prompt).not.toContain("History refreshed.");

      await session.press("enter");
      const refreshed = await session.waitForText(/History refreshed\./, { timeout: 15_000 });
      expect(refreshed).toContain("/Sec");
      expect(refreshed).toContain("Second history commit");
      await harness.pressAndWaitForText(session, "home", /Search prompt refresh/, {
        timeout: 15_000,
      });
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
      // Leave room for three dated cards beside ordinary selection controls.
      rows: 20,
    });
    try {
      await session.waitForText(/Second history commit/, { timeout: 15_000 });
      await session.press("f10");
      await session.press("down");
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
      expect(history).toContain("Second history commit");
      await harness.pressAndWaitForText(session, "home", /Third history commit/, {
        timeout: 15_000,
      });
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
      await session.click("Compare with parent…");
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
groupedRefreshTest(
  "keeps the nearest feasible reading row after JJ authored-day rewrites",
  async () => {
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
      // Retain the prior body budget beneath query and selection chrome.
      rows: 30,
    });
    try {
      await session.waitForText(/Dated entry 49/, { timeout: 15_000 });
      for (let index = 0; index < 8; index += 1) await session.press("down");
      session.resize({ cols: 90, rows: 47 });
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
      // Two-row entries plus rewritten day headers make the old row unreachable; both nearest
      // positions are two rows away, and the earlier whole-entry top wins the documented tie.
      expect(selectedPhysicalRow()).toBe(selectedRow + 2);
      expect(after).toContain("Commits on Jan 6");
      expect(rowCellBackgrounds(session, selectedPhysicalRow())).toEqual(selectedBackground);
    } finally {
      session.close();
    }
  },
);

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
        // Retain the prior body budget beneath query and selection chrome.
        rows: 30,
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
          (text) => text.includes("Enter Open") && text.includes("~ older history hidden"),
          15_000,
        );
        session.writeRaw("v");
        await session.waitForText(/Review range: 1/, { timeout: 5_000 });
        session.writeRaw("j");
        await session.waitForText(/Review range: 2/, { timeout: 5_000 });
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
            text.includes("No explicit selection"),
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
      // Three more rows than before: the JJ history screen now shows its revset, mode and a gap.
      rows: 27,
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

describe("HK-92 workspace history", () => {
  test("compact workspace rows resize and refresh pointer-only moves", async () => {
    const { cwd, peer, currentId, ancestorId } = createWorkspaceHistoryTestRepo();
    const session = await harness.launchHunk({
      args: ["log", "--vcs", "jj", "--all", "--no-extensions"],
      cwd,
      cols: 70,
      rows: 20,
    });
    try {
      const initial = await session.waitForText(/@default, @peer/, { timeout: 15_000 });
      const lines = initial.split("\n");
      const currentLine = lines.findIndex((line) => line.includes("Workspace current"));
      expect(lines[currentLine + 1]).toContain("(@, current)");
      expect(lines[currentLine + 1]).toContain("@default, @peer");
      const ancestorLine = lines.findIndex((line) => line.includes("Workspace ancestor"));
      expect(ancestorLine - currentLine).toBe(2);
      session.resize({ cols: 45, rows: 20 });
      const narrow = await harness.waitForSnapshot(
        session,
        (text) =>
          text.includes("@default, @peer") &&
          text.split("\n").every((line) => measureTextWidth(line) <= 45),
      );
      const narrowLines = narrow.split("\n");
      expect(
        narrowLines.findIndex((line) => line.includes("Workspace ancestor")) -
          narrowLines.findIndex((line) => line.includes("Workspace current")),
      ).toBe(3);
      session.resize({ cols: 70, rows: 20 });
      await session.waitForText(/Workspace current/);
      await session.press("j");
      jj(peer, "edit", ancestorId);
      await harness.pressAndWaitForText(session, "r", /History refreshed/, { timeout: 10_000 });
      const moved = await session.text({ immediate: true });
      const movedLines = moved.split("\n");
      expect(
        movedLines[movedLines.findIndex((line) => line.includes("Workspace current")) + 1],
      ).toContain("@default");
      expect(
        movedLines[movedLines.findIndex((line) => line.includes("Workspace ancestor")) + 1],
      ).toContain("@peer");
      const review = await harness.pressAndWaitForText(session, "enter", /value = 'ancestor'/, {
        timeout: 15_000,
      });
      expect(review).not.toContain("value = 'current'");
      await harness.pressAndWaitForSnapshot(
        session,
        "q",
        (text) => text.includes("Jujutsu history") && text.includes("Enter Open"),
        15_000,
      );
      await session.press("f10");
      await session.press(["down", "down", "down", "down", "enter"]);
      await session.press("f10");
      await session.waitForText(/Auto-refresh history: on/);
      await session.press("escape");
      jj(peer, "edit", currentId);
      await session.waitForText(/@default, @peer/, { timeout: 15_000 });
      // The retained ancestor selection is observable through its opened diff after each refresh.
      await harness.pressAndWaitForText(session, "enter", /value = 'ancestor'/, {
        timeout: 15_000,
      });
    } finally {
      session.close();
    }
  });

  for (const cols of [70, 45]) {
    test(`compact workspace label cells select, extend and double-open at${cols} columns`, async () => {
      const workspaceName = "peer-workspace-with-a-long-name";
      const { cwd, peer, ancestorId } = createWorkspaceHistoryTestRepo(workspaceName);
      jj(peer, "edit", ancestorId);
      jj(cwd, "bookmark", "forget", "ancestor");
      const session = await harness.launchHunk({
        args: ["log", "--vcs", "jj", "--no-extensions"],
        cwd,
        cols,
        rows: 20,
      });
      try {
        await session.waitForText(new RegExp(`@${workspaceName}`), { timeout: 15000 });
        const lines = session
          .getTerminalData()
          .lines.map((line) => line.spans.map((span) => span.text).join(""));
        const ancestorLine = lines.findIndex((line) => line.includes("Workspace ancestor"));
        const nameLine = lines.findIndex((line) => line.includes(`@${workspaceName}`));
        const currentNamesLine = lines.findIndex((line) => line.includes("@default"));
        expect(nameLine - ancestorLine).toBe(cols === 70 ? 1 : 2);
        const x = lines[nameLine]!.indexOf(`@${workspaceName}`);
        clickWorkspaceTestCell(session, x, nameLine);
        await session.waitIdle();
        expect(await session.text({ immediate: true })).toContain("Workspace current");
        expect(session.getRawOutput()).not.toContain("value = 'ancestor'");
        await sleep(450);
        clickWorkspaceTestCell(
          session,
          lines[currentNamesLine]!.indexOf("@default"),
          currentNamesLine,
        );
        await session.waitIdle();
        expect(await session.text({ immediate: true })).not.toContain("Copied");
        // The ref-only ancestor reaches under the first-row ID/copy area at either placement.
        clickWorkspaceTestCell(session, cols - 6, nameLine, true);
        await session.waitIdle();
        await session.waitForText(/Review range: 2/, { timeout: 5000 });
        await session.press("escape");
        await sleep(450);
        clickWorkspaceTestCell(session, cols - 6, nameLine);
        await sleep(80);
        expect(await session.text({ immediate: true })).toContain("Workspace current");
        clickWorkspaceTestCell(session, x, nameLine);
        await session.waitForText(/value = 'ancestor'/, { timeout: 15000 });
      } finally {
        session.close();
      }
    });
  }
});

describe("HK-92 workspace visibility", () => {
  test("View toggle retains orientation, review round-trip and saved startup preference", async () => {
    const { cwd } = createWorkspaceHistoryTestRepo();
    const configHome = mkdtempSync(join(tmpdir(), "hunk-workspace-visibility-"));
    tempDirs.push(configHome);
    const options = {
      args: ["log", "--vcs", "jj", "--all", "--no-extensions", "--color", "never"],
      cwd,
      cols: 70,
      rows: 24,
      env: { XDG_CONFIG_HOME: configHome },
    };
    const session = await harness.launchHunk(options);
    try {
      const initial = await session.waitForText(/@default, @peer/, { timeout: 15000 });
      const rowIndex = initial.split("\n").findIndex((line) => line.includes("Workspace current"));
      await session.press("f10");
      await session.press("right");
      await session.waitForText(/Show workspace names/);
      await session.click("Show workspace names");
      const hidden = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("@default") && text.includes("(@, current)"),
      );
      expect(hidden.split("\n").findIndex((line) => line.includes("Workspace current"))).toBe(
        rowIndex,
      );
      expect(hidden.split("\n")[rowIndex + 1]).not.toContain("@peer");
      await harness.pressAndWaitForText(session, "enter", /value = 'current'/, { timeout: 15000 });
      await harness.pressAndWaitForSnapshot(
        session,
        "q",
        (text) => text.includes("Jujutsu history") && text.includes("Enter Open"),
        15000,
      );
      expect(await session.text()).not.toContain("@default");
      await session.press("f10");
      await session.press("right");
      await session.click("Show decorations");
      await harness.waitForSnapshot(session, (text) => !text.includes("(@, current)"));
      await session.press("f10");
      await session.press("right");
      await session.click("Show decorations");
      const restoredMaster = await harness.waitForSnapshot(session, (text) =>
        text.includes("(@, current)"),
      );
      expect(restoredMaster).not.toContain("@default");
      const prompt = await harness.pressAndWaitForText(session, "q", /Save view preferences\?/);
      expect(prompt).toContain("history_workspace_names = false");
      await session.press("s");
      expect(readFileSync(join(configHome, "hunk", "config.toml"), "utf8")).toContain(
        "history_workspace_names = false",
      );
    } finally {
      session.close();
    }
    const reopened = await harness.launchHunk(options);
    try {
      const hidden = await reopened.waitForText(/Workspace current/, { timeout: 15000 });
      expect(hidden).not.toContain("@default");
      expect(hidden).toContain("(@, current)");
      await reopened.press("f10");
      await reopened.press("right");
      await reopened.click("Show workspace names");
      await reopened.waitForText(/@default, @peer/);
    } finally {
      reopened.close();
    }
  });
});

test("workspace toggle and quit in one input burst saves the current choice", async () => {
  const cwd = createHistoryRepo();
  const configHome = mkdtempSync(join(tmpdir(), "hunk-workspace-rapid-quit-"));
  tempDirs.push(configHome);
  const configDir = join(configHome, "hunk");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.toml"),
    '[keybindings]\n"hunk.history.toggleWorkspaceNames" = "w"\n',
  );
  const session = await harness.launchHunk({
    args: ["log", "--no-extensions", "--color", "never"],
    cwd,
    cols: 100,
    rows: 24,
    env: { XDG_CONFIG_HOME: configHome },
  });
  try {
    await session.waitForText(/Second history commit/);
    session.writeRaw("wq");
    const prompt = await harness.waitForSnapshot(
      session,
      (text) =>
        text.includes("Save view preferences?") &&
        text.includes("+ history_workspace_names = false") &&
        text.includes("never ask"),
      5000,
    );
    expect(prompt).toContain("history_workspace_names = false");
    await session.press("s");
    expect(readFileSync(join(configDir, "config.toml"), "utf8")).toContain(
      "history_workspace_names = false",
    );
  } finally {
    session.close();
  }
});

test("unchanged default workspace visibility does not prompt on quit", async () => {
  const cwd = createHistoryRepo();
  const configHome = mkdtempSync(join(tmpdir(), "hunk-workspace-default-quit-"));
  tempDirs.push(configHome);
  const session = await harness.launchHunk({
    args: ["log", "--no-extensions", "--color", "never"],
    cwd,
    cols: 100,
    rows: 24,
    env: { XDG_CONFIG_HOME: configHome },
  });
  try {
    await session.waitForText(/Second history commit/);
    await session.press("q");
    expect(await session.waitForExit(5000)).toBe(true);
    expect(session.getRawOutput()).not.toContain("Save view preferences?");
  } finally {
    session.close();
  }
});

test("compact workspace hiding collapses a spill row while preserving the bookmark and current title", async () => {
  const { cwd } = createWorkspaceHistoryTestRepo("peer-workspace-with-a-very-long-recorded-name");
  const session = await harness.launchHunk({
    args: ["log", "--vcs", "jj", "--all", "--no-extensions"],
    cwd,
    cols: 70,
    rows: 24,
  });
  try {
    const initial = await session.waitForText(/@default, @peer-workspace/, { timeout: 15000 });
    const lines = initial.split("\n"),
      current = lines.findIndex((line) => line.includes("Workspace current")),
      ancestor = lines.findIndex((line) => line.includes("Workspace ancestor"));
    expect(ancestor - current).toBe(3);
    expect(lines[current + 1]).toContain("(@, current)");
    await session.press("f10");
    await session.press("right");
    await session.click("Show workspace names");
    const hidden = await harness.waitForSnapshot(
      session,
      (text) => !text.includes("@default") && text.includes("(@, current)"),
    );
    const hiddenLines = hidden.split("\n");
    expect(hiddenLines.findIndex((line) => line.includes("Workspace current"))).toBe(current);
    expect(hiddenLines.findIndex((line) => line.includes("Workspace ancestor")) - current).toBe(2);
    await session.press("f10");
    await session.press("right");
    await session.click("Show workspace names");
    const restored = await session.waitForText(/@default, @peer-workspace/);
    expect(
      restored.split("\n").findIndex((line) => line.includes("Workspace ancestor")) - current,
    ).toBe(3);
  } finally {
    session.close();
  }
});

describe("ordinary history selection", () => {
  test("keeps highlighted and explicit range review while x no longer marks revisions", async () => {
    const cwd = createHistoryRepo();
    writeFileSync(join(cwd, "history.ts"), "export const historyValue = 'third';\n");
    git(cwd, ["commit", "-qam", "Third history commit"]);
    const session = await harness.launchHunk({
      args: ["log", "--color", "never", "--no-extensions"],
      cwd,
      cols: 120,
      rows: 24,
    });
    try {
      await session.waitForText(/Third history commit/, { timeout: 15_000 });
      await session.press("x");
      await session.press("down");
      const review = await harness.pressAndWaitForText(
        session,
        "enter",
        /historyValue = 'second'/,
        { timeout: 15_000 },
      );
      expect(review).not.toContain("Third history commit");
      expect(review).not.toContain("root-only.ts");
      const history = await returnToHistory(session);
      expect(history).not.toContain("marked");
      expect(history).not.toContain("[ ]");
      await session.press("up");
      await session.press("v");
      await session.press("down");
      await session.press("down");
      const range = await harness.pressAndWaitForText(session, "enter", /historyValue = 'third'/, {
        timeout: 15_000,
      });
      expect(range).toContain("root-only.ts");
      expect(range).toContain("Second history commit");
      expect(range).toContain("First history commit");
      await returnToHistory(session);
      await session.press("escape");
      expect(await session.text()).not.toContain("Review range:");
    } finally {
      session.close();
    }
  });
  test("graph cells focus rows without selecting revisions; Ctrl targets do not select and Shift still forms a review range", async () => {
    const cwd = createHistoryRepo();
    const session = await harness.launchHunk({
      args: ["log", "--color", "never", "--no-extensions"],
      cwd,
      cols: 100,
      rows: 20,
    });
    try {
      let text = await session.waitForText(/First history commit/, { timeout: 15_000 });
      const lines = text.replace(/^\n/, "").split("\n");
      const row = lines.findIndex((line) => line.includes("First history commit"));
      session.writeRaw(`\x1b[<0;4;${row + 1}M\x1b[<0;4;${row + 1}m`);
      await session.waitIdle();
      text = await session.text();
      expect(text).not.toContain("marked");
      expect(text).not.toContain("[x]");
      expect(
        await session.text({
          only: { background: "#404040" },
          waitFor: (text) => text.includes("First history commit"),
        }),
      ).toContain("First history commit");
      await session.press("up");
      expect(
        await session.text({
          only: { background: "#404040" },
          waitFor: (text) => text.includes("Second history commit"),
        }),
      ).toContain("Second history commit");
      const idX = lines[row]!.search(/[0-9a-f]{8}\s+⧉/);
      session.writeRaw(`\x1b[<16;${idX + 1};${row + 1}M\x1b[<16;${idX + 1};${row + 1}m`);
      await session.waitIdle();
      expect(await session.text()).not.toContain("marked");
      session.writeRaw(`\x1b[<4;${idX + 1};${row + 1}M\x1b[<4;${idX + 1};${row + 1}m`);
      await session.waitForText(/Review range: 2/);
      await session.press("escape");
      expect(await session.text()).not.toContain("Review range:");
    } finally {
      session.close();
    }
  });
  for (const cols of [42, 60, 80, 120])
    for (const rows of [12, 20])
      test(`unsupported operation refuses without selection at ${cols} columns and ${rows} rows`, async () => {
        const cwd = createHistoryRepo();
        const session = await harness.launchHunk({
          args: ["log", "--color", "never", "--no-extensions"],
          cwd,
          cols,
          rows,
        });
        try {
          await session.waitForText(/Second history com/, { timeout: 15_000 });
          session.writeRaw("S");
          const text = await session.waitForText(/provider does not offer/, { timeout: 10_000 });
          expect(text).not.toContain("✓");
          expect(text).not.toContain("Choose squash sources");
          await session.press("escape");
          await harness.waitForSnapshot(
            session,
            (text) => !text.includes("Operation result") && text.includes("No explicit selection"),
            10_000,
          );
        } finally {
          session.close();
        }
      });
});

test("candidate diff command renders an actual changed file in a real terminal", async () => {
  const cwd = createHistoryRepo();
  writeFileSync(join(cwd, "history.ts"), "export const historyValue = 'candidate diff';\n");
  const session = await harness.launchHunk({
    args: ["diff", "--no-extensions"],
    cwd,
    cols: 100,
    rows: 20,
  });
  try {
    const text = await session.waitForText(/candidate diff/, { timeout: 15_000 });
    expect(text).toContain("history.ts");
    expect(text).toContain("historyValue");
  } finally {
    session.close();
  }
});

/** Build the HK-19 fixture: a merge of mainline work and an old-based sibling, trunk set to `main`. */
function createHk19PtyTestRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "hunk-hk19-pty-"));
  const configHome = mkdtempSync(join(tmpdir(), "hunk-hk19-pty-config-"));
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
  const add = (bookmark: string, subject: string, ...parents: string[]) => {
    jj("new", ...parents);
    writeFileSync(join(cwd, `${bookmark}.ts`), `export const ${bookmark} = true;\n`);
    jj("describe", "-m", subject);
    const id = jj("log", "--no-graph", "-r", "@", "-T", "commit_id");
    jj("bookmark", "create", bookmark, "-r", id);
    return id;
  };
  const oldA = add("old-a", "Hidden old A", "root()");
  const oldB = add("old-b", "Hidden old B", oldA);
  const main = add("main", "Mainline boundary", oldB);
  const feature = add("feature", "Feature current work", main);
  const sibling = add("sibling", "Old-based sibling", oldA);
  const other = add("other", "Protected branch", main);
  add("merge-work", "Merge current work", feature, sibling);
  jj("config", "set", "--repo", 'revset-aliases."trunk()"', "main");
  jj("config", "set", "--repo", 'revset-aliases."immutable_heads()"', `main | ${other}`);
  return { cwd, jj, env };
}

const HK19_LAUNCH_REVSET = "(((trunk()..visible_heads()) | trunk()) ~ root())";
const HK19_ARGS = ["log", "--vcs", "jj", "--color", "never", "--no-extensions", "-n", "100"];

describe("HK-19.1 revset editor", () => {
  (Bun.which("jj") ? test : test.skip)(
    "custom revsets connect direct parents, terminate gaps, refresh and Reset in both views",
    async () => {
      const { cwd, env } = createHk19PtyTestRepo();
      const session = await harness.launchHunk({ args: HK19_ARGS, cwd, env, cols: 100, rows: 32 });
      /** Apply one literal query through the mounted native editor. */
      const apply = async (expression: string) => {
        session.writeRaw(`L\x15${expression}\x1bOQ`);
        return harness.waitForSnapshot(
          session,
          (text) => text.includes(`Revset: ${expression}`) && !text.includes("Edit revset"),
          15_000,
        );
      };
      /** Toggle the existing menu item rather than assuming a graph shortcut. */
      const toggleGraph = async () => {
        await session.press("f10");
        await session.press("right");
        await session.press("down");
        await session.press("enter");
      };
      /** Read the ancestry continuation immediately below a visible commit's title. */
      const continuation = (text: string, subject: string) => {
        const lines = text.split("\n");
        return lines[lines.findIndex((line) => line.includes(subject)) + 1]!;
      };
      try {
        await session.waitForText(/Launch policy · Limit: 100/, { timeout: 15_000 });
        const regular = await apply("feature | main | old-b");
        expect(regular).toContain("Commits on");
        expect(regular).toContain("~ omitted parent");
        expect(regular).not.toContain("older history hidden");
        await toggleGraph();
        const connected = await harness.waitForSnapshot(
          session,
          (text) => text.includes("●") && !text.includes("Commits on"),
          5_000,
        );
        expect(continuation(connected, "Feature current work")).toContain("│");
        expect(continuation(connected, "Mainline boundary")).toContain("│");
        // A query skipping main cannot pretend feature's real parent is old-b.
        const gap = await apply("feature | old-b");
        expect(gap).not.toContain("Mainline boundary");
        const between = gap.split("Feature current work")[1]!.split("Hidden old B")[0]!;
        expect(between).toMatch(/\n\s*~\s*\n/);
        expect(gap).toContain("Custom revset: range review unavailable.");
        await session.press("r");
        const refreshed = await harness.waitForSnapshot(
          session,
          (text) => text.includes("History refreshed."),
          15_000,
        );
        expect(refreshed).toContain("Hidden old B");
        expect(refreshed).not.toContain("Mainline boundary");
        session.writeRaw("v");
        await session.waitForText(/Multi-commit selection is unavailable/, { timeout: 5_000 });
        // Enter still reviews feature against its omitted real parent, main.
        await session.press("enter");
        const review = await session.waitForText(/export const feature = true/, {
          timeout: 15_000,
        });
        expect(review).not.toContain("export const main = true");
        await harness.pressAndWaitForSnapshot(
          session,
          "q",
          (text) => text.includes("Custom revset") && text.includes("Enter Open"),
          15_000,
        );
        await toggleGraph();
        const groupedGap = await harness.waitForSnapshot(
          session,
          (text) => text.includes("Commits on"),
          5_000,
        );
        expect(groupedGap).toMatch(/\n\s*~\s*\n/);
        session.writeRaw("L");
        await session.waitForText(/Edit revset/, { timeout: 5_000 });
        session.sendKey("f3");
        const reset = await harness.waitForSnapshot(
          session,
          (text) => text.includes("Launch policy · Limit: 100") && !text.includes("Edit revset"),
          15_000,
        );
        expect(reset).toContain("Feature current work");
        expect(reset).toContain("Jujutsu · 5 commits");
        expect(reset).toContain("~ older history hidden");
        expect(reset).not.toContain("Custom revset");
        await toggleGraph();
        const resetGraph = await harness.waitForSnapshot(
          session,
          (text) => text.includes("●") && !text.includes("Commits on"),
          5_000,
        );
        expect(resetGraph).toContain("~ older history hidden");
        expect(resetGraph).not.toContain("~ omitted parent");
      } finally {
        session.close();
      }
    },
  );

  (Bun.which("jj") ? test : test.skip)(
    "opening, Ctrl+U, text and Apply in one raw write replace the launch expression",
    async () => {
      const { cwd, env } = createHk19PtyTestRepo();
      const session = await harness.launchHunk({ args: HK19_ARGS, cwd, env, cols: 80, rows: 32 });
      try {
        await session.waitForText(/Launch policy · Limit: 100/, { timeout: 15_000 });
        session.writeRaw("L\x15@-\x1bOQ");
        const custom = await harness.waitForSnapshot(
          session,
          (text) => text.includes("Custom revset · Limit: 100") && !text.includes("Edit revset"),
          15_000,
        );
        expect(custom).toContain("Revset: @-");
        expect(custom).toContain("Old-based sibling");
        expect(custom).toContain("Feature current work");
        expect(custom).not.toContain("Merge current work");
        expect(custom).not.toContain("Revset not applied");
      } finally {
        session.close();
      }
    },
  );

  (Bun.which("jj") ? test : test.skip)(
    "L edits the active revset: apply, custom row, restriction, reset and a reused previous input",
    async () => {
      const { cwd, env } = createHk19PtyTestRepo();
      const session = await harness.launchHunk({ args: HK19_ARGS, cwd, env, cols: 80, rows: 32 });
      try {
        const launch = await session.waitForText(/Launch policy · Limit: 100/, { timeout: 15_000 });
        expect(launch).toContain(`Revset: ${HK19_LAUNCH_REVSET}`);
        expect(launch).toContain("Merge current work");
        expect(launch).toContain("L edit revset");
        expect(launch).not.toContain("Custom revset");

        session.writeRaw("L");
        const editor = await session.waitForText(/Edit revset/, { timeout: 5_000 });
        expect(editor).toContain("No previous inputs yet.");
        expect(editor).toContain("[F2] Apply  [F3] Reset  [Esc] Cancel");
        session.sendKey(["ctrl", "u"]);
        await session.type("@-");
        await session.waitForText(/Revset: @-/, { timeout: 5_000 });
        session.sendKey("f2");
        const custom = await harness.waitForSnapshot(
          session,
          (text) =>
            text.includes("Old-based sibling") &&
            text.includes("Selected newest; previous not loaded.") &&
            text.includes("Custom revset · Limit: 100") &&
            !text.includes("Edit revset"),
          15_000,
        );
        expect(custom).toContain("Revset: @-");
        expect(custom).toContain("Feature current work");
        expect(custom).not.toContain("Merge current work");
        expect(custom).toContain("Custom revset: range review unavailable. ~ omitted parent");
        expect(custom).toContain("Selected newest; previous not loaded.");

        // Reset restores launch policy and all five rows while retaining reading context.
        session.writeRaw("L");
        await session.waitForText(/Edit revset/, { timeout: 5_000 });
        session.sendKey("f3");
        const reset = await harness.waitForSnapshot(
          session,
          (text) =>
            text.includes("Launch policy · Limit: 100") &&
            text.includes("Jujutsu · 5 commits") &&
            text.includes("Old-based sibling") &&
            !text.includes("Custom revset") &&
            !text.includes("Edit revset"),
          15_000,
        );
        expect(reset).toContain(`Revset: ${HK19_LAUNCH_REVSET}`);
        expect(reset).not.toContain("range review unavailable");
        await harness.pressAndWaitForText(session, "home", /Merge current work/);

        // The earlier input is offered again; Enter inserts it without applying.
        session.writeRaw("L");
        const reopened = await session.waitForText(/Previous inputs/, { timeout: 5_000 });
        expect(reopened).toContain("@-");
        session.sendKey("tab");
        await session.waitForText(/Enter insert/, { timeout: 5_000 });
        session.sendKey("enter");
        const inserted = await session.waitForText(/Revset: @-/, { timeout: 5_000 });
        expect(inserted).toContain("Edit revset");
        expect(inserted).toContain("Custom revset · Limit: 100");
        session.sendKey("f2");
        await harness.waitForSnapshot(
          session,
          (text) => text.includes("Old-based sibling") && !text.includes("Edit revset"),
          15_000,
        );
      } finally {
        session.close();
      }
    },
  );

  (Bun.which("jj") ? test : test.skip)(
    "a failing revset names JJ's reason without its diagram and keeps the draft and the accepted view",
    async () => {
      const { cwd, env } = createHk19PtyTestRepo();
      const session = await harness.launchHunk({ args: HK19_ARGS, cwd, env, cols: 80, rows: 32 });
      try {
        await session.waitForText(/Launch policy · Limit: 100/, { timeout: 15_000 });
        session.writeRaw("L");
        await session.waitForText(/Edit revset/, { timeout: 5_000 });
        session.sendKey("end");
        await session.type(" & missing_function()");
        session.sendKey("f2");
        const failed = await session.waitForText(/Revset not applied:/, { timeout: 15_000 });
        expect(failed).toContain("Function `missing_function` doesn't exist");
        expect(failed).toMatch(/Caused by:\s+--> 1:\d+/);
        expect(failed).not.toContain("Failed to parse revset");
        expect(failed).not.toMatch(/^\s*\d*\s*\|/m);
        expect(failed).toContain("Edit revset");
        expect(failed).toContain("Custom revset · Limit: 100");
        session.sendKey("escape");
        const closed = await harness.waitForSnapshot(
          session,
          (text) => !text.includes("Edit revset"),
          5_000,
        );
        // The failure changed nothing behind the editor.
        expect(closed).toContain("Launch policy · Limit: 100");
        expect(closed).toContain("Merge current work");
      } finally {
        session.close();
      }
    },
  );

  (Bun.which("jj") ? test : test.skip)(
    "under 15 rows launch policy adds nothing, the compact editor fits, and a custom revset adds one row",
    async () => {
      const { cwd, env } = createHk19PtyTestRepo();
      const session = await harness.launchHunk({ args: HK19_ARGS, cwd, env, cols: 40, rows: 12 });
      try {
        const launch = await session.waitForText(/Merge current/, { timeout: 15_000 });
        expect(launch).not.toContain("Revset:");
        expect(launch).not.toContain("Launch policy");
        expect(launch).not.toContain("Limit:");
        session.writeRaw("L");
        const editor = await session.waitForText(/Edit revset/, { timeout: 5_000 });
        expect(editor).toContain("Launch policy · Limit: 100");
        expect(editor).toContain("[F2] Apply  [F3] Reset");
        expect(editor).toContain("[Esc] Cancel");
        session.sendKey(["ctrl", "u"]);
        await session.type("@-");
        session.sendKey("f2");
        const custom = await harness.waitForSnapshot(
          session,
          (text) => text.includes("Custom revset: @-") && !text.includes("Edit revset"),
          15_000,
        );
        expect(custom).not.toContain("graph links");
        expect(custom).not.toContain("Limit:");
      } finally {
        session.close();
      }
    },
  );

  (Bun.which("jj") ? test : test.skip)(
    "keys written together each see the previous key's result: text and F2 in one write apply the text",
    async () => {
      const { cwd, env } = createHk19PtyTestRepo();
      const session = await harness.launchHunk({ args: HK19_ARGS, cwd, env, cols: 80, rows: 32 });
      try {
        await session.waitForText(/Launch policy · Limit: 100/, { timeout: 15_000 });
        session.writeRaw("L");
        await session.waitForText(/Edit revset/, { timeout: 5_000 });
        session.sendKey(["ctrl", "u"]);
        await session.type("@");
        await session.waitForText(/Revset: @\s/, { timeout: 5_000 });
        // One write: the next character and F2 reach the app in the same chunk.
        session.writeRaw("-\x1bOQ");
        const custom = await harness.waitForSnapshot(
          session,
          (text) => text.includes("Custom revset · Limit: 100") && !text.includes("Edit revset"),
          15_000,
        );
        expect(custom).toContain("Revset: @-");
        expect(custom).toContain("Old-based sibling");
        expect(custom).not.toContain("Merge current work");
      } finally {
        session.close();
      }
    },
  );

  for (const [cols, rows] of [
    [40, 8],
    [40, 10],
    [80, 9],
  ] as const) {
    (Bun.which("jj") ? test : test.skip)(
      `the editor stays inside its frame at ${cols}x${rows}: nothing on the border or the status row`,
      async () => {
        const { cwd, env } = createHk19PtyTestRepo();
        const session = await harness.launchHunk({ args: HK19_ARGS, cwd, env, cols, rows });
        try {
          await session.waitForText(/Merge current/, { timeout: 15_000 });
          session.writeRaw("L");
          const screen = await session.waitForText(/Edit revset/, { timeout: 5_000 });
          const lines = screen.split("\n");
          const top = lines.findIndex((line) => line.includes("┌"));
          const bottom = lines.findIndex((line) => line.includes("└"));
          expect(top).toBeGreaterThanOrEqual(0);
          expect(bottom).toBeGreaterThan(top);
          // Only the frame's own border glyphs sit on its border rows; history may show around them.
          expect(lines[top]!.replace(/.*┌─+┐/, "")).not.toMatch(/\[F\d\]|\[Esc\]/);
          expect(lines[top]).toMatch(/┌─+┐/);
          expect(lines[bottom]).toMatch(/└─+┘/);
          // The three actions stay, and the status row below the frame holds no editor text.
          for (const action of ["[F2] Apply", "[F3] Reset", "[Esc] Cancel"])
            expect(screen).toContain(action);
          const status = lines.at(-1) ?? "";
          expect(status).not.toMatch(/\[F\d\]|\[Esc\]|Enter (apply|insert)/);
          expect(bottom).toBeLessThan(lines.length - 1);
        } finally {
          session.close();
        }
      },
    );
  }

  (Bun.which("jj") ? test : test.skip)(
    "resizing with the editor open keeps the draft through compact and too-small screens",
    async () => {
      const { cwd, env } = createHk19PtyTestRepo();
      const session = await harness.launchHunk({ args: HK19_ARGS, cwd, env, cols: 80, rows: 32 });
      try {
        await session.waitForText(/Launch policy · Limit: 100/, { timeout: 15_000 });
        session.writeRaw("L");
        await session.waitForText(/Edit revset/, { timeout: 5_000 });
        session.sendKey(["ctrl", "u"]);
        await session.type("@-");
        await session.waitForText(/Revset: @-/, { timeout: 5_000 });
        session.resize({ cols: 40, rows: 12 });
        const compact = await session.waitForText(/\[Esc\] Cancel/, { timeout: 5_000 });
        expect(compact).toContain("Revset: @-");
        session.resize({ cols: 24, rows: 8 });
        await session.waitForText(/Terminal too small/, { timeout: 5_000 });
        session.resize({ cols: 80, rows: 32 });
        const back = await session.waitForText(/Revset: @-/, { timeout: 5_000 });
        expect(back).toContain("Edit revset");
        session.sendKey("f2");
        await harness.waitForSnapshot(
          session,
          (text) => text.includes("Old-based sibling") && !text.includes("Edit revset"),
          15_000,
        );
      } finally {
        session.close();
      }
    },
  );

  (Bun.which("jj") ? test : test.skip)(
    "Escape closes the editor before it clears an active selection, and a custom revset refuses a range",
    async () => {
      const { cwd, env } = createHk19PtyTestRepo();
      const session = await harness.launchHunk({ args: HK19_ARGS, cwd, env, cols: 120, rows: 32 });
      try {
        await session.waitForText(/Launch policy · Limit: 100/, { timeout: 15_000 });
        session.writeRaw("v\x1b[B");
        await session.waitForText(/Review range: 2/, { timeout: 5_000 });
        session.writeRaw("L");
        await session.waitForText(/Edit revset/, { timeout: 5_000 });
        session.sendKey("escape");
        const closed = await harness.waitForSnapshot(
          session,
          (text) => !text.includes("Edit revset"),
          5_000,
        );
        expect(closed).toContain("Review range: 2");

        session.writeRaw("L");
        await session.waitForText(/Edit revset/, { timeout: 5_000 });
        session.sendKey(["ctrl", "u"]);
        await session.type("all()");
        session.sendKey("f2");
        await harness.waitForSnapshot(
          session,
          (text) => text.includes("Custom revset · Limit: 100") && !text.includes("Edit revset"),
          15_000,
        );
        session.writeRaw("v");
        const refused = await session.waitForText(/Multi-commit selection is unavailable/, {
          timeout: 5_000,
        });
        expect(refused).not.toContain("Review range:");
      } finally {
        session.close();
      }
    },
  );
});

describe("HK-19.1 Ctrl+C with the editor open", () => {
  /** Whether the app has left its alternate screen, which is how a quit shows in the raw output. */
  const hasQuit = (session: Session) => session.getRawOutput().includes("\x1b[?1049l");
  const waitForQuit = async (session: Session, milliseconds: number) => {
    const startedAt = Date.now();
    while (!hasQuit(session) && Date.now() - startedAt < milliseconds) await Bun.sleep(25);
    return hasQuit(session);
  };

  (Bun.which("jj") ? test : test.skip)(
    "Ctrl+C closes an idle editor and Hunk stays; with no editor it quits",
    async () => {
      const { cwd, env } = createHk19PtyTestRepo();
      const session = await harness.launchHunk({ args: HK19_ARGS, cwd, env, cols: 80, rows: 32 });
      try {
        await session.waitForText(/Launch policy · Limit: 100/, { timeout: 15_000 });
        session.writeRaw("L");
        await session.waitForText(/Edit revset/, { timeout: 5_000 });
        session.writeRaw("\x03");
        const closed = await harness.waitForSnapshot(
          session,
          (text) => !text.includes("Edit revset"),
          5_000,
        );
        expect(closed).toContain("Launch policy · Limit: 100");
        expect(await waitForQuit(session, 1_000)).toBeFalse();
        // The editor opens again, so the session is alive and has not been told to quit.
        session.writeRaw("L");
        await session.waitForText(/Edit revset/, { timeout: 5_000 });
        session.sendKey("escape");
        await harness.waitForSnapshot(session, (text) => !text.includes("Edit revset"), 5_000);
        // With the editor closed Ctrl+C quits as it always did.
        session.writeRaw("\x03");
        expect(await waitForQuit(session, 3_000)).toBeTrue();
      } finally {
        session.close();
      }
    },
  );

  (Bun.which("jj") ? test : test.skip)(
    "Ctrl+C while applying cancels the request and keeps the draft; a second closes the editor",
    async () => {
      const { cwd, env } = createHk19PtyTestRepo();
      const realJj = Bun.which("jj");
      if (!realJj) throw new Error("jj is required for this fixture.");
      const bin = mkdtempSync(join(tmpdir(), "hunk-hk19-slow-jj-"));
      tempDirs.push(bin);
      const started = join(bin, "started");
      const release = join(bin, "release");
      const wrapper = join(bin, "jj");
      writeFileSync(
        wrapper,
        `#!/bin/sh\ncase " $* " in *"all()"*) : > ${quoteTestShellArgument(started)}; while [ ! -e ${quoteTestShellArgument(release)} ]; do sleep 0.05; done ;; esac\nexec ${quoteTestShellArgument(realJj)} "$@"\n`,
      );
      chmodSync(wrapper, 0o755);
      const session = await harness.launchHunk({
        args: HK19_ARGS,
        cwd,
        env: { ...env, PATH: `${bin}:${process.env.PATH ?? ""}` },
        cols: 80,
        rows: 32,
      });
      try {
        await session.waitForText(/Launch policy · Limit: 100/, { timeout: 15_000 });
        session.writeRaw("L");
        await session.waitForText(/Edit revset/, { timeout: 5_000 });
        session.sendKey(["ctrl", "u"]);
        await session.type("all()");
        session.sendKey("f2");
        await session.waitForText(/Applying revset…/, { timeout: 10_000 });
        await waitForTestFile(started);
        session.writeRaw("\x03");
        const back = await harness.waitForSnapshot(
          session,
          (text) => text.includes("Edit revset") && !text.includes("Applying revset…"),
          5_000,
        );
        expect(back).toContain("Revset: all()");
        expect(await waitForQuit(session, 1_000)).toBeFalse();
        session.writeRaw("\x03");
        const closed = await harness.waitForSnapshot(
          session,
          (text) => !text.includes("Edit revset"),
          5_000,
        );
        expect(closed).toContain("Launch policy · Limit: 100");
        expect(await waitForQuit(session, 1_000)).toBeFalse();
        writeFileSync(release, "");
      } finally {
        writeFileSync(release, "");
        session.close();
      }
    },
  );
});

describe("HK-19.1 on Git history", () => {
  test("shows nothing new and L does nothing", async () => {
    const cwd = createHistoryRepo();
    const session = await harness.launchHunk({
      args: ["log", "--color", "never", "--no-extensions"],
      cwd,
      cols: 100,
      rows: 24,
    });
    try {
      const before = await session.waitForText(/Git · 2 commits/, { timeout: 15_000 });
      for (const text of ["Revset:", "Launch policy", "Limit:", "edit revset"])
        expect(before).not.toContain(text);
      session.writeRaw("L");
      await sleep(400);
      const after = await session.text({ immediate: true });
      expect(after).not.toContain("Edit revset");
      expect(after).not.toContain("Revset:");
      expect(after).toContain("Git · 2 commits");
      await session.press("f10");
      await session.press("right");
      expect(await session.text({ immediate: true })).not.toContain("Edit revset");
    } finally {
      session.close();
    }
  });
});
