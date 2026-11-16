import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();
const tempDirs: string[] = [];
const jjTest = Bun.which("jj") ? test : test.skip;
const emptyJjConfig = join(
  mkdtempSync(join(tmpdir(), "hunk-auto-refresh-jj-config-")),
  "config.toml",
);
writeFileSync(emptyJjConfig, "");
setDefaultTimeout(45_000);

/** Run one Git fixture command with a deterministic identity and no user or system Git config. */
function git(cwd: string, args: string[]) {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: join(cwd, ".absent-gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Refresh Tester",
      GIT_AUTHOR_EMAIL: "refresh@example.com",
      GIT_COMMITTER_NAME: "Refresh Tester",
      GIT_COMMITTER_EMAIL: "refresh@example.com",
    },
  });
  if (proc.exitCode !== 0) throw new Error(proc.stderr?.toString() ?? "Git fixture failed.");
}

/** Create a Git repository with no commits whose repository config starts auto-refresh. */
function createUnbornAutoRefreshRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "hunk-auto-refresh-unborn-"));
  tempDirs.push(cwd);
  git(cwd, ["init", "-q"]);
  mkdirSync(join(cwd, ".hunk"), { recursive: true });
  writeFileSync(join(cwd, ".hunk", "config.toml"), "history_auto_refresh = true\n");
  return cwd;
}

/** Run one JJ fixture command with a deterministic identity, no commit signing and no user config. */
function jj(cwd: string, args: string[]) {
  const proc = Bun.spawnSync(
    [
      "jj",
      "--config",
      'user.name="Refresh Tester"',
      "--config",
      'user.email="refresh@example.com"',
      "--config",
      'signing.behavior="drop"',
      ...args,
    ],
    {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, JJ_CONFIG: emptyJjConfig },
    },
  );
  if (proc.exitCode !== 0) throw new Error(proc.stderr?.toString() ?? "JJ fixture failed.");
}

/** Create a JJ repository and a second workspace whose repository config starts auto-refresh. */
function createSecondaryJjWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "hunk-auto-refresh-jj-"));
  tempDirs.push(root);
  const primary = join(root, "primary");
  mkdirSync(primary);
  jj(primary, ["git", "init", "--no-colocate"]);
  writeFileSync(join(primary, "file.txt"), "first\n");
  jj(primary, ["commit", "-m", "First JJ change"]);
  const secondary = join(root, "secondary");
  jj(primary, ["workspace", "add", secondary]);
  mkdirSync(join(secondary, ".hunk"), { recursive: true });
  writeFileSync(join(secondary, ".hunk", "config.toml"), "history_auto_refresh = true\n");
  return secondary;
}

afterEach(async () => {
  await harness.cleanup();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(dirname(emptyJjConfig), { recursive: true, force: true });
});

describe("PTY history auto-refresh", () => {
  test("keeps auto-refresh on in a new Git repository and shows its first commit", async () => {
    const cwd = createUnbornAutoRefreshRepo();
    const session = await harness.launchHunk({
      args: ["log", "--vcs", "git", "--color", "never", "--no-extensions"],
      cwd,
      cols: 90,
      rows: 18,
    });
    try {
      await session.waitForText(/No commits found\./, { timeout: 15_000 });
      await harness.pressAndWaitForText(session, "f10", /Auto-refresh history: on/, {
        timeout: 5_000,
      });
      await session.press("escape");

      writeFileSync(join(cwd, "first.ts"), "export const first = true;\n");
      git(cwd, ["add", "first.ts"]);
      git(cwd, ["commit", "-qm", "First commit in a new repository"]);
      // Keep this wait well under `healthyCheckMs` (packages/hunk/src/core/watch/controller.ts):
      // with a healthy watcher, the Git metadata event delivers the commit before any safety check.
      await session.waitForText(/First commit in a new repository/, { timeout: 5_000 });
      await session.press("q");
    } finally {
      session.close();
    }
  });

  jjTest("refreshes history from a secondary JJ workspace without a watch error", async () => {
    const cwd = createSecondaryJjWorkspace();
    const session = await harness.launchHunk({
      args: ["log", "--vcs", "jj", "--color", "never", "--no-extensions"],
      cwd,
      cols: 100,
      rows: 18,
    });
    try {
      await session.waitForText(/First JJ change/, { timeout: 15_000 });
      await harness.pressAndWaitForText(session, "f10", /Auto-refresh history: on/, {
        timeout: 5_000,
      });
      await session.press("escape");
      // Guard the fix here, and only here: a watcher that can't start still refreshes through the
      // `degradedCheckMs` fallback poll (packages/hunk/src/core/watch/controller.ts), so the
      // describe below appears either way. Without the fix, starting the watcher fails and posts
      // the notice.
      await expect(
        session.waitForText(/Auto-refresh check failed/, { timeout: 3_000 }),
      ).rejects.toThrow();

      jj(cwd, ["describe", "-m", "Described in the secondary workspace"]);
      await session.waitForText(/Described in the secondary workspace/, { timeout: 5_000 });
      await session.press("q");
    } finally {
      session.close();
    }
  });
});
