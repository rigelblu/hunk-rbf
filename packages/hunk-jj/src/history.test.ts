import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJjVcsAdapter } from "./index";
import {
  buildJjHistoryArgs,
  getJjHistoryWatchSignature,
  buildJjHistoryRevset,
  jjHistoryUsesBoundaryTopology,
  loadJjReviewCommits,
  openJjHistory,
  parseJjHistory,
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
    { cwd: repo, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
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
      ].join("\0");

    expect(parseJjHistory(makeRaw("true"))[0]!.isEmpty).toBe(true);
    expect(parseJjHistory(makeRaw("false"))[0]!.isEmpty).toBe(false);

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
      // missing 14th field
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
  *"present(trunk())"*)
    exit 0
    ;;
esac
printf '%s\\0%s\\0%s\\0%s\\0' "${"a".repeat(40)}" "aaaaaaaa" "${"k".repeat(32)}" ""
printf '%s\\0%s\\0%s\\0%s\\0' "Ada" "" "2026-01-01T00:00:00+00:00" "First split"
printf '%s\\0%s\\0%s\\0%s\\0%s\\0' "0" "" "" "" ""
printf 'tr'
sleep 0.02
printf 'ue\\0\\0'
printf '%s\\0%s\\0%s\\0%s\\0' "${"b".repeat(40)}" "bbbbbbbb" "${"k".repeat(32)}" "${"a".repeat(40)}"
printf '%s\\0%s\\0%s\\0%s\\0' "Ada" "" "2026-01-02T00:00:00+00:00" "Second split"
printf '%s\\0%s\\0%s\\0%s\\0%s\\0' "0" "" "" "" ""
printf 'fal'
sleep 0.02
printf 'se\\0\\0'
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
