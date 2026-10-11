import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tempDirs: string[] = [];
const mainPath = resolve(import.meta.dir, "../../packages/hunk/src/main.tsx");
const jjTest = Bun.which("jj") ? test : test.skip;

/** Run a command and fail the fixture immediately when it cannot complete. */
function run(argv: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const proc = Bun.spawnSync(argv, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout?.toString() ?? "",
    stderr: proc.stderr?.toString() ?? "",
  };
}

/** Create a two-commit repository with deterministic author and dates. */
function createRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "hunk-log-test-"));
  tempDirs.push(cwd);
  expect(run(["git", "init", "-q"], cwd).code).toBe(0);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Ada Lovelace",
    GIT_AUTHOR_EMAIL: "ada@example.com",
    GIT_COMMITTER_NAME: "Ada Lovelace",
    GIT_COMMITTER_EMAIL: "ada@example.com",
  };
  writeFileSync(join(cwd, "history.txt"), "one\n");
  expect(run(["git", "add", "history.txt"], cwd, env).code).toBe(0);
  expect(
    run(["git", "commit", "-q", "-m", "First commit"], cwd, {
      ...env,
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    }).code,
  ).toBe(0);
  writeFileSync(join(cwd, "history.txt"), "two\n");
  const secondEnv = {
    ...env,
    GIT_AUTHOR_DATE: "2026-01-02T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-02T00:00:00Z",
  };
  expect(
    run(["git", "commit", "-qa", "-m", "Second commit", "-m", "A detailed body."], cwd, secondEnv)
      .code,
  ).toBe(0);
  expect(run(["git", "tag", "v1.0.0"], cwd, secondEnv).code).toBe(0);
  expect(run(["git", "tag", "-a", "v1.0.0-annotated", "-m", "release"], cwd, secondEnv).code).toBe(
    0,
  );
  return cwd;
}

