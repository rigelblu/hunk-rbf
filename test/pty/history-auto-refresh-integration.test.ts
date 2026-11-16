import { afterEach, describe, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();
const tempDirs: string[] = [];
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

afterEach(async () => {
  await harness.cleanup();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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
});
