import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { parseGitHubPrInvocation } from "./parsing";
import {
  classifyGitLookupFailure,
  parseGitHubRemoteRepository,
  readGitBranch,
  readGitHeadSha,
  readGitOrigin,
  resolveGitHubPullRequest,
  resolveGitHubRepository,
} from "./repository";

/** Run fixture Git commands with a hard deadline and fail on unsuccessful exits. */
function runGitTest(args: string[], options: { cwd?: string } = {}): string {
  const result = Bun.spawnSync(["git", ...args], {
    ...options,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  if (!result.success) {
    throw new Error(`Fixture Git command failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

/** Run native lookups in a bounded application runtime outside bun:test's event loop. */
function readGitRepositoryTestResult(
  directory: string,
  query: "branch" | "head" | "checkout",
): { value?: unknown; error?: string } {
  const script = `
    import { readGitBranch, readGitHeadSha, readGitCheckout } from ${JSON.stringify(new URL("./repository.ts", import.meta.url).href)};
    try {
      const lookup = { branch: readGitBranch, head: readGitHeadSha, checkout: readGitCheckout }[${JSON.stringify(query)}];
      const value = await lookup(process.cwd(), new AbortController().signal);
      console.log(JSON.stringify({ value }));
    } catch (error) {
      console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  `;
  // The in-process native callback can stall under bun:test. Keep the real
  // helper and Git state, with a hard child deadline rather than a retry.
  const result = Bun.spawnSync([process.execPath, "--eval", script], {
    cwd: directory,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
  });
  if (!result.success) {
    throw new Error(`Git repository test process failed: ${result.stderr.toString()}`);
  }
  const output: unknown = JSON.parse(result.stdout.toString());
  if (
    !output ||
    typeof output !== "object" ||
    "value" in output === "error" in output ||
    ("error" in output && typeof output.error !== "string")
  ) {
    throw new Error("Git repository test process returned malformed output");
  }
  return output;
}

describe("GitHub repository resolution", () => {
  test("parses common github.com remote forms", () => {
    for (const remote of [
      "https://github.com/modem-dev/hunk.git",
      "ssh://git@github.com/modem-dev/hunk.git",
      "git://github.com/modem-dev/hunk.git",
      "git@github.com:modem-dev/hunk.git",
    ]) {
      expect(parseGitHubRemoteRepository(remote)).toEqual({ owner: "modem-dev", repo: "hunk" });
    }
  });

  test("rejects non-GitHub and malformed remotes", () => {
    for (const remote of [
      "https://gitlab.com/modem-dev/hunk.git",
      "https://github.com/modem-dev/hunk/extra.git",
      "git@github.com:modem-dev.git",
      "not a remote",
    ]) {
      expect(parseGitHubRemoteRepository(remote)).toBeNull();
    }
  });

  test("rejects an already-cancelled origin lookup before spawning Git", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(readGitOrigin(process.cwd(), controller.signal)).rejects.toThrow("cancelled");
  });

  test("reads a branch and reports detached HEAD clearly", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hunk-gh-branch-test-"));
    try {
      runGitTest(["init", "-b", "topic"], { cwd: directory });
      expect(readGitRepositoryTestResult(directory, "branch")).toEqual({ value: "topic" });
      runGitTest(["config", "user.email", "test@example.com"], { cwd: directory });
      runGitTest(["config", "user.name", "Test"], { cwd: directory });
      runGitTest(["commit", "--allow-empty", "-m", "initial"], { cwd: directory });
      runGitTest(["checkout", "--detach"], { cwd: directory });
      expect(readGitRepositoryTestResult(directory, "branch").error).toContain("detached HEAD");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects branch names containing terminal control characters", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hunk-gh-hostile-branch-test-"));
    try {
      runGitTest(["init", "-b", "safe"], { cwd: directory });
      runGitTest(["symbolic-ref", "HEAD", "refs/heads/topic\u009bcontrol"], {
        cwd: directory,
      });
      expect(readGitRepositoryTestResult(directory, "branch").error).toContain(
        "terminal control characters",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reads the current branch and exact HEAD together", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hunk-gh-checkout-test-"));
    try {
      runGitTest(["init", "-b", "topic"], { cwd: directory });
      runGitTest(["config", "user.email", "test@example.com"], { cwd: directory });
      runGitTest(["config", "user.name", "Test"], { cwd: directory });
      runGitTest(["commit", "--allow-empty", "-m", "initial"], { cwd: directory });
      const sha = runGitTest(["rev-parse", "HEAD"], {
        cwd: directory,
      }).trim();
      expect(readGitRepositoryTestResult(directory, "head")).toEqual({ value: sha });
      expect(readGitRepositoryTestResult(directory, "checkout").value).toEqual({
        branch: "topic",
        sha,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("retains the pushed upstream tip when local HEAD is ahead", async () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-gh-upstream-test-"));
    const remote = join(root, "remote.git");
    const checkout = join(root, "checkout");
    try {
      runGitTest(["init", "--bare", remote]);
      runGitTest(["init", "-b", "topic", checkout]);
      runGitTest(["config", "user.email", "test@example.com"], { cwd: checkout });
      runGitTest(["config", "user.name", "Test"], { cwd: checkout });
      runGitTest(["commit", "--allow-empty", "-m", "pushed"], { cwd: checkout });
      runGitTest(["remote", "add", "origin", remote], { cwd: checkout });
      runGitTest(["push", "-u", "origin", "topic"], { cwd: checkout });
      const upstreamSha = runGitTest(["rev-parse", "HEAD"], {
        cwd: checkout,
      }).trim();
      runGitTest(["commit", "--allow-empty", "-m", "local"], { cwd: checkout });
      const sha = runGitTest(["rev-parse", "HEAD"], {
        cwd: checkout,
      }).trim();

      expect(readGitRepositoryTestResult(checkout, "checkout").value).toEqual({
        branch: "topic",
        sha,
        upstreamSha,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("distinguishes missing Git, cancellation, and other lookup failures", async () => {
    expect(classifyGitLookupFailure({ code: "ENOENT" }, "branch").message).toContain(
      "Git is unavailable",
    );
    expect(classifyGitLookupFailure({ killed: true }, "HEAD").message).toContain("timed out");

    const controller = new AbortController();
    controller.abort();
    await expect(readGitBranch(process.cwd(), controller.signal)).rejects.toThrow("cancelled");
    await expect(readGitHeadSha(process.cwd(), controller.signal)).rejects.toThrow("cancelled");

    const directory = mkdtempSync(join(tmpdir(), "hunk-gh-not-repo-test-"));
    try {
      expect(readGitRepositoryTestResult(directory, "branch").error).toContain(
        "Git failed while reading the current branch",
      );
      expect(readGitRepositoryTestResult(directory, "head").error).toContain(
        "Git failed while reading the current HEAD",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("uses the injected origin only when a PR does not name a repository", async () => {
    const signal = new AbortController().signal;
    const calls: string[] = [];
    const resolveOrigin = async (cwd: string, receivedSignal: AbortSignal) => {
      expect(receivedSignal).toBe(signal);
      calls.push(cwd);
      return "git@github.com:modem-dev/hunk.git";
    };

    await expect(
      resolveGitHubPullRequest(parseGitHubPrInvocation(["123"]), "/repo", signal, resolveOrigin),
    ).resolves.toEqual({ owner: "modem-dev", repo: "hunk", number: "123" });
    await expect(
      resolveGitHubPullRequest(
        parseGitHubPrInvocation(["modem-dev/hunk#124"]),
        "/elsewhere",
        signal,
        resolveOrigin,
      ),
    ).resolves.toEqual({ owner: "modem-dev", repo: "hunk", number: "124" });
    expect(calls).toEqual(["/repo"]);
  });

  test("resolves explicit commit repositories without reading origin", async () => {
    let originReads = 0;
    await expect(
      resolveGitHubRepository("modem-dev/hunk", "/repo", new AbortController().signal, async () => {
        originReads += 1;
        return "";
      }),
    ).resolves.toEqual({ owner: "modem-dev", repo: "hunk" });
    expect(originReads).toBe(0);
  });
});