/** Create a JJ-only fixture with no colocated Git worktree. */
function createJjRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "hunk-log-jj-test-"));
  const configHome = mkdtempSync(join(tmpdir(), "hunk-log-jj-config-"));
  const env = { ...process.env, XDG_CONFIG_HOME: configHome };
  tempDirs.push(cwd, configHome);
  expect(run(["jj", "git", "init", "--no-colocate", cwd], tmpdir(), env).code).toBe(0);
  const jj = (...args: string[]) =>
    run(
      [
        "jj",
        "--config",
        'user.name="Grace Hopper"',
        "--config",
        'user.email="grace@example.com"',
        ...args,
      ],
      cwd,
      env,
    );
  expect(jj("config", "set", "--repo", 'revset-aliases."trunk()"', "none()").code).toBe(0);
  writeFileSync(join(cwd, "history.txt"), "one\n");
  expect(jj("commit", "-m", "JJ first commit").code).toBe(0);
  writeFileSync(join(cwd, "history.txt"), "two\n");
  expect(jj("commit", "-m", "JJ second commit\n\nJJ body.").code).toBe(0);
  expect(jj("bookmark", "create", "main", "-r", "@-").code).toBe(0);
  expect(jj("tag", "set", "v2.0.0", "-r", "@-").code).toBe(0);
  expect(existsSync(join(cwd, ".git"))).toBe(false);
  return { cwd, env };
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("hunk log CLI contract", () => {
  test("prints deterministic complete static rows without terminal controls", () => {
    const cwd = createRepo();
    const result = run(["bun", "run", mainPath, "log", "--color", "never"], cwd);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Second commit");
    expect(result.stdout).toContain("First commit");
    expect(result.stdout).toContain("A detailed body.");
    expect(result.stdout).toContain("Author: Ada Lovelace <ada@example.com>");
    expect(result.stdout).toContain("Date:   2026-01-02 00:00:00Z");
    expect(result.stdout).toMatch(/commit [0-9a-f]{40} \(HEAD -> /);
    expect(result.stdout).toContain("tag: v1.0.0");
    expect(result.stdout).toContain("tag: v1.0.0-annotated");
    expect(result.stdout).not.toContain("\x1b");
  });

  test("supports explicit compact output and shared themes", () => {
    const cwd = createRepo();
    const result = run(
      [
        "bun",
        "run",
        mainPath,
        "log",
        "--oneline",
        "--theme",
        "catppuccin-mocha",
        "--color",
        "always",
        "-n",
        "1",
      ],
      cwd,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Second commit");
    expect(result.stdout).not.toContain("Author:");
    expect(result.stdout).toContain("\x1b[38;2;");
  });

  test("honors provider filters, all-head traversal, and first-parent", () => {
    const cwd = createRepo();
    expect(run(["git", "switch", "-q", "-c", "filtered-side", "HEAD~1"], cwd).code).toBe(0);
    writeFileSync(join(cwd, "side.txt"), "side\n");
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "Grace Hopper",
      GIT_AUTHOR_EMAIL: "grace@example.com",
      GIT_COMMITTER_NAME: "Grace Hopper",
      GIT_COMMITTER_EMAIL: "grace@example.com",
      GIT_AUTHOR_DATE: "2026-01-03T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-03T00:00:00Z",
    };
    expect(run(["git", "add", "side.txt"], cwd, env).code).toBe(0);
    expect(run(["git", "commit", "-q", "-m", "Side-only match"], cwd, env).code).toBe(0);
    expect(run(["git", "switch", "-q", "-"], cwd).code).toBe(0);

    const result = run(
      [
        "bun",
        "run",
        mainPath,
        "log",
        "--all",
        "--first-parent",
        "--author",
        "Grace",
        "--grep",
        "Side-only",
        "--since",
        "2026-01-03T00:00:00Z",
        "--until",
        "2026-01-04T00:00:00Z",
        "--color",
        "never",
      ],
      cwd,
    );

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("Side-only match");
    expect(result.stdout).toContain("Author: Grace Hopper <grace@example.com>");
    expect(result.stdout).not.toContain("Second commit");
    expect(result.stdout).not.toContain("First commit");
  });

  test("honors max count, pathspecs, ASCII, and explicit color", () => {
    const cwd = createRepo();
    const result = run(
      [
        "bun",
        "run",
        mainPath,
        "log",
        "-n",
        "1",
        "--ascii",
        "--color",
        "always",
        "--",
        "history.txt",
      ],
      cwd,
    );

    expect(result.code).toBe(0);
    const plain = result.stdout.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toContain("*  commit");
    expect(result.stdout).toContain("Second commit");
    expect(result.stdout).not.toContain("First commit");
    expect(result.stdout).toContain("\x1b[");
  });

  jjTest(
    "uses the bundled JJ provider in a JJ-only repository",
    () => {
      const { cwd, env } = createJjRepo();
      const result = run(
        ["bun", "run", mainPath, "log", "--vcs", "jj", "--color", "never"],
        cwd,
        env,
      );

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("hunk: Mainline unavailable; showing visible history.\n");
      expect(result.stdout).toContain("JJ second commit");
      expect(result.stdout).toContain("JJ first commit");
      expect(result.stdout).toContain("JJ body.");
      expect(result.stdout).toContain("Author: Grace Hopper <grace@example.com>");
      expect(result.stdout).toContain("main");
      expect(result.stdout).toContain("tag: v2.0.0");
      expect(result.stdout).toMatch(/commit [0-9a-f]{40}/);
      expect(result.stdout).not.toContain("\x1b");
    },
    20_000,
  );

  jjTest(
    "HK-93 projection parity preserves bounded, explicit and empty fallback CLI output",
    () => {
      const { cwd, env } = createJjRepo();
      const args = ["bun", "run", mainPath, "log", "--vcs", "jj", "--color", "never"];
      expect(
        run(["jj", "config", "set", "--repo", 'revset-aliases."trunk()"', "main"], cwd, env).code,
      ).toBe(0);
      const bounded = run(args, cwd, env);
      expect(bounded.code).toBe(0);
      expect(bounded.stderr).toBe("");
      expect(bounded.stdout).toContain("JJ second commit");
      expect(bounded.stdout).not.toContain("JJ first commit");
      expect(bounded.stdout.match(/~ older history hidden/g)).toHaveLength(1);
      const compact = run([...args, "--format", "compact", "--ascii"], cwd, env);
      expect(compact.code).toBe(0);
      expect(compact.stderr).toBe("");
      expect(compact.stdout).toContain("JJ second commit");
      expect(compact.stdout).not.toContain("JJ first commit");
      expect(compact.stdout.match(/~ older history hidden/g)).toHaveLength(1);
      const explicit = run([...args, "--all"], cwd, env);
      expect(explicit.code).toBe(0);
      expect(explicit.stderr).toBe("");
      expect(explicit.stdout).toContain("JJ first commit");
      expect(explicit.stdout).not.toContain("older history hidden");
      expect(
        run(["jj", "config", "set", "--repo", 'revset-aliases."trunk()"', "none()"], cwd, env).code,
      ).toBe(0);
      const empty = run([...args, "--grep", "absent-subject"], cwd, env);
      expect(empty).toEqual({
        code: 0,
        stdout: "",
        stderr: "hunk: Mainline unavailable; showing visible history.\n",
      });
    },
  );

  test("is silent for max count zero and reports non-repositories cleanly", () => {
    const cwd = createRepo();
    expect(run(["bun", "run", mainPath, "log", "-n", "0"], cwd)).toMatchObject({
      code: 0,
      stdout: "",
      stderr: "",
    });

    const outside = mkdtempSync(join(tmpdir(), "hunk-log-outside-"));
    tempDirs.push(outside);
    const failed = run(["bun", "run", mainPath, "log"], outside);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("not a git repository");
    expect(failed.stdout).not.toContain("\x1b");
  });
});
