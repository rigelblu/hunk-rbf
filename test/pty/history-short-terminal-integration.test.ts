import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();
const tempDirs: string[] = [];
setDefaultTimeout(45_000);

/** Run one Git fixture command with deterministic author identity. */
function runTestGit(cwd: string, args: string[]) {
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
    },
  });
  if (proc.exitCode !== 0) throw new Error(proc.stderr?.toString() ?? "Git fixture failed.");
}

/** Create a linear history whose newest commit is `Commit 01`. */
function createShortTerminalTestRepo(count: number) {
  const cwd = mkdtempSync(join(tmpdir(), "hunk-log-short-pty-"));
  tempDirs.push(cwd);
  runTestGit(cwd, ["init", "-q"]);
  for (let index = count; index >= 1; index -= 1) {
    writeFileSync(join(cwd, "notes.txt"), `${index}\n`);
    runTestGit(cwd, ["add", "notes.txt"]);
    runTestGit(cwd, ["commit", "-qm", `Commit ${String(index).padStart(2, "0")}`]);
  }
  return cwd;
}

/** Open history in a terminal whose body is shorter than one commit entry. */
async function launchShortTestHistory(cwd: string) {
  const session = await harness.launchHunk({
    args: ["log", "--color", "never", "--no-extensions"],
    cwd,
    cols: 80,
    rows: 5,
  });
  await session.waitForText(/8 commits/, { timeout: 15_000 });
  return session;
}

/** Match the selection marker on one commit's row after the terminal grows again. */
function selectedCommit(subject: string) {
  return new RegExp(`^ > .*${subject}`, "m");
}

afterEach(async () => {
  await harness.cleanup();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("history in a terminal shorter than one entry", () => {
  test("PageDown moves the selection on every press", async () => {
    const session = await launchShortTestHistory(createShortTerminalTestRepo(8));
    try {
      for (let press = 0; press < 4; press += 1) await session.press("pagedown");
      session.resize({ cols: 80, rows: 14 });
      const grown = await harness.waitForSnapshot(
        session,
        (text) => /^ > .*Commit \d\d/m.test(text),
        10_000,
      );
      expect(grown).toMatch(selectedCommit("Commit 05"));
    } finally {
      session.close();
    }
  });

  test("the wheel moves the selection on every step", async () => {
    const session = await launchShortTestHistory(createShortTerminalTestRepo(8));
    try {
      await session.scrollDown(1);
      await session.scrollDown(1);
      session.resize({ cols: 80, rows: 14 });
      const grown = await harness.waitForSnapshot(
        session,
        (text) => /^ > .*Commit \d\d/m.test(text),
        10_000,
      );
      expect(grown).toMatch(selectedCommit("Commit 07"));
    } finally {
      session.close();
    }
  });
});
