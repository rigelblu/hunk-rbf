import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJjVcsAdapter } from "./index";
import {
  buildJjHistoryArgs,
  buildJjHistoryExpression,
  filterJjExpressionError,
  getJjHistoryWatchSignature,
  buildJjHistoryRevset,
  jjHistoryUsesBoundaryTopology,
  loadJjReviewCommits,
  openJjHistory,
  parseJjHistory,
  prepareJjHistory,
  getJjConfigFingerprint,
  planJjHistoryRangeReview,
} from "./history";

const tempDirs: string[] = [];
const initialConfigHome = process.env.XDG_CONFIG_HOME;
const jjTest = Bun.which("jj") ? test : test.skip;
const unixTest = process.platform === "win32" ? test.skip : test;

/** Create a real JJ-only workspace without a colocated `.git` directory. */
function createJjOnlyTestRepo() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "hunk-jj-history-")));
  tempDirs.push(repo);
  const init = Bun.spawnSync(["jj", "git", "init", "--no-colocate", repo], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (init.exitCode !== 0) throw new Error(init.stderr.toString());
  return repo;
}

/** Run JJ with a deterministic identity for fixture commits. */
function jj(repo: string, ...args: string[]) {
  const result = Bun.spawnSync(
    [
      "jj",
      "--config",
      'user.name="Ada Lovelace"',
      "--config",
      'user.email="ada@example.com"',
      ...args,
    ],
    { cwd: repo, env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

afterEach(() => {
  if (initialConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = initialConfigHome;
  for (const repo of tempDirs.splice(0)) rmSync(repo, { recursive: true, force: true });
});

describe("Jujutsu history production", () => {
  jjTest(
    "reports empty merges against auto-merged parents in streamed and direct-review history",
    async () => {
      const repo = createJjOnlyTestRepo();
      writeFileSync(join(repo, "base.txt"), "base\n");
      jj(repo, "commit", "-m", "Base");
      jj(repo, "bookmark", "create", "base", "-r", "@-");
      jj(repo, "new", "base");
      writeFileSync(join(repo, "left.txt"), "left\n");
      jj(repo, "commit", "-m", "Left");
      jj(repo, "bookmark", "create", "left", "-r", "@-");
      jj(repo, "new", "base");
      writeFileSync(join(repo, "right.txt"), "right\n");
      jj(repo, "commit", "-m", "Right");
      jj(repo, "bookmark", "create", "right", "-r", "@-");
      jj(repo, "new", "left", "right", "-m", "Empty merge");
      expect(jj(repo, "log", "--no-graph", "-r", "@", "-T", 'if(empty, "true", "false")')).toBe(
        "true",
      );
      expect(jj(repo, "diff", "--summary", "--from", "left", "--to", "@")).toContain("right.txt");
      for (const firstParent of [false, true]) {
        const source = await openJjHistory({ revision: "@", firstParent }, { cwd: repo });
        try {
          const page = await source.read({ limit: 1 });
          expect(page.commits[0]).toMatchObject({ subject: "Empty merge", isEmpty: true });
        } finally {
          await source.close();
        }
      }
      const direct = await loadJjReviewCommits("@", { cwd: repo });
      expect(direct[0]).toMatchObject({ subject: "Empty merge", isEmpty: true });
    },
  );

  jjTest(
    "HK-92 decodes exact workspace names including machine delimiters",
    async () => {
      const repo = createJjOnlyTestRepo();
      jj(repo, "describe", "-m", "Named workspace current");
      const currentId = jj(repo, "log", "--no-graph", "-r", "@", "-T", "commit_id").trim();
      const peerRoot = realpathSync(mkdtempSync(join(tmpdir(), "hunk-jj-encoded-names-")));
      tempDirs.push(peerRoot);
      const names = [
        "team one",
        "日本語",
        "line\nbreak",
        "escape\u001bwork",
        "unit\u001fseparator",
        'quoted"name',
        "comma,name",
      ];
      for (const [index, name] of names.entries()) {
        const peer = join(peerRoot, String(index));
        jj(repo, "workspace", "add", "--name", name, "-r", currentId, peer);
        jj(peer, "edit", currentId);
      }
      const source = await openJjHistory({ all: true }, { cwd: repo });
      try {
        const page = await source.read({ limit: 20 });
        expect(page.commits).toHaveLength(1);
        expect(
          page.commits[0]!.decorations.filter((entry) => entry.kind === "ref").map(
            (entry) => entry.label,
          ),
        ).toEqual(["default", ...names].sort().map((name) => `@${name}`));
      } finally {
        await source.close();
      }
      await expect(
        getJjHistoryWatchSignature({ revision: "no-such-HK92-bookmark" }, { cwd: repo }),
      ).rejects.toThrow();
    },
    20_000,
  );

  test("HK-92 rejects malformed encoded membership without accepting old arity", () => {
    const fields = [
      "a".repeat(40),
      "kkkkkkkk",
      "k".repeat(32),
      "",
      "Ada",
      "",
      "2026-01-01T00:00:00Z",
      "Subject",
      "1",
      "",
      "",
      "",
      "",
      "false",
      "",
      "false",
    ];
    for (const encoded of ['"unterminated', "false", "{}", "[]"]) {
      fields[14] = encoded;
      expect(() => parseJjHistory(fields.join("\0"))).toThrow("invalid workspace name");
    }
    fields[14] = ['"zeta"', '"default"', '"zeta"', '"alpha"'].join("\x1f");
    expect(parseJjHistory(fields.join("\0"))[0]!.decorations).toEqual([
      { kind: "head", label: "@" },
      { kind: "ref", label: "@alpha", workspaceName: "alpha" },
      { kind: "ref", label: "@default", workspaceName: "default" },
      { kind: "ref", label: "@zeta", workspaceName: "zeta" },
    ]);
    expect(() => parseJjHistory(fields.slice(0, 14).join("\0"))).toThrow(
      "truncated history record",
    );
  });

  jjTest(
    "HK-92 emits multi-workspace heads and watches pointer-only movement",
    async () => {
      const repo = createJjOnlyTestRepo();
      writeFileSync(join(repo, "history.txt"), "ancestor\n");
      jj(repo, "commit", "-m", "Ancestor");
      writeFileSync(join(repo, "history.txt"), "current\n");
      jj(repo, "describe", "-m", "Current");
      jj(repo, "bookmark", "create", "current", "-r", "@");
      jj(repo, "bookmark", "create", "ancestor", "-r", "@-");
      const adapter = createJjVcsAdapter().history!;
      const load = async () => {
        const source = await adapter.open({ all: true }, { cwd: repo });
        try {
          const commits = [];
          for (;;) {
            const page = await source.read({ limit: 1 });
            commits.push(...page.commits);
            if (page.done) return commits;
          }
        } finally {
          await source.close();
        }
      };
      const singleton = await load();
      const currentId = singleton.find((commit) => commit.subject === "Current")!.revisionId;
      const ancestorId = singleton.find((commit) => commit.subject === "Ancestor")!.revisionId;
      expect(
        singleton.flatMap((commit) => commit.decorations).filter((ref) => ref.kind === "ref"),
      ).toEqual([]);
      expect(singleton[0]!.decorations).toContainEqual({ kind: "head", label: "@" });
      const peerRoot = realpathSync(mkdtempSync(join(tmpdir(), "hunk-jj-workspaces-")));
      tempDirs.push(peerRoot);
      for (const name of ["zeta", "alpha"]) {
        const peer = join(peerRoot, name);
        jj(repo, "workspace", "add", "--name", name, "-r", currentId, peer);
        jj(peer, "edit", currentId);
      }
      const before = await load();
      expect(before.find((commit) => commit.revisionId === currentId)!.decorations).toEqual([
        { kind: "head", label: "@" },
        { kind: "ref", label: "@alpha", workspaceName: "alpha" },
        { kind: "ref", label: "@default", workspaceName: "default" },
        { kind: "ref", label: "@zeta", workspaceName: "zeta" },
        { kind: "local-branch", label: "current" },
      ]);
      expect(before.find((commit) => commit.revisionId === ancestorId)!.decorations).toEqual([
        { kind: "local-branch", label: "ancestor" },
      ]);
      const beforeSignature = await getJjHistoryWatchSignature({ all: true }, { cwd: repo });
      jj(join(peerRoot, "zeta"), "edit", ancestorId);
      const afterSignature = await getJjHistoryWatchSignature({ all: true }, { cwd: repo });
      const after = await load();
      expect(afterSignature).not.toBe(beforeSignature);
      expect(
        after
          .find((commit) => commit.revisionId === currentId)!
          .decorations.filter((ref) => ref.kind === "ref"),
      ).toEqual([
        { kind: "ref", label: "@alpha", workspaceName: "alpha" },
        { kind: "ref", label: "@default", workspaceName: "default" },
      ]);
      expect(after.find((commit) => commit.revisionId === ancestorId)!.decorations).toContainEqual({
        kind: "ref",
        label: "@zeta",
        workspaceName: "zeta",
      });
      const withoutWorkspaceNames = (commits: typeof before) =>
        commits.map((commit) => ({
          ...commit,
          decorations: commit.decorations.filter((ref) => ref.kind !== "ref"),
        }));
      expect(withoutWorkspaceNames(after)).toEqual(withoutWorkspaceNames(before));
      jj(repo, "workspace", "forget", "alpha", "zeta");
      expect(
        (await load()).flatMap((commit) => commit.decorations).filter((ref) => ref.kind === "ref"),
      ).toEqual([]);
    },
    20_000,
  );

  unixTest("cancels provider range planning without blocking the renderer", async () => {
    const temp = mkdtempSync(join(tmpdir(), "hunk-jj-range-cancel-"));
    tempDirs.push(temp);
    const executable = join(temp, "slow-jj");
    writeFileSync(executable, "#!/bin/sh\nsleep 30\n");
    chmodSync(executable, 0o755);
    const controller = new AbortController();
    const revision = "a".repeat(40);
    const commit = {
      revisionId: revision,
      displayId: revision.slice(0, 8),
      parentRevisionIds: ["b".repeat(40)],
      subject: "commit",
      authorName: "Test",
      authoredAt: "2026-01-01T00:00:00Z",
      decorations: [],
    };

    const planning = planJjHistoryRangeReview(
      { newestCommit: commit, oldestCommit: commit },
      { cwd: temp, jjExecutable: executable, signal: controller.signal },
    );
    controller.abort(new Error("planning cancelled"));
    await expect(planning).rejects.toThrow("planning cancelled");
  });
  test("builds a provider-owned revset and preserves literal filesets", () => {
    expect(
      buildJjHistoryArgs({
        revision: "main..@",
        firstParent: true,
        maxCount: 12,
        author: 'Ada "A"',
        grep: "parser",
        since: "2026-01-01",
        until: "2026-02-01",
        pathspecs: ["src/file with spaces.ts", "--not-an-option"],
      }),
    ).toEqual([
      "--ignore-working-copy",
      "--no-pager",
      "--color",
      "never",
      "log",
      "--no-graph",
      "--revisions",
      '(first_ancestors((main..@)) ~ root()) & author(substring:"Ada \\"A\\"") & description(substring:"parser") & author_date(after:"2026-01-01") & author_date(before:"2026-02-01")',
      "--template",
      expect.any(String),
      "--limit",
      "12",
      "--",
      "src/file with spaces.ts",
      "--not-an-option",
    ]);
    expect(buildJjHistoryRevset({ all: true })).toBe("(ancestors(visible_heads()) ~ root())");
  });

  test("rejects option-like revisions", () => {
    expect(() => buildJjHistoryRevset({ revision: "--at-operation=@" })).toThrow(
      "Refused Jujutsu history revision",
    );
  });

  test("parses descriptions, logical ids, parents, and structured JJ refs", () => {
    const raw = [
      "a".repeat(40),
      "kkkkkkkk",
      "k".repeat(32),
      `${"b".repeat(40)} ${"c".repeat(40)}`,
      "Ada Lovelace",
      "ada@example.com",
      "2026-01-02T03:04:05+00:00",
      "Subject\n\nBody paragraph.\n",
      "1",
      `main\x1ffeature`,
      "main@git",
      "v1.0.0",
      "v1.0.0@origin",
      "false",
      "",
      "false",
    ].join("\0");
    expect(parseJjHistory(raw)).toEqual([
      {
        revisionId: "a".repeat(40),
        displayId: "kkkkkkkk",
        logicalId: "k".repeat(32),
        parentRevisionIds: ["b".repeat(40), "c".repeat(40)],
        subject: "Subject",
        body: "Body paragraph.",
        authorName: "Ada Lovelace",
        authorEmail: "ada@example.com",
        authoredAt: "2026-01-02T03:04:05+00:00",
        decorations: [
          { kind: "head", label: "@" },
          { kind: "local-branch", label: "main" },
          { kind: "local-branch", label: "feature" },
          { kind: "remote-branch", label: "main@git" },
          { kind: "tag", label: "v1.0.0" },
          { kind: "tag", label: "v1.0.0@origin" },
        ],
        isEmpty: false,
        isImmutable: false,
      },
    ]);
  });

  test("keeps review parents but marks filtered topology as a boundary", () => {
    expect(jjHistoryUsesBoundaryTopology({})).toBe(false);
    expect(jjHistoryUsesBoundaryTopology({ revision: "main..@" })).toBe(false);
    expect(jjHistoryUsesBoundaryTopology({ pathspecs: ["src"] })).toBe(true);
    expect(jjHistoryUsesBoundaryTopology({ author: "Ada" })).toBe(true);

    const raw = [
      "a".repeat(40),
      "aaaaaaaa",
      "k".repeat(32),
      "b".repeat(40),
      "Ada",
      "",
      "2026-01-01T00:00:00+00:00",
      "Commit\n",
      "0",
      "",
      "",
      "",
      "",
      "true",
      "",
      "false",
    ].join("\0");
    const parsed = parseJjHistory(raw, false, true)[0]!;
    expect(parsed.parentRevisionIds).toEqual(["b".repeat(40)]);
    expect(parsed.graphParentRevisionIds).toEqual([]);
    expect(parsed.isEmpty).toBe(true);
  });

  test("drops JJ's synthetic root and excluded merge parents", () => {
    const raw = [
      "a".repeat(40),
      "aaaaaaaa",
      "k".repeat(32),
      `${"b".repeat(40)} ${"0".repeat(40)} ${"c".repeat(40)}`,
      "Ada",
      "",
      "2026-01-01T00:00:00+00:00",
      "Commit\n",
      "0",
      "",
      "",
      "",
      "",
      "false",
      "",
      "false",
    ].join("\0");
    const parsed = parseJjHistory(raw, true)[0]!;
    expect(parsed.parentRevisionIds).toEqual(["b".repeat(40)]);
    expect(parsed.isEmpty).toBe(false);
  });

  test("strictly parses literal true and false for isEmpty and rejects invalid values", () => {
    const makeRaw = (emptyValue: string) =>
      [
        "a".repeat(40),
        "aaaaaaaa",
        "k".repeat(32),
        "b".repeat(40),
        "Ada",
        "",
        "2026-01-01T00:00:00+00:00",
        "Commit\n",
        "0",
        "",
        "",
        "",
        "",
        emptyValue,
        "",
        "false",
      ].join("\0");

    expect(parseJjHistory(makeRaw("true"))[0]!.isEmpty).toBe(true);
    expect(parseJjHistory(makeRaw("false"))[0]!.isEmpty).toBe(false);
    expect(parseJjHistory(makeRaw("false"))[0]!.isImmutable).toBe(false);
    const immutableRaw = makeRaw("false").replace(/false$/, "true");
    expect(parseJjHistory(immutableRaw)[0]!.isImmutable).toBe(true);
    expect(() => parseJjHistory(makeRaw("false").replace(/false$/, "1"))).toThrow(
      "Jujutsu returned an invalid history record.",
    );

    for (const invalid of ["1", "0", "True", "False", "", "null", "undefined"]) {
      expect(() => parseJjHistory(makeRaw(invalid))).toThrow(
        "Jujutsu returned an invalid history record.",
      );
    }
  });

  test("rejects truncated history records missing expected fields", () => {
    const fields = [
      "a".repeat(40),
      "aaaaaaaa",
      "k".repeat(32),
      "b".repeat(40),
      "Ada",
      "",
      "2026-01-01T00:00:00+00:00",
      "Commit\n",
      "0",
      "",
      "",
      "",
      "",
      // missing 14th and 15th fields
    ];
    expect(() => parseJjHistory(fields.join("\0"))).toThrow(
      "Jujutsu returned a truncated history record.",
    );
  });

  unixTest("streams records across split chunk boundaries without losing emptiness", async () => {
    const temp = mkdtempSync(join(tmpdir(), "hunk-jj-split-"));
    tempDirs.push(temp);
    const executable = join(temp, "chunked-jj");
    const script = `#!/bin/sh
case "$*" in
  *" root")
    echo "${temp}"
    exit 0
    ;;
  *" op log "*)
    echo "${"0".repeat(128)}"
    exit 0
    ;;
  *" config list"*)
    echo "fixture=true"
    exit 0
    ;;
  *"present(trunk())"*)
    exit 0
    ;;
esac
printf '%s\\0%s\\0%s\\0%s\\0' "${"a".repeat(40)}" "aaaaaaaa" "${"k".repeat(32)}" ""
printf '%s\\0%s\\0%s\\0%s\\0' "Ada" "" "2026-01-01T00:00:00+00:00" "First split"
printf '%s\\0%s\\0%s\\0%s\\0%s\\0' "0" "" "" "" ""
printf 'tr'
sleep 0.02
printf 'ue\\0\\0false\\0'
printf '%s\\0%s\\0%s\\0%s\\0' "${"b".repeat(40)}" "bbbbbbbb" "${"k".repeat(32)}" "${"a".repeat(40)}"
printf '%s\\0%s\\0%s\\0%s\\0' "Ada" "" "2026-01-02T00:00:00+00:00" "Second split"
printf '%s\\0%s\\0%s\\0%s\\0%s\\0' "0" "" "" "" ""
printf 'fal'
sleep 0.02
printf 'se\\0\\0true\\0'
`;
    writeFileSync(executable, script);
    chmodSync(executable, 0o755);

    const source = await openJjHistory({}, { cwd: temp, jjExecutable: executable });
    const page = await source.read({ limit: 4 });
    await source.close();

    expect(page.commits).toHaveLength(2);
    expect(page.commits[0]!.isEmpty).toBe(true);
    expect(page.commits[0]!.subject).toBe("First split");
    expect(page.commits[1]!.isEmpty).toBe(false);
    expect(page.commits[1]!.subject).toBe("Second split");
    expect(page.commits.map((commit) => commit.isImmutable)).toEqual([false, true]);
  });

  test("owns default and explicitly selected parent review semantics", async () => {
    const history = createJjVcsAdapter().history!;
    for (const parentRevisionIds of [[], ["b".repeat(40)], ["b".repeat(40), "c".repeat(40)]]) {
      const commit = {
        revisionId: "a".repeat(40),
        displayId: "aaaaaaaa",
        logicalId: "k".repeat(32),
        parentRevisionIds,
        subject: "Commit",
        authorName: "Ada",
        authoredAt: "2026-01-01T00:00:00+00:00",
        decorations: [],
      };
      expect(await history.planReview(commit)).toEqual({
        kind: "revision-show",
        revisionId: commit.revisionId,
      });
      if (parentRevisionIds[0]) {
        expect(
          await history.planReview(commit, undefined, {
            parentRevisionId: parentRevisionIds[0],
          }),
        ).toEqual({
          kind: "revision-range",
          fromRevisionId: parentRevisionIds[0],
          toRevisionId: commit.revisionId,
        });
      }
    }
  });

  jjTest(
    "streams bounded child-before-parent pages from a JJ-only repository",
    async () => {
      const repo = createJjOnlyTestRepo();
      expect(existsSync(join(repo, ".git"))).toBe(false);
      writeFileSync(join(repo, "history.txt"), "one\n");
      jj(repo, "commit", "-m", "First commit");
      writeFileSync(join(repo, "history.txt"), "two\n");
      jj(repo, "commit", "-m", "Second commit\n\nDetailed body.");
      jj(repo, "bookmark", "create", "main", "-r", "@-");
      jj(repo, "tag", "set", "v1.0.0", "-r", "@-");

      const source = await openJjHistory({ maxCount: 4 }, { cwd: repo });
      const commits = [];
      for (;;) {
        const page = await source.read({ limit: 1 });
        expect(page.commits.length).toBeLessThanOrEqual(1);
        commits.push(...page.commits);
        if (page.done) break;
      }
      await source.close();

      expect(commits.map((commit) => commit.subject)).toEqual([
        "(no description set)",
        "Second commit",
        "First commit",
      ]);
      expect(commits.map((commit) => commit.isEmpty)).toEqual([true, false, false]);
      expect(commits[1]!.body).toBe("Detailed body.");
      expect(commits[1]!.displayId).toMatch(/^[k-z]{8}$/);
      expect(commits[1]!.logicalId).toMatch(/^[k-z]{32}$/);
      expect(commits[1]!.decorations).toContainEqual({ kind: "local-branch", label: "main" });
      expect(commits[1]!.decorations).toContainEqual({ kind: "tag", label: "v1.0.0" });
      for (let index = 0; index < commits.length; index += 1) {
        for (const parent of commits[index]!.parentRevisionIds) {
          const parentIndex = commits.findIndex((commit) => commit.revisionId === parent);
          if (parentIndex >= 0) expect(parentIndex).toBeGreaterThan(index);
        }
      }

      const filtered = await openJjHistory({ pathspecs: ["history.txt"] }, { cwd: repo });
      const filteredPage = await filtered.read({ limit: 4 });
      await filtered.close();
      expect(filteredPage.commits.map((commit) => commit.isEmpty)).toEqual([false, false]);
      const filteredWithParent = filteredPage.commits.find(
        (commit) => commit.parentRevisionIds.length > 0,
      );
      expect(filteredWithParent?.parentRevisionIds).toHaveLength(1);
      expect(filteredWithParent?.graphParentRevisionIds).toEqual([]);

      const cancelled = await openJjHistory({}, { cwd: repo });
      const abort = new AbortController();
      abort.abort(new Error("cancel fixture"));
      await expect(cancelled.read({ limit: 1, signal: abort.signal })).rejects.toThrow(
        "cancel fixture",
      );
      await cancelled.close();

      jj(repo, "config", "set", "--repo", "template-aliases.commit_id", '"wrong"');
      const rangePlan = await createJjVcsAdapter().history!.planRangeReview!(
        { newestCommit: commits[1]!, oldestCommit: commits[2]! },
        { cwd: repo },
      );
      expect(rangePlan).toMatchObject({
        kind: "revision-range",
        toRevisionId: commits[1]!.revisionId,
      });
      expect(rangePlan.kind === "revision-range" && rangePlan.fromRevisionId).toMatch(/^0+$/);
    },
    20_000,
  );
});

/** Create old-based and protected independent work around a configured mainline. */
function createHk93TestRepo() {
  const configHome = mkdtempSync(join(tmpdir(), "hunk-hk93-jj-config-"));
  tempDirs.push(configHome);
  process.env.XDG_CONFIG_HOME = configHome;
  const repo = createJjOnlyTestRepo();
  jj(repo, "config", "set", "--repo", 'revset-aliases."trunk()"', "none()");
  const add = (label: string, ...parents: string[]) => {
    jj(repo, "new", ...parents);
    writeFileSync(join(repo, `${label}.txt`), label);
    jj(repo, "describe", "-m", label);
    const id = jj(repo, "log", "--no-graph", "-r", "@", "-T", "commit_id").trim();
    jj(repo, "bookmark", "create", label, "-r", id);
    return id;
  };
  const olda = add("olda", "root()");
  const oldb = add("oldb", olda);
  const main = add("main", oldb);
  const feature = add("feature", main);
  const sibling = add("sibling", olda);
  const other = add("other", main);
  const merge = add("merge", feature, sibling);
  jj(repo, "config", "set", "--repo", 'revset-aliases."trunk()"', "main");
  jj(repo, "config", "set", "--repo", 'revset-aliases."immutable_heads()"', "main | other");
  return { repo, olda, oldb, main, feature, sibling, other, merge };
}

/** Drain the actual provider through arbitrary bounded reads and retain its facts. */
async function readHk93TestHistory(
  repo: string,
  input: Parameters<typeof openJjHistory>[0] = {},
  limit = 2,
) {
  const source = await openJjHistory(input, { cwd: repo });
  const commits: Awaited<ReturnType<typeof source.read>>["commits"] = [];
  try {
    for (;;) {
      const page = await source.read({ limit });
      commits.push(...page.commits);
      if (page.done) break;
    }
    return { commits, scope: source.scope };
  } finally {
    await source.close();
  }
}

describe("HK-93 focused JJ history", () => {
  jjTest(
    "HK-93 bounded scope retains protected and old-based work with true direct cuts",
    async () => {
      const f = createHk93TestRepo();
      const result = await readHk93TestHistory(f.repo);
      expect(result.scope).toEqual({ kind: "bounded", boundaryRevisionId: f.main });
      expect(new Set(result.commits.map((commit) => commit.subject))).toEqual(
        new Set(["merge", "other", "sibling", "feature", "main"]),
      );
      expect(
        result.commits.find((commit) => commit.subject === "sibling")?.graphCutoffParentRevisionIds,
      ).toEqual([f.olda]);
      const main = result.commits.find((commit) => commit.subject === "main")!;
      expect(main.graphCutoffParentRevisionIds).toEqual([f.oldb]);
      expect(main.parentRevisionIds).toEqual([f.oldb]);
      expect(
        result.commits.find((commit) => commit.subject === "merge")?.parentRevisionIds,
      ).toEqual([f.feature, f.sibling]);
      const widePages = await readHk93TestHistory(f.repo, {}, 256);
      expect(widePages).toEqual(result);
    },
  );

  jjTest("HK-93 boundary outcomes distinguish fallback from invalid configuration", async () => {
    const f = createHk93TestRepo();
    for (const alias of ["none()", "root()", "present(absent)"]) {
      jj(f.repo, "config", "set", "--repo", 'revset-aliases."trunk()"', alias);
      const result = await readHk93TestHistory(f.repo);
      expect(result.scope).toEqual({ kind: "fallback", reason: "unavailable" });
      expect(result.commits.map((commit) => commit.subject)).toContain("olda");
      expect(result.commits.every((commit) => !commit.graphCutoffParentRevisionIds)).toBe(true);
    }
    jj(f.repo, "config", "set", "--repo", 'revset-aliases."trunk()"', "main | other");
    expect((await readHk93TestHistory(f.repo)).scope).toEqual({
      kind: "fallback",
      reason: "ambiguous",
    });
    jj(f.repo, "config", "set", "--repo", 'revset-aliases."trunk()"', "unknown_function()");
    await expect(readHk93TestHistory(f.repo)).rejects.toThrow();
  });

  jjTest(
    "HK-93 scope precedence preserves explicit ancestry and narrows only bounded defaults",
    async () => {
      const f = createHk93TestRepo();
      for (const input of [{ all: true }, { revision: "@" }]) {
        const result = await readHk93TestHistory(f.repo, input);
        expect(result.scope).toBeUndefined();
        expect(result.commits.map((commit) => commit.subject)).toContain("olda");
      }
      const filtered = await readHk93TestHistory(f.repo, { grep: "sibling" });
      expect(filtered.commits.map((commit) => commit.subject)).toEqual(["sibling"]);
      expect(filtered.commits[0]?.graphParentRevisionIds).toEqual([]);
      expect(filtered.commits[0]?.graphCutoffParentRevisionIds).toEqual([f.olda]);
      expect((await readHk93TestHistory(f.repo, { maxCount: 0 })).commits).toEqual([]);
      expect((await readHk93TestHistory(f.repo, { maxCount: 1 })).commits).toHaveLength(1);
      const first = await readHk93TestHistory(f.repo, { firstParent: true });
      expect(first.commits.map((commit) => commit.subject)).not.toContain("sibling");
      expect(first.commits.map((commit) => commit.subject)).toContain("other");
    },
  );

  jjTest(
    "HK-93 scope refresh fingerprints a moved boundary even when filters emit no rows",
    async () => {
      const f = createHk93TestRepo();
      const before = await getJjHistoryWatchSignature({ grep: "nothing-matches" }, { cwd: f.repo });
      jj(f.repo, "config", "set", "--repo", 'revset-aliases."trunk()"', "feature");
      const after = await getJjHistoryWatchSignature({ grep: "nothing-matches" }, { cwd: f.repo });
      expect(before).not.toBe(after);
      const abort = new AbortController();
      abort.abort(new Error("preparation cancelled"));
      await expect(openJjHistory({}, { cwd: f.repo, signal: abort.signal })).rejects.toThrow(
        "preparation cancelled",
      );
    },
  );
});

/** Open a source, drain it, and keep the facts the expression contract promises. */
async function readHk191TestHistory(repo: string, input: Parameters<typeof openJjHistory>[0]) {
  const source = await openJjHistory(input, { cwd: repo });
  const commits: Awaited<ReturnType<typeof source.read>>["commits"] = [];
  try {
    for (;;) {
      const page = await source.read({ limit: 3 });
      commits.push(...page.commits);
      if (page.done) break;
    }
    return { commits, scope: source.scope, expression: source.expression };
  } finally {
    await source.close();
  }
}

/** Evaluate a revset natively and list its commit ids in JJ's order. */
function nativeHk191Ids(repo: string, revset: string) {
  return jj(repo, "log", "--no-graph", "-r", revset, "-T", 'commit_id ++ "\n"')
    .trim()
    .split("\n")
    .filter(Boolean);
}

describe("HK-19.1 JJ expression history", () => {
  test("states the default, fallback, first-parent, revision, all and filtered launches", () => {
    expect(
      buildJjHistoryExpression({}, { kind: "bounded", boundaryRevisionId: "a".repeat(40) }),
    ).toBe("(((trunk()..visible_heads()) | trunk()) ~ root())");
    expect(
      buildJjHistoryExpression({ firstParent: true }, { kind: "bounded", boundaryRevisionId: "a" }),
    ).toBe("(((first_ancestors(visible_heads()) ~ ancestors(trunk())) | trunk()) ~ root())");
    expect(buildJjHistoryExpression({}, { kind: "fallback", reason: "unavailable" })).toBe(
      "(ancestors(visible_heads()) ~ root())",
    );
    expect(
      buildJjHistoryExpression({ firstParent: true }, { kind: "fallback", reason: "ambiguous" }),
    ).toBe("(first_ancestors(visible_heads()) ~ root())");
    expect(buildJjHistoryExpression({ revision: "main..@" })).toBe(
      "(ancestors((main..@)) ~ root())",
    );
    expect(buildJjHistoryExpression({ all: true, firstParent: true })).toBe(
      "(first_ancestors(visible_heads()) ~ root())",
    );
    expect(
      buildJjHistoryExpression({
        revision: "@",
        author: 'Ada "A"',
        grep: "fix",
        since: "2026-01-01",
        until: "2026-02-01",
        pathspecs: ["src", "docs/a.md"],
        maxCount: 5,
      }),
    ).toBe(
      '(ancestors((@)) ~ root()) & author(substring:"Ada \\"A\\"") & description(substring:"fix") & author_date(after:"2026-01-01") & author_date(before:"2026-02-01") & files("src" | "docs/a.md")',
    );
  });

  test("omits the expression for a launch it cannot state exactly", () => {
    // Each CLI pathspec is a fileset expression, which `files("...")` does not repeat.
    for (const pathspecs of [
      ["glob:*.ts"],
      ["a b"],
      ['x"y'],
      ["--not-an-option"],
      [""],
      ["a", "-b"],
    ]) {
      expect(buildJjHistoryExpression({ pathspecs })).toBeUndefined();
    }
    expect(buildJjHistoryExpression({ revision: "--at-operation=@" })).toBeUndefined();
    expect(buildJjHistoryExpression({ revision: "a\nb" })).toBeUndefined();
    expect(buildJjHistoryExpression({ grep: "x".repeat(65_536) })).toBeUndefined();
  });

  test("applies expression input as the whole revset with the row limit separate", () => {
    const args = buildJjHistoryArgs({ kind: "expression", expression: "trunk()..@", maxCount: 7 });
    expect(args).toEqual([
      "--ignore-working-copy",
      "--no-pager",
      "--color",
      "never",
      "log",
      "--no-graph",
      "--revisions",
      "trunk()..@",
      "--template",
      expect.any(String),
      "--limit",
      "7",
    ]);
    expect(buildJjHistoryRevset({ kind: "expression", expression: "root()" })).toBe("root()");
    expect(buildJjHistoryArgs({ kind: "expression", expression: "-x" })).toContain(
      "--revisions=-x",
    );
    expect(jjHistoryUsesBoundaryTopology({ kind: "expression", expression: "@" })).toBe(false);
  });

  test("filters the error text of expression input down to position, detail and hint lines", () => {
    expect(
      filterJjExpressionError(
        [
          "Error: Failed to parse revset: Syntax error",
          "Caused by:  --> 1:8",
          "  |",
          "1 | author(",
          "  |        ^---",
          "  |",
          "  = expected <strict_identifier> or <expression>",
          "Hint: See https://docs.jj-vcs.dev/latest/revsets/ or use `jj help -k revsets` for revsets syntax and how to quote symbols.",
          "",
        ].join("\n"),
      ),
    ).toBe(
      [
        "Syntax error",
        "Caused by:  --> 1:8",
        "  = expected <strict_identifier> or <expression>",
        "Hint: See https://docs.jj-vcs.dev/latest/revsets/ or use `jj help -k revsets` for revsets syntax and how to quote symbols.",
      ].join("\n"),
    );
    expect(
      filterJjExpressionError(
        [
          "Error: Failed to parse revset: In alias `wip(x)`",
          "Caused by:",
          "1:  --> 1:1",
          "  |",
          "1 | wip(@)",
          "  | ^----^",
          "  |",
          "  = In alias `wip(x)`",
          "2:  --> 1:5",
          "  |",
          "1 | x & nosuch()",
          "  |     ^-----^",
          "  |",
          "  = Function `nosuch` doesn't exist",
        ].join("\n"),
      ),
    ).toBe(
      [
        "In alias `wip(x)`",
        "Caused by:",
        "1:  --> 1:1",
        "  = In alias `wip(x)`",
        "2:  --> 1:5",
        "  = Function `nosuch` doesn't exist",
      ].join("\n"),
    );
    expect(filterJjExpressionError("Error: Revision `nosuchbookmark` doesn't exist\n")).toBe(
      "Revision `nosuchbookmark` doesn't exist",
    );
    // Only a leading `Error: ` goes; a warning before it keeps everything behind it.
    expect(
      filterJjExpressionError(
        "Warning: Something odd\nError: Failed to parse revset: Syntax error\nCaused by:  --> 1:1\n  |\n1 | x\n",
      ),
    ).toBe(
      "Warning: Something odd\nError: Failed to parse revset: Syntax error\nCaused by:  --> 1:1",
    );
    expect(filterJjExpressionError("Something else entirely")).toBe("Something else entirely");
  });

  jjTest(
    "reports a legacy launch's expression, and it selects the same ordered commits",
    async () => {
      const f = createHk93TestRepo();
      const launches: Array<Parameters<typeof openJjHistory>[0]> = [
        {},
        { firstParent: true },
        { all: true },
        { all: true, firstParent: true },
        { revision: "main..@" },
        { revision: "sibling", firstParent: true },
        { author: "Ada" },
        { author: "nobody" },
        { grep: "sib" },
        { since: "2000-01-01", until: "2100-01-01" },
        { pathspecs: ["main.txt", "feature.txt"] },
        { revision: "@", pathspecs: ["olda.txt"] },
        { grep: "e", pathspecs: ["other.txt", "merge.txt"] },
      ];
      for (const alias of ["main", "none()", "main | other"]) {
        jj(f.repo, "config", "set", "--repo", 'revset-aliases."trunk()"', alias);
        for (const input of launches) {
          const result = await readHk191TestHistory(f.repo, input);
          expect(result.expression).toBeString();
          expect(nativeHk191Ids(f.repo, result.expression!)).toEqual(
            result.commits.map((commit) => commit.revisionId),
          );
        }
      }
      jj(f.repo, "config", "set", "--repo", 'revset-aliases."trunk()"', "main");
      expect((await readHk191TestHistory(f.repo, {})).expression).toBe(
        "(((trunk()..visible_heads()) | trunk()) ~ root())",
      );
      jj(f.repo, "config", "set", "--repo", 'revset-aliases."trunk()"', "none()");
      expect((await readHk191TestHistory(f.repo, {})).expression).toBe(
        "(ancestors(visible_heads()) ~ root())",
      );
      // The zero-limit shortcut and a row limit still report the same complete text.
      expect((await readHk191TestHistory(f.repo, { maxCount: 0 })).expression).toBe(
        "(ancestors(visible_heads()) ~ root())",
      );
      expect((await readHk191TestHistory(f.repo, { maxCount: 2 })).expression).toBe(
        "(ancestors(visible_heads()) ~ root())",
      );
    },
    60_000,
  );

  jjTest("omits the expression of a launch it cannot state, and still opens it", async () => {
    const f = createHk93TestRepo();
    const result = await readHk191TestHistory(f.repo, { pathspecs: ["glob:*.txt"] });
    expect(result.expression).toBeUndefined();
    expect(result.commits.length).toBeGreaterThan(0);
  });

  jjTest(
    "evaluates expression input literally, with no mainline scope and query-omitted parent cuts",
    async () => {
      const f = createHk93TestRepo();
      const parents = await readHk191TestHistory(f.repo, { kind: "expression", expression: "@-" });
      expect(parents.commits.map((commit) => commit.revisionId)).toEqual(
        nativeHk191Ids(f.repo, "@-"),
      );
      expect(parents.commits.map((commit) => commit.subject)).toEqual(["sibling", "feature"]);
      expect(parents.expression).toBe("@-");
      expect(parents.scope).toBeUndefined();
      for (const commit of parents.commits) {
        expect(commit.graphCutoffParentRevisionIds).toEqual(commit.parentRevisionIds);
        expect(commit.graphParentRevisionIds).toBeUndefined();
      }
      // Real parent identities survive, even for the oldest commit of an excluded range.
      expect(parents.commits[0]!.parentRevisionIds).toEqual([f.olda]);

      const withRoot = await readHk191TestHistory(f.repo, {
        kind: "expression",
        expression: "root() | olda",
      });
      expect(withRoot.commits.map((commit) => commit.subject)).toEqual([
        "olda",
        "(no description set)",
      ]);
      expect(withRoot.commits[0]!.parentRevisionIds).toEqual([]);

      const limited = await readHk191TestHistory(f.repo, {
        kind: "expression",
        expression: "ancestors(merge)",
        maxCount: 2,
      });
      expect(limited.commits).toHaveLength(2);
      expect(limited.expression).toBe("ancestors(merge)");
    },
  );

  jjTest(
    "connects selected direct parents, cuts gaps and merge omissions, and continues across pages",
    async () => {
      const f = createHk93TestRepo();
      const connected = await readHk191TestHistory(f.repo, {
        kind: "expression",
        expression: "feature | main | oldb",
      });
      expect(connected.commits.map((c) => c.subject)).toEqual(["feature", "main", "oldb"]);
      expect(connected.commits.map((c) => c.graphCutoffParentRevisionIds ?? [])).toEqual([
        [],
        [],
        [f.olda],
      ]);
      expect(connected.commits.every((c) => c.graphParentRevisionIds === undefined)).toBeTrue();
      const gap = await readHk191TestHistory(f.repo, {
        kind: "expression",
        expression: "feature | oldb",
      });
      expect(gap.commits[0]!.parentRevisionIds).toEqual([f.main]);
      expect(gap.commits[0]!.graphCutoffParentRevisionIds).toEqual([f.main]);
      const mixed = await readHk191TestHistory(f.repo, {
        kind: "expression",
        expression: "merge | feature",
      });
      expect(mixed.commits[0]!.parentRevisionIds).toEqual([f.feature, f.sibling]);
      expect(mixed.commits[0]!.graphCutoffParentRevisionIds).toEqual([f.sibling]);
      const source = await openJjHistory(
        { kind: "expression", expression: "feature | main | oldb", maxCount: 2 },
        { cwd: f.repo },
      );
      try {
        const first = await source.read({ limit: 1 });
        const second = await source.read({ limit: 1 });
        expect(first.commits[0]!.graphCutoffParentRevisionIds).toBeUndefined();
        // oldb belongs to the query even though the display row cap excludes it.
        expect(second.commits[0]!.graphCutoffParentRevisionIds).toBeUndefined();
      } finally {
        await source.close();
      }
    },
  );

  jjTest("accepts none() and rejects a bad expression even with a zero row limit", async () => {
    const f = createHk93TestRepo();
    for (const maxCount of [undefined, 0]) {
      const none = await readHk191TestHistory(f.repo, {
        kind: "expression",
        expression: "none()",
        ...(maxCount === undefined ? {} : { maxCount }),
      });
      expect(none.commits).toEqual([]);
      expect(none.expression).toBe("none()");
    }
    const expected =
      "Function `missing_function` doesn't exist\nCaused by:  --> 1:1\n  = Function `missing_function` doesn't exist";
    await expect(
      openJjHistory(
        { kind: "expression", expression: "missing_function()", maxCount: 0 },
        { cwd: f.repo },
      ),
    ).rejects.toThrow(expected);
    // Without a zero limit the same failure surfaces on the first read.
    const source = await openJjHistory(
      { kind: "expression", expression: "missing_function()" },
      { cwd: f.repo },
    );
    const failure = await source.read({ limit: 5 }).catch((error: unknown) => error);
    expect((failure as Error).message).toBe(expected);
    await source.close();
    await expect(
      getJjHistoryWatchSignature(
        { kind: "expression", expression: "missing_function()" },
        { cwd: f.repo },
      ),
    ).rejects.toThrow(expected);
  });

  unixTest("keeps a legacy launch's error text and filters only expression input's", async () => {
    const temp = mkdtempSync(join(tmpdir(), "hunk-jj-errors-"));
    tempDirs.push(temp);
    const executable = join(temp, "failing-jj");
    // Everything except the history query succeeds; that query prints JJ's real stderr shape.
    writeFileSync(
      executable,
      `#!/bin/sh
case "$*" in
  *" root")
    echo "${temp}"
    exit 0
    ;;
  *" op log "*)
    echo "${"0".repeat(128)}"
    exit 0
    ;;
  *" config list"*)
    echo "fixture=true"
    exit 0
    ;;
  *"present(trunk())"*)
    exit 0
    ;;
esac
cat >&2 <<'STDERR'
Error: Failed to parse revset: Function \`missing_function\` doesn't exist
Caused by:  --> 1:1
  |
1 | missing_function()
  | ^----------------^
  |
  = Function \`missing_function\` doesn't exist
STDERR
exit 1
`,
    );
    chmodSync(executable, 0o755);
    const options = { cwd: temp, jjExecutable: executable };
    const legacyFirstLine =
      "Error: Failed to parse revset: Function `missing_function` doesn't exist";
    const filtered =
      "Function `missing_function` doesn't exist\nCaused by:  --> 1:1\n  = Function `missing_function` doesn't exist";

    // Legacy launch: the first stderr line at the cursor, the whole trimmed stderr at the signature.
    const legacy = await openJjHistory({ revision: "x" }, options);
    expect(((await legacy.read({ limit: 5 }).catch((e: unknown) => e)) as Error).message).toBe(
      legacyFirstLine,
    );
    await legacy.close();
    const legacySignature = await getJjHistoryWatchSignature({ revision: "x" }, options).catch(
      (e: unknown) => e,
    );
    expect((legacySignature as Error).message).toStartWith(`${legacyFirstLine}\nCaused by:`);
    expect((legacySignature as Error).message).toContain("1 | missing_function()");

    // Expression input: the filtered text at the cursor, the zero-limit check and the signature.
    const custom = await openJjHistory({ kind: "expression", expression: "x" }, options);
    expect(((await custom.read({ limit: 5 }).catch((e: unknown) => e)) as Error).message).toBe(
      filtered,
    );
    await custom.close();
    await expect(
      openJjHistory({ kind: "expression", expression: "x", maxCount: 0 }, options),
    ).rejects.toThrow(filtered);
    await expect(
      getJjHistoryWatchSignature({ kind: "expression", expression: "x" }, options),
    ).rejects.toThrow(filtered);

    // The legacy zero-limit shortcut still skips the query entirely.
    const shortcut = await openJjHistory({ revision: "x", maxCount: 0 }, options);
    expect(await shortcut.read({ limit: 5 })).toEqual({ commits: [], done: true });
  });

  jjTest("fingerprints expression input without a scope prefix", async () => {
    const f = createHk93TestRepo();
    const custom = await getJjHistoryWatchSignature(
      { kind: "expression", expression: "@-" },
      { cwd: f.repo },
    );
    const launch = await getJjHistoryWatchSignature({}, { cwd: f.repo });
    expect(custom).not.toBe(launch);
    expect(launch.startsWith("{")).toBe(true);
    expect(custom.startsWith("{")).toBe(false);
    expect(custom).toContain("sibling");
    expect(custom).toContain("feature");
    expect(custom).not.toContain("merge");
  });

  unixTest("drops a leading Error: from every failure of expression input only", async () => {
    const temp = mkdtempSync(join(tmpdir(), "hunk-jj-setup-errors-"));
    tempDirs.push(temp);
    const makeExecutable = (name: string, failing: "root" | "op") => {
      const executable = join(temp, name);
      const rootBody =
        failing === "root"
          ? `echo 'Error: There is no jj repo in "."' >&2\n    exit 1`
          : `echo "${temp}"\n    exit 0`;
      const opBody =
        failing === "op"
          ? `echo 'Error: The repo is corrupt' >&2\n    exit 1`
          : `echo "${"0".repeat(128)}"\n    exit 0`;
      writeFileSync(
        executable,
        `#!/bin/sh
case "$*" in
  *" root")
    ${rootBody}
    ;;
  *" op log "*)
    ${opBody}
    ;;
esac
exit 0
`,
      );
      chmodSync(executable, 0o755);
      return { cwd: temp, jjExecutable: executable };
    };

    const noRepo = makeExecutable("no-repo-jj", "root");
    await expect(openJjHistory({ kind: "expression", expression: "@" }, noRepo)).rejects.toThrow(
      new RegExp('^There is no jj repo in "\\."$'),
    );
    await expect(openJjHistory({ revision: "@" }, noRepo)).rejects.toThrow(
      'Error: There is no jj repo in "."',
    );

    const corrupt = makeExecutable("corrupt-jj", "op");
    for (const open of [
      (input: Parameters<typeof openJjHistory>[0]) => openJjHistory(input, corrupt),
      (input: Parameters<typeof openJjHistory>[0]) => getJjHistoryWatchSignature(input, corrupt),
    ]) {
      await expect(open({ kind: "expression", expression: "@" })).rejects.toThrow(
        new RegExp("^The repo is corrupt$"),
      );
      await expect(open({ revision: "@" })).rejects.toThrow("Error: The repo is corrupt");
    }
  });

  test("registers the expression capability", () => {
    expect(createJjVcsAdapter().history.acceptsExpression).toBe(true);
  });
});

describe("HK-98 native history presentation", () => {
  jjTest("streams native graph rows with 3 body prefixes and after rows", async () => {
    const repo = createJjOnlyTestRepo();
    writeFileSync(join(repo, "file1.txt"), "first\n");
    jj(repo, "commit", "-m", "First commit\n\nDetailed body line 1\nDetailed body line 2");
    writeFileSync(join(repo, "file2.txt"), "second\n");
    jj(repo, "describe", "-m", "Working copy commit");

    const source = await openJjHistory({ all: true }, { cwd: repo, graphStyle: "native" });
    try {
      expect(source.graphStyle).toBe("native");
      expect(typeof source.graphSnapshotId).toBe("string");
      expect(source.graphSnapshotId!.length).toBeGreaterThan(0);

      const page = await source.read({ limit: 10 });
      expect(page.commits.length).toBeGreaterThanOrEqual(2);

      const wcCommit = page.commits[0]!;
      expect(wcCommit.subject).toBe("Working copy commit");
      expect(wcCommit.nativeGraph).toBeDefined();
      expect(wcCommit.nativeGraph!.body).toHaveLength(3);
      expect(wcCommit.nativeGraph!.body[0]).toContain("@");
      expect(Array.isArray(wcCommit.nativeGraph!.after)).toBe(true);

      const parentCommit = page.commits[1]!;
      expect(parentCommit.subject).toBe("First commit");
      expect(parentCommit.body).toBe("Detailed body line 1\nDetailed body line 2");
      expect(parentCommit.nativeGraph).toBeDefined();
      expect(parentCommit.nativeGraph!.body).toHaveLength(3);
      expect(Array.isArray(parentCommit.nativeGraph!.after)).toBe(true);
    } finally {
      await source.close();
    }
  });

  jjTest(
    "transitions between default and native with identical snapshot id and scope",
    async () => {
      const repo = createJjOnlyTestRepo();
      writeFileSync(join(repo, "file.txt"), "content\n");
      jj(repo, "commit", "-m", "Test commit");

      const defaultSource = await openJjHistory(
        { all: true },
        { cwd: repo, graphStyle: "default" },
      );
      try {
        expect(defaultSource.graphStyle).toBe("default");
        const defaultSnap = defaultSource.graphSnapshotId;
        expect(defaultSnap).toBeDefined();

        const defaultPage = await defaultSource.read({ limit: 5 });
        expect(defaultPage.commits[0]!.nativeGraph).toBeUndefined();

        const nativeSource = await defaultSource.openGraph!("native");
        try {
          expect(nativeSource.graphStyle).toBe("native");
          expect(nativeSource.graphSnapshotId).toBe(defaultSnap);

          const nativePage = await nativeSource.read({ limit: 5 });
          expect(nativePage.commits[0]!.nativeGraph).toBeDefined();
          expect(nativePage.commits[0]!.revisionId).toBe(defaultPage.commits[0]!.revisionId);

          const roundTripSource = await nativeSource.openGraph!("default");
          try {
            expect(roundTripSource.graphStyle).toBe("default");
            expect(roundTripSource.graphSnapshotId).toBe(defaultSnap);
          } finally {
            await roundTripSource.close();
          }
        } finally {
          await nativeSource.close();
        }
      } finally {
        await defaultSource.close();
      }
    },
  );

  jjTest("detects config drift and rejects switching graph", async () => {
    const repo = createJjOnlyTestRepo();
    writeFileSync(join(repo, "file.txt"), "hello\n");
    jj(repo, "commit", "-m", "Initial");

    const source = await openJjHistory({ all: true }, { cwd: repo, graphStyle: "default" });
    try {
      // Mutate configuration
      jj(repo, "config", "set", "--repo", "ui.graph.style", "ascii");

      await expect(source.openGraph!("native")).rejects.toThrow(
        "JJ configuration changed. Refresh history before switching graph.",
      );
    } finally {
      await source.close();
    }
  });
});

describe("native graph real JJ correspondence", () => {
  jjTest(
    "matches configured four-style graph lines and IDs across octopus, elision and one-entry pages",
    async () => {
      const repo = createJjOnlyTestRepo();
      writeFileSync(join(repo, "base.txt"), "base\n");
      jj(repo, "commit", "-m", "Base");
      jj(repo, "bookmark", "create", "main", "-r", "@-");
      for (const name of ["left", "right", "third"]) {
        jj(repo, "new", "main", "-m", name);
        writeFileSync(join(repo, `${name}.txt`), name);
        jj(repo, "bookmark", "create", name, "-r", "@");
      }
      jj(repo, "new", "left", "right", "third", "-m", "Octopus merge");
      jj(repo, "config", "set", "--repo", 'revset-aliases."trunk()"', "main");
      for (const style of ["curved", "square", "ascii", "ascii-large"]) {
        jj(repo, "config", "set", "--repo", "ui.graph.style", style);
        for (const expression of ["all()", "@ | main"]) {
          const input = { kind: "expression", expression } as const;
          const prepared = await prepareJjHistory(input, { cwd: repo });
          const reference = jj(repo, ...buildJjHistoryArgs(input, prepared, "native"));
          const expected: { id: string; body: string[]; after: string[] }[] = [];
          const lines = reference.split("\n");
          if (lines.at(-1) === "") lines.pop();
          for (const line of lines) {
            const marker = /\x02HUNK:B([123])\x1e/.exec(line);
            if (marker) {
              const index = marker.index;
              if (marker[1] === "1")
                expected.push({
                  id: line.slice(index + marker[0].length).split("\0")[0]!,
                  body: [],
                  after: [],
                });
              expected.at(-1)!.body.push(line.slice(0, index));
            } else expected.at(-1)!.after.push(line);
          }
          const source = await openJjHistory(input, { cwd: repo }, prepared, "native");
          const actual: typeof expected = [];
          try {
            while (true) {
              const page = await source.read({ limit: 1 });
              actual.push(
                ...page.commits.map((c) => ({
                  id: c.revisionId,
                  body: c.nativeGraph!.body,
                  after: c.nativeGraph!.after,
                })),
              );
              if (page.done) break;
            }
          } finally {
            await source.close();
          }
          expect(actual).toEqual(expected);
          expect(new Set(actual.map((c) => c.id)).size).toBe(actual.length);
        }
      }
    },
    30_000,
  );

  jjTest("accepts 5000-character metadata and refuses drift after candidate open", async () => {
    const repo = createJjOnlyTestRepo();
    jj(repo, "describe", "-m", "x".repeat(5000));
    const source = await openJjHistory({ all: true }, { cwd: repo });
    try {
      const native = await source.openGraph!("native");
      try {
        expect((await native.read({ limit: 1 })).commits[0]!.subject.length).toBe(5000);
      } finally {
        await native.close();
      }
      const staged = await source.openGraph!("native");
      jj(repo, "config", "set", "--repo", "ui.graph.style", "ascii");
      try {
        await expect(staged.read({ limit: 1 })).rejects.toThrow("JJ configuration changed");
      } finally {
        await staged.close();
      }
    } finally {
      await source.close();
    }
  });
});

unixTest("native production cursor drains byte pressure below a 256-record request", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hunk-native-pressure-"));
  tempDirs.push(cwd);
  const executable = join(cwd, "fake-jj");
  writeFileSync(
    executable,
    `#!${process.execPath}
const args=process.argv.slice(2);
if(args.includes("root")){console.log(process.cwd());process.exit(0);}
if(args.includes("config")){console.log("fixture=true");process.exit(0);}
for(let i=1;i<=50;i++){
 const record=[i.toString(16).padStart(40,"0"),"abcd1234","logical","",JSON.stringify("Ada"),JSON.stringify("ada@example.invalid"),"2026-01-01T00:00:00Z",JSON.stringify("subject"),"0","","","","","false","","false"].join("\\0");
 process.stdout.write("@  \\x02HUNK:B1\\x1e"+record+"\\x1eHUNK:E1\\x03\\n|  \\x02HUNK:B2\\x1e\\x1eHUNK:E2\\x03\\n|  \\x02HUNK:B3\\x1e\\x1eHUNK:E3\\x03\\n");
 for(let n=0;n<30;n++)process.stdout.write("|".repeat(4096)+"\\n");
}
`,
  );
  chmodSync(executable, 0o755);
  const options = { cwd, jjExecutable: executable };
  const prepared = {
    operationId: "f".repeat(128),
    configFingerprint: await getJjConfigFingerprint(options),
    graphSnapshotId: "snapshot",
    template: "unused",
    nativeTemplate: "unused",
    fieldsPerCommit: 16,
  };
  const source = await openJjHistory({ all: true }, options, prepared, "native");
  const commits = [];
  try {
    while (true) {
      const page = await source.read({ limit: 256, signal: AbortSignal.timeout(3000) });
      expect(page.commits.length).toBeGreaterThan(0);
      commits.push(...page.commits);
      if (page.done) break;
    }
    expect(commits).toHaveLength(50);
    expect(new Set(commits.map((c) => c.revisionId)).size).toBe(50);
  } finally {
    await source.close();
  }
});

unixTest("configuration fingerprint errors fail closed without raw diagnostics", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hunk-native-config-error-"));
  tempDirs.push(cwd);
  const executable = join(cwd, "fake-jj");
  writeFileSync(
    executable,
    `#!${process.execPath}\nconsole.error("private configuration secret");process.exit(1);\n`,
  );
  chmodSync(executable, 0o755);
  await expect(getJjConfigFingerprint({ cwd, jjExecutable: executable })).rejects.toThrow(
    "Could not attest JJ configuration",
  );
  try {
    await getJjConfigFingerprint({ cwd, jjExecutable: executable });
  } catch (error) {
    expect(String(error)).not.toContain("private configuration secret");
  }
});

jjTest(
  "configured wide nodes remain JJ-authored and graph/no-graph limits keep their own ordering",
  async () => {
    const f = createHk93TestRepo();
    jj(f.repo, "config", "set", "--repo", "templates.log_node", JSON.stringify('"界"'));
    const input = { all: true };
    const prepared = await prepareJjHistory(input, { cwd: f.repo });
    const orders: string[][] = [];
    const reference = jj(f.repo, ...buildJjHistoryArgs(input, prepared, "native"));
    expect(reference).toContain("界");
    const expectedPrefixes = reference
      .split("\n")
      .filter((line) => line.includes("\x02HUNK:B1\x1e"))
      .map((line) => line.slice(0, line.indexOf("\x02HUNK:B1\x1e")));
    for (const style of ["default", "native"] as const) {
      const source = await openJjHistory(input, { cwd: f.repo }, prepared, style);
      try {
        const page = await source.read({ limit: 256 });
        orders.push(page.commits.map((c) => c.revisionId));
        if (style === "native") {
          expect(page.commits.map((c) => c.nativeGraph!.body[0])).toEqual(expectedPrefixes);
          expect(
            page.commits
              .filter((c) => !/^0+$/.test(c.revisionId))
              .map((c) => ({ subject: c.subject, prefix: c.nativeGraph!.body[0] })),
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ prefix: expect.stringContaining("界") }),
            ]),
          );
        }
      } finally {
        await source.close();
      }
    }
    expect(new Set(orders[0])).toEqual(new Set(orders[1]));
    expect(orders[0]).not.toEqual(orders[1]);
    for (const style of ["default", "native"] as const) {
      const source = await openJjHistory(
        { ...input, maxCount: 3 },
        { cwd: f.repo },
        prepared,
        style,
      );
      try {
        expect((await source.read({ limit: 256 })).commits.map((c) => c.revisionId)).toEqual(
          orders[style === "default" ? 0 : 1]!.slice(0, 3),
        );
      } finally {
        await source.close();
      }
    }
  },
  15000,
);
