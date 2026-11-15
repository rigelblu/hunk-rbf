import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionVcsMutationExecution,
  ExtensionVcsMutationPrepared,
  ExtensionVcsMutationRevisionRef,
} from "hunkdiff/extension";
import { listJjMutationKinds } from "./mutationKinds";
import { createJjMutationCapability } from "./mutationRunner";

const JjMutationTestTimeoutMs = 60_000;
// Keep jj-backed coverage opt-in on machines that have the external CLI installed.
const jjTest = Bun.which("jj") ? test : test.skip;
const unixJjTest = Bun.which("jj") && process.platform !== "win32" ? test : test.skip;
// A colocated repository lets Git move a ref jj has not read yet.
const colocatedTest = Bun.which("jj") && Bun.which("git") ? test : test.skip;

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** A throwaway repository and everything a test needs to drive jj inside it. */
interface MutationTestRepo {
  dir: string;
  env: Record<string, string | undefined>;
  jj(...args: string[]): string;
  ref(revset: string): ExtensionVcsMutationRevisionRef;
  log(): string[];
  operation(): string;
  execution: ExtensionVcsMutationExecution;
  commands: string[][];
}

/**
 * Creates a repository with three revisions, one -> two -> three (the working copy).
 *
 * jj runs with an explicit configuration file, so neither the developer's own
 * settings nor a signing helper can change what a test observes.
 */
function createMutationTestRepo(extraConfig: readonly string[] = []): MutationTestRepo {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunk-jj-mutation-")));
  tempDirs.push(root);
  const config = join(root, "config.toml");
  writeFileSync(
    config,
    [
      "[user]",
      'name = "Test User"',
      'email = "test@example.com"',
      "[signing]",
      'behavior = "drop"',
      "[revset-aliases]",
      '"immutable_heads()" = "present(frozen)"',
      ...extraConfig,
      "",
    ].join("\n"),
  );
  const env: Record<string, string | undefined> = { ...process.env, JJ_CONFIG: config };
  const dir = join(root, "repo");
  const run = (cwd: string, args: string[]) => {
    const proc = Bun.spawnSync(["jj", "--no-pager", "--color", "never", ...args], {
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      throw new Error(proc.stderr.toString() || `jj ${args.join(" ")} failed`);
    }
    return proc.stdout.toString();
  };
  run(root, ["git", "init", "--colocate", dir]);
  const jj = (...args: string[]) => run(dir, args);
  writeFileSync(join(dir, "one.txt"), "one\n");
  jj("describe", "-m", "one");
  jj("new", "-m", "two");
  writeFileSync(join(dir, "two.txt"), "two\n");
  jj("new", "-m", "three");
  writeFileSync(join(dir, "three.txt"), "three\n");
  jj("status");

  const commands: string[][] = [];
  return {
    dir,
    env,
    jj,
    commands,
    ref(revset) {
      const [revisionId, logicalId] = jj(
        "--ignore-working-copy",
        "log",
        "--no-graph",
        "-r",
        revset,
        "-T",
        'commit_id ++ " " ++ change_id',
      )
        .trim()
        .split(" ");
      return { revisionId: revisionId!, logicalId: logicalId! };
    },
    log() {
      return jj(
        "--ignore-working-copy",
        "log",
        "--no-graph",
        "-r",
        "all() ~ root()",
        "-T",
        'description.first_line() ++ "\\n"',
      )
        .split("\n")
        .slice(0, -1);
    },
    operation() {
      return jj("--ignore-working-copy", "op", "log", "--no-graph", "-n", "1", "-T", "id").trim();
    },
    execution: {
      signal: new AbortController().signal,
      async run(invocation) {
        commands.push(invocation.args);
        const proc = Bun.spawnSync([invocation.executable, ...invocation.args], {
          cwd: invocation.cwd,
          env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        return {
          started: true,
          exitCode: proc.exitCode,
          signal: null,
          wasInterrupted: false,
          terminal: invocation.terminal,
          terminalRestored: true,
          text: `${proc.stderr.toString()}${proc.stdout.toString()}`.trim(),
        };
      },
    },
  };
}

/** Prepares an abandon of one revision and returns the preparation that must be ready. */
async function prepareTestAbandon(repo: MutationTestRepo, source: ExtensionVcsMutationRevisionRef) {
  const capability = createJjMutationCapability({ env: repo.env });
  const preparation = await capability.prepare(
    { kind: "abandon", sources: [source] },
    { cwd: repo.dir },
  );
  if (preparation.kind !== "ready") {
    throw new Error(`expected a ready preparation, got ${JSON.stringify(preparation)}`);
  }
  return { capability, prepared: preparation.prepared as ExtensionVcsMutationPrepared };
}

describe("createJjMutationCapability", () => {
  jjTest(
    "offers the registered kinds on a supported jj",
    async () => {
      const repo = createMutationTestRepo();
      const availability = await createJjMutationCapability({ env: repo.env }).availability({
        cwd: repo.dir,
      });
      expect(availability).toMatchObject({ kind: "supported", kinds: listJjMutationKinds() });
    },
    JjMutationTestTimeoutMs,
  );

  jjTest(
    "previews an abandon without moving anything, then applies it",
    async () => {
      const repo = createMutationTestRepo();
      const two = repo.ref("@-");
      const one = repo.ref("@--");
      const three = repo.ref("@");
      repo.jj("--ignore-working-copy", "bookmark", "create", "feature", "-r", two.logicalId!);
      const before = repo.operation();

      const { capability, prepared } = await prepareTestAbandon(repo, two);

      // The preview recorded nothing jj made current, and the files are untouched.
      expect(repo.operation()).toBe(before);
      expect(repo.log()).toEqual(["three", "two", "one"]);
      expect(prepared.facts).toMatchObject({
        operationId: before,
        files: { kind: "clean" },
        revisions: [{ revisionId: two.revisionId, description: "two\n", isWorkingCopy: false }],
      });
      expect(prepared.projection).toMatchObject({
        notes: [
          "1 descendant will be rebased onto its parent.",
          "Bookmark feature moves to the parent.",
        ],
        warnings: [],
      });
      expect(prepared.preview?.operations).toMatchObject([{ isSnapshot: false, isOwn: true }]);
      const previewed = prepared.preview!.revisions;
      expect(previewed.map((entry) => entry.logicalId).sort()).toEqual(
        [two.logicalId!, three.logicalId!].sort(),
      );
      expect(previewed.find((entry) => entry.logicalId === two.logicalId)).toMatchObject({
        before: [{ revisionId: two.revisionId }],
        after: [],
      });
      expect(prepared.preview?.bookmarks).toMatchObject([
        { name: "feature", after: [{ revisionId: one.revisionId }], followsRevision: false },
      ]);

      const result = await capability.apply(prepared.handleId, repo.execution, { cwd: repo.dir });

      expect(result).toMatchObject({
        kind: "ran",
        change: { kind: "read" },
        verdict: { outcome: "completed", selectAfter: { revisionId: one.revisionId } },
        isWorkingCopyStale: false,
      });
      expect(repo.log()).toEqual(["three", "one"]);
      // The change id addresses the revision, and the run's operations carry the run's token.
      expect(repo.commands[0]).toContain(`change_id(${two.logicalId})`);
      if (result.kind !== "ran" || result.change.kind !== "read") throw new Error("unreachable");
      expect(result.change.value.operations).toMatchObject([{ isSnapshot: false, isOwn: true }]);
      // A handle is valid for one apply.
      expect(await capability.apply(prepared.handleId, repo.execution, { cwd: repo.dir })).toEqual({
        kind: "not-run",
        reason: "stale-handle",
      });
    },
    JjMutationTestTimeoutMs,
  );

  jjTest(
    "names the pending files and abandons the working copy's current version",
    async () => {
      const repo = createMutationTestRepo();
      const three = repo.ref("@");
      writeFileSync(join(repo.dir, "three.txt"), "three, edited\n");
      writeFileSync(join(repo.dir, "new.txt"), "new\n");
      const before = repo.operation();

      const { capability, prepared } = await prepareTestAbandon(repo, three);

      expect(repo.operation()).toBe(before);
      expect(readFileSync(join(repo.dir, "three.txt"), "utf8")).toBe("three, edited\n");
      expect(prepared.facts.files).toEqual({ kind: "pending", paths: ["new.txt", "three.txt"] });
      expect(prepared.projection.warnings).toEqual([
        "This is the working-copy revision. Abandoning it takes its unrecorded changes to 2 files out of your files.",
      ]);
      expect(prepared.preview?.operations).toMatchObject([
        { isSnapshot: true },
        { isSnapshot: false },
      ]);

      const result = await capability.apply(prepared.handleId, repo.execution, { cwd: repo.dir });

      expect(result).toMatchObject({ kind: "ran", verdict: { outcome: "completed" } });
      expect(repo.log()).toEqual(["", "two", "one"]);
      expect(existsSync(join(repo.dir, "new.txt"))).toBe(false);
      expect(existsSync(join(repo.dir, "three.txt"))).toBe(false);
    },
    JjMutationTestTimeoutMs,
  );

  jjTest(
    "does not run when a file was saved after the preview, and offers the new preview",
    async () => {
      const repo = createMutationTestRepo();
      const two = repo.ref("@-");
      const { capability, prepared } = await prepareTestAbandon(repo, two);

      writeFileSync(join(repo.dir, "late.txt"), "saved after the preview\n");
      const result = await capability.apply(prepared.handleId, repo.execution, { cwd: repo.dir });

      expect(repo.commands).toEqual([]);
      expect(result).toMatchObject({
        kind: "not-run",
        reason: "changed",
        revisions: [{ revision: { revisionId: two.revisionId }, state: "current" }],
        refreshed: {
          kind: "ready",
          prepared: { facts: { files: { kind: "pending", paths: ["late.txt"] } } },
        },
      });
      if (result.kind !== "not-run" || result.reason !== "changed") throw new Error("unreachable");
      if (result.refreshed.kind !== "ready") throw new Error("unreachable");

      // The refreshed preparation is the one the user confirms next.
      const second = await capability.apply(result.refreshed.prepared.handleId, repo.execution, {
        cwd: repo.dir,
      });
      expect(second).toMatchObject({ kind: "ran", verdict: { outcome: "completed" } });
      expect(repo.log()).toEqual(["three", "one"]);
      expect(readFileSync(join(repo.dir, "late.txt"), "utf8")).toBe("saved after the preview\n");
    },
    JjMutationTestTimeoutMs,
  );

  jjTest(
    "runs when another operation landed but the preview is still the same",
    async () => {
      const repo = createMutationTestRepo();
      const two = repo.ref("@-");
      const { capability, prepared } = await prepareTestAbandon(repo, two);

      // An unrelated operation moves the current operation without touching what was confirmed.
      repo.jj("--ignore-working-copy", "bookmark", "create", "elsewhere", "-r", "root()");
      const result = await capability.apply(prepared.handleId, repo.execution, { cwd: repo.dir });

      expect(result).toMatchObject({ kind: "ran", verdict: { outcome: "completed" } });
      expect(repo.log()).toEqual(["three", "one"]);
    },
    JjMutationTestTimeoutMs,
  );

  jjTest(
    "does not run when the source was rewritten after the preview",
    async () => {
      const repo = createMutationTestRepo();
      const two = repo.ref("@-");
      const { capability, prepared } = await prepareTestAbandon(repo, two);

      repo.jj("--ignore-working-copy", "describe", "-r", two.logicalId!, "-m", "two, reworded");
      const result = await capability.apply(prepared.handleId, repo.execution, { cwd: repo.dir });

      expect(repo.commands).toEqual([]);
      expect(result).toMatchObject({
        kind: "not-run",
        reason: "changed",
        revisions: [{ revision: { revisionId: two.revisionId }, state: "rewritten" }],
        refreshed: { kind: "refused" },
      });
      expect(repo.log()).toEqual(["three", "two, reworded", "one"]);
    },
    JjMutationTestTimeoutMs,
  );

  jjTest(
    "refuses an immutable revision with jj's own reason",
    async () => {
      const repo = createMutationTestRepo();
      const one = repo.ref("@--");
      repo.jj("--ignore-working-copy", "bookmark", "create", "frozen", "-r", one.logicalId!);
      const before = repo.operation();

      const preparation = await createJjMutationCapability({ env: repo.env }).prepare(
        { kind: "abandon", sources: [one] },
        { cwd: repo.dir },
      );

      expect(preparation).toMatchObject({
        kind: "refused",
        reason: "JJ will not abandon this revision.",
        facts: { revisions: [{ isImmutable: true }] },
      });
      if (preparation.kind !== "refused") throw new Error("unreachable");
      expect(preparation.providerText).toContain("immutable");
      expect(repo.operation()).toBe(before);
    },
    JjMutationTestTimeoutMs,
  );

  jjTest(
    "refuses a revision that history no longer shows",
    async () => {
      const repo = createMutationTestRepo();
      const two = repo.ref("@-");
      repo.jj("--ignore-working-copy", "describe", "-r", two.logicalId!, "-m", "two, reworded");

      const preparation = await createJjMutationCapability({ env: repo.env }).prepare(
        { kind: "abandon", sources: [two] },
        { cwd: repo.dir },
      );

      expect(preparation).toMatchObject({
        kind: "refused",
        reason:
          "A chosen revision changed after history was loaded. Refresh history, then try again.",
      });
    },
    JjMutationTestTimeoutMs,
  );

  jjTest(
    "does not run when a pending file was saved again with other content",
    async () => {
      const repo = createMutationTestRepo();
      const two = repo.ref("@-");
      writeFileSync(join(repo.dir, "three.txt"), "first save\n");
      const { capability, prepared } = await prepareTestAbandon(repo, two);
      expect(prepared.facts.files).toEqual({ kind: "pending", paths: ["three.txt"] });

      // Same path, same operation: only the content tells the two apart.
      writeFileSync(join(repo.dir, "three.txt"), "second save\n");
      const result = await capability.apply(prepared.handleId, repo.execution, { cwd: repo.dir });

      expect(repo.commands).toEqual([]);
      expect(result).toMatchObject({
        kind: "not-run",
        reason: "changed",
        refreshed: { kind: "ready" },
      });
    },
    JjMutationTestTimeoutMs,
  );

  jjTest(
    "follows a working copy jj only recorded, and shows what the mutation does now",
    async () => {
      const repo = createMutationTestRepo();
      const three = repo.ref("@");
      writeFileSync(join(repo.dir, "three.txt"), "edited\n");
      const { capability, prepared } = await prepareTestAbandon(repo, three);

      // Another jj command records the pending file, which gives the working copy a new commit id.
      repo.jj("status");
      const recorded = repo.ref("@");
      const result = await capability.apply(prepared.handleId, repo.execution, { cwd: repo.dir });

      expect(repo.commands).toEqual([]);
      expect(result).toMatchObject({
        kind: "not-run",
        reason: "changed",
        revisions: [{ revision: { revisionId: three.revisionId }, state: "snapshot-only" }],
        refreshed: {
          kind: "ready",
          prepared: { facts: { revisions: [{ revisionId: recorded.revisionId }] } },
        },
      });
    },
    JjMutationTestTimeoutMs,
  );

  jjTest(
    "does not run when the same source would now move another descendant",
    async () => {
      const repo = createMutationTestRepo();
      const two = repo.ref("@-");
      const { capability, prepared } = await prepareTestAbandon(repo, two);

      repo.jj(
        "--ignore-working-copy",
        "new",
        "--no-edit",
        `change_id(${two.logicalId})`,
        "-m",
        "late",
      );
      const result = await capability.apply(prepared.handleId, repo.execution, { cwd: repo.dir });

      expect(repo.commands).toEqual([]);
      expect(result).toMatchObject({
        kind: "not-run",
        reason: "changed",
        revisions: [{ state: "current" }],
        refreshed: {
          kind: "ready",
          prepared: { projection: { notes: ["2 descendants will be rebased onto its parent."] } },
        },
      });
    },
    JjMutationTestTimeoutMs,
  );

  jjTest(
    "reads pending files when the user's configuration makes jj quiet",
    async () => {
      const repo = createMutationTestRepo(["[ui]", "quiet = true"]);
      const two = repo.ref("@-");
      writeFileSync(join(repo.dir, "three.txt"), "edited\n");

      const { capability, prepared } = await prepareTestAbandon(repo, two);

      expect(prepared.facts.files).toEqual({ kind: "pending", paths: ["three.txt"] });
      const result = await capability.apply(prepared.handleId, repo.execution, { cwd: repo.dir });
      expect(result).toMatchObject({ kind: "ran", verdict: { outcome: "completed" } });
    },
    JjMutationTestTimeoutMs,
  );

  unixJjTest(
    "refuses when jj rewords the line that names its snapshot",
    async () => {
      const repo = createMutationTestRepo();
      const two = repo.ref("@-");
      writeFileSync(join(repo.dir, "three.txt"), "edited\n");
      const wrapper = join(repo.dir, "..", "reworded-jj");
      writeFileSync(
        wrapper,
        `#!/bin/sh\n"${Bun.which("jj")}" "$@" 2>"$0.err"\ncode=$?\nsed 's/^Snapshot operation left uncommitted/Snapshot kept aside/' "$0.err" >&2\nexit $code\n`,
      );
      chmodSync(wrapper, 0o755);
      const before = repo.operation();

      const preparation = await createJjMutationCapability({
        jjExecutable: wrapper,
        env: repo.env,
      }).prepare({ kind: "abandon", sources: [two] }, { cwd: repo.dir });

      expect(preparation).toMatchObject({
        kind: "refused",
        reason: "Hunk could not read which files have unrecorded changes.",
      });
      expect(repo.operation()).toBe(before);
    },
    JjMutationTestTimeoutMs,
  );

  for (const spelling of ["change id", "commit id"] as const) {
    jjTest(
      `abandons the chosen revision when a bookmark is named like its ${spelling}`,
      async () => {
        const repo = createMutationTestRepo();
        const two = repo.ref("@-");
        const one = repo.ref("@--");
        const name = spelling === "change id" ? two.logicalId! : two.revisionId;
        repo.jj(
          "--ignore-working-copy",
          "bookmark",
          "create",
          name,
          "-r",
          `commit_id(${one.revisionId})`,
        );

        const { capability, prepared } = await prepareTestAbandon(repo, two);
        expect(prepared.facts.revisions).toMatchObject([
          { revisionId: two.revisionId, description: "two\n" },
        ]);
        const result = await capability.apply(prepared.handleId, repo.execution, { cwd: repo.dir });

        expect(result).toMatchObject({ kind: "ran", verdict: { outcome: "completed" } });
        expect(repo.log()).toEqual(["three", "one"]);
      },
      JjMutationTestTimeoutMs,
    );
  }

  jjTest(
    "abandons a revision whose description starts with hyphens",
    async () => {
      const repo = createMutationTestRepo();
      const before = repo.ref("@-");
      repo.jj(
        "--ignore-working-copy",
        "describe",
        "-r",
        `change_id(${before.logicalId})`,
        "--message=--help -r @",
      );
      const two = repo.ref("@-");

      const { capability, prepared } = await prepareTestAbandon(repo, two);
      expect(prepared.facts.revisions[0]!.description).toBe("--help -r @\n");
      const result = await capability.apply(prepared.handleId, repo.execution, { cwd: repo.dir });

      expect(result).toMatchObject({ kind: "ran", verdict: { outcome: "completed" } });
      expect(repo.log()).toEqual(["three", "one"]);
    },
    JjMutationTestTimeoutMs,
  );

  jjTest(
    "abandons one version of a divergent change while its other version is a pending working copy",
    async () => {
      const repo = createMutationTestRepo();
      const three = repo.ref("@");
      const earlier = repo.operation();
      repo.jj("describe", "-m", "three, second version");
      // Rewriting the old version from the earlier operation leaves both versions visible.
      repo.jj(
        "--ignore-working-copy",
        "--at-op",
        earlier,
        "describe",
        "-r",
        `commit_id(${three.revisionId})`,
        "-m",
        "three, first version",
      );
      repo.jj("status");
      const source = repo.ref('description(substring:"first version")');
      writeFileSync(join(repo.dir, "three.txt"), "pending on the other version\n");

      const { capability, prepared } = await prepareTestAbandon(repo, source);
      expect(prepared.facts.revisions).toMatchObject([{ isDivergent: true, isWorkingCopy: false }]);
      const result = await capability.apply(prepared.handleId, repo.execution, { cwd: repo.dir });

      expect(repo.commands[0]).toContain(`commit_id(${source.revisionId})`);
      expect(result).toMatchObject({ kind: "ran", verdict: { outcome: "completed" } });
      if (result.kind !== "ran" || result.change.kind !== "read") throw new Error("unreachable");
      // One entry for the change: the source left, and the version that stayed has a new commit id.
      const entry = result.change.value.revisions.find(
        (change) => change.logicalId === source.logicalId,
      )!;
      expect(entry.before).toHaveLength(2);
      expect(entry.after).toMatchObject([{ isWorkingCopy: true, isDivergent: false }]);
      expect(repo.log()).toEqual(["three, second version", "two", "one"]);
    },
    JjMutationTestTimeoutMs,
  );

  jjTest(
    "tells another writer's operations and jj's merge of the log from the run's own",
    async () => {
      const repo = createMutationTestRepo();
      const two = repo.ref("@-");
      const one = repo.ref("@--");
      const older = repo.operation();
      repo.jj("--ignore-working-copy", "bookmark", "create", "ours", "-r", "root()");
      const { capability, prepared } = await prepareTestAbandon(repo, two);

      // Another writer starts from an older operation in the window between the final check and the
      // run, so the operation log forks and the run's own command has to merge it first.
      const run = repo.execution.run.bind(repo.execution);
      const result = await capability.apply(
        prepared.handleId,
        {
          signal: repo.execution.signal,
          run(invocation) {
            repo.jj(
              "--ignore-working-copy",
              "--at-op",
              older,
              "bookmark",
              "create",
              "theirs",
              "-r",
              `commit_id(${one.revisionId})`,
            );
            return run(invocation);
          },
        },
        { cwd: repo.dir },
      );

      if (result.kind !== "ran" || result.change.kind !== "read") throw new Error("unreachable");
      const operations = result.change.value.operations;
      expect(
        operations.filter((operation) => operation.isOwn && !operation.isSnapshot),
      ).toHaveLength(1);
      expect(
        operations
          .filter((operation) => !operation.isOwn)
          .map((operation) => operation.description),
      ).toEqual(expect.arrayContaining([expect.stringContaining("create bookmark theirs")]));
      expect(operations.filter((operation) => !operation.isOwn).length).toBeGreaterThanOrEqual(2);
      expect(result.verdict.outcome).toBe("completed");
    },
    JjMutationTestTimeoutMs,
  );
});

describe("a long operation log", () => {
  jjTest(
    "previews and applies when the log is long and the two operations are adjacent",
    async () => {
      const repo = createMutationTestRepo();
      for (let index = 0; index < 230; index += 1) {
        repo.jj("--ignore-working-copy", "describe", "-r", "@", "-m", `three, take ${index}`);
      }
      repo.jj("status");
      const two = repo.ref("@-");

      const { capability, prepared } = await prepareTestAbandon(repo, two);
      const result = await capability.apply(prepared.handleId, repo.execution, { cwd: repo.dir });

      expect(result).toMatchObject({
        kind: "ran",
        change: { kind: "read" },
        verdict: { outcome: "completed" },
      });
    },
    JjMutationTestTimeoutMs * 2,
  );

  jjTest(
    "says the result could not be read when more than 200 operations landed during the run",
    async () => {
      const repo = createMutationTestRepo();
      const two = repo.ref("@-");
      const one = repo.ref("@--");
      const { capability, prepared } = await prepareTestAbandon(repo, two);

      const run = repo.execution.run.bind(repo.execution);
      const result = await capability.apply(
        prepared.handleId,
        {
          signal: repo.execution.signal,
          run(invocation) {
            for (let index = 0; index < 205; index += 1) {
              const target = index % 2 === 0 ? `commit_id(${one.revisionId})` : "root()";
              repo.jj(
                "--ignore-working-copy",
                "bookmark",
                "set",
                "busy",
                "-r",
                target,
                "--allow-backwards",
              );
            }
            return run(invocation);
          },
        },
        { cwd: repo.dir },
      );

      expect(result).toMatchObject({
        kind: "ran",
        change: { kind: "unread" },
        verdict: { outcome: "unexpected" },
      });
      if (result.kind !== "ran" || result.change.kind !== "unread") throw new Error("unreachable");
      expect(result.change.reason).toContain(
        "More than 200 operations were recorded since the preview.",
      );
    },
    JjMutationTestTimeoutMs * 2,
  );
});

describe("the user's jj configuration", () => {
  jjTest(
    "reads records whole when jj wraps long lines",
    async () => {
      const repo = createMutationTestRepo(["[ui]", "log-word-wrap = true"]);
      const long = `two ${"wrapped words ".repeat(20)}`.trim();
      repo.jj("--ignore-working-copy", "describe", "-r", "@-", "-m", long);
      repo.jj("status");
      const two = repo.ref("@-");

      const { prepared } = await prepareTestAbandon(repo, two);

      expect(prepared.facts.revisions[0]!.description).toBe(`${long}\n`);
    },
    JjMutationTestTimeoutMs,
  );

  jjTest(
    "never starts the signing helper for a read or a preview",
    async () => {
      const repo = createMutationTestRepo();
      const two = repo.ref("@-");
      writeFileSync(join(repo.dir, "three.txt"), "pending\n");
      // A signer that cannot work: any read or dry run that tried to sign would fail.
      const config = join(repo.dir, "..", "signing.toml");
      writeFileSync(
        config,
        [
          "[user]",
          'name = "Test User"',
          'email = "test@example.com"',
          "[signing]",
          'behavior = "force"',
          'backend = "ssh"',
          'key = "/nonexistent/hunk-test-key"',
          "",
        ].join("\n"),
      );
      const before = repo.operation();

      const preparation = await createJjMutationCapability({
        env: { ...repo.env, JJ_CONFIG: config },
      }).prepare({ kind: "abandon", sources: [two] }, { cwd: repo.dir });

      expect(preparation).toMatchObject({
        kind: "ready",
        prepared: { facts: { files: { kind: "pending", paths: ["three.txt"] } } },
      });
      expect(repo.operation()).toBe(before);
    },
    JjMutationTestTimeoutMs,
  );

  jjTest(
    "is not stopped by jj's warning about a file too large to record",
    async () => {
      const repo = createMutationTestRepo(["[snapshot]", "max-new-file-size = 16"]);
      const two = repo.ref("@-");
      writeFileSync(join(repo.dir, "big.bin"), "x".repeat(4096));

      const { capability, prepared } = await prepareTestAbandon(repo, two);

      // jj will not record the file, so it is not pending and no mutation touches it.
      expect(prepared.facts.files).toEqual({ kind: "clean" });
      const result = await capability.apply(prepared.handleId, repo.execution, { cwd: repo.dir });
      expect(result).toMatchObject({ kind: "ran", verdict: { outcome: "completed" } });
      expect(existsSync(join(repo.dir, "big.bin"))).toBe(true);
    },
    JjMutationTestTimeoutMs,
  );
});

/** Runs git in a colocated test repository. */
function gitTest(repo: MutationTestRepo, ...args: string[]) {
  const proc = Bun.spawnSync(["git", ...args], { cwd: repo.dir, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0)
    throw new Error(proc.stderr.toString() || `git ${args.join(" ")} failed`);
}

const GIT_IMPORT_WAITING =
  "Git has changes JJ has not read yet. Run `jj git import`, then try again.";

describe("a Git import that is waiting", () => {
  colocatedTest(
    "refuses before any preview, and clears once a jj command has imported",
    async () => {
      const repo = createMutationTestRepo();
      const two = repo.ref("@-");
      const one = repo.ref("@--");
      gitTest(repo, "branch", "outside", one.revisionId);
      const before = repo.operation();
      const capability = createJjMutationCapability({ env: repo.env });

      const refused = await capability.prepare(
        { kind: "abandon", sources: [two] },
        { cwd: repo.dir },
      );

      expect(refused).toEqual({ kind: "refused", reason: GIT_IMPORT_WAITING });
      // Hunk imported nothing: the operation did not move.
      expect(repo.operation()).toBe(before);

      repo.jj("git", "import");
      const ready = await capability.prepare(
        { kind: "abandon", sources: [two] },
        { cwd: repo.dir },
      );
      expect(ready.kind).toBe("ready");
    },
    JjMutationTestTimeoutMs,
  );

  colocatedTest(
    "never applies when Git moved a ref after the preview",
    async () => {
      const repo = createMutationTestRepo();
      const two = repo.ref("@-");
      const one = repo.ref("@--");
      const { capability, prepared } = await prepareTestAbandon(repo, two);

      // A branch named like the source's change id, pointing elsewhere: the worst case measured.
      gitTest(repo, "branch", two.logicalId!, one.revisionId);
      const result = await capability.apply(prepared.handleId, repo.execution, { cwd: repo.dir });

      expect(repo.commands).toEqual([]);
      expect(result).toMatchObject({
        kind: "not-run",
        reason: "changed",
        refreshed: { kind: "refused", reason: GIT_IMPORT_WAITING },
      });
      expect(repo.log()).toEqual(["three", "two", "one"]);
    },
    JjMutationTestTimeoutMs,
  );

  colocatedTest(
    "never applies when Git deleted the source's branch after the preview",
    async () => {
      const repo = createMutationTestRepo();
      const two = repo.ref("@-");
      // Created by a normal jj command, so jj exports the branch to Git.
      repo.jj("bookmark", "create", "feature", "-r", `change_id(${two.logicalId})`);
      const { capability, prepared } = await prepareTestAbandon(repo, two);

      gitTest(repo, "branch", "-D", "feature");
      const result = await capability.apply(prepared.handleId, repo.execution, { cwd: repo.dir });

      expect(repo.commands).toEqual([]);
      expect(result).toMatchObject({
        kind: "not-run",
        reason: "changed",
        refreshed: { kind: "refused", reason: GIT_IMPORT_WAITING },
      });
    },
    JjMutationTestTimeoutMs,
  );

  colocatedTest(
    "marks an import inside the run as not the run's own, and never calls an empty run completed",
    async () => {
      const repo = createMutationTestRepo();
      const two = repo.ref("@-");
      const one = repo.ref("@--");
      const { capability, prepared } = await prepareTestAbandon(repo, two);

      // Git moves in the last window, after the final check: the accepted external-writer race.
      const run = repo.execution.run.bind(repo.execution);
      const result = await capability.apply(
        prepared.handleId,
        {
          signal: repo.execution.signal,
          run(invocation) {
            gitTest(repo, "branch", "late", one.revisionId);
            return run(invocation);
          },
        },
        { cwd: repo.dir },
      );

      if (result.kind !== "ran" || result.change.kind !== "read") throw new Error("unreachable");
      const imports = result.change.value.operations.filter(
        (operation) => operation.description === "import git refs",
      );
      expect(imports).toMatchObject([{ isOwn: false }]);
      expect(result.verdict.outcome).toBe("completed");
    },
    JjMutationTestTimeoutMs,
  );

  colocatedTest(
    "never applies when Git deleted the branch of a divergent source after the preview",
    async () => {
      const repo = createMutationTestRepo();
      const three = repo.ref("@");
      const earlier = repo.operation();
      repo.jj("describe", "-m", "three, second version");
      repo.jj(
        "--ignore-working-copy",
        "--at-op",
        earlier,
        "describe",
        "-r",
        `commit_id(${three.revisionId})`,
        "-m",
        "three, first version",
      );
      repo.jj("status");
      const source = repo.ref('description(substring:"first version")');
      repo.jj("bookmark", "create", "side", "-r", `commit_id(${source.revisionId})`);
      const { capability, prepared } = await prepareTestAbandon(repo, source);

      gitTest(repo, "branch", "-D", "side");
      const result = await capability.apply(prepared.handleId, repo.execution, { cwd: repo.dir });

      expect(repo.commands).toEqual([]);
      expect(result).toMatchObject({
        kind: "not-run",
        reason: "changed",
        refreshed: { kind: "refused", reason: GIT_IMPORT_WAITING },
      });
    },
    JjMutationTestTimeoutMs,
  );

  colocatedTest(
    "refuses when Git moved HEAD before the preview, and names a command that clears it",
    async () => {
      const repo = createMutationTestRepo();
      const two = repo.ref("@-");
      gitTest(
        repo,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-q",
        "-m",
        "made by git",
      );
      const capability = createJjMutationCapability({ env: repo.env });

      const refused = await capability.prepare(
        { kind: "abandon", sources: [two] },
        { cwd: repo.dir },
      );

      if (refused.kind !== "refused") throw new Error(`expected a refusal, got ${refused.kind}`);
      const command = /`jj ([a-z -]+)`/.exec(refused.reason)?.[1];
      expect(command).toBeDefined();
      repo.jj(...command!.split(" "));
      const ready = await capability.prepare(
        { kind: "abandon", sources: [two] },
        { cwd: repo.dir },
      );
      expect(ready.kind).toBe("ready");
    },
    JjMutationTestTimeoutMs,
  );

  colocatedTest(
    "says the command had nothing to do when Git's HEAD import removed the source in the last window",
    async () => {
      const repo = createMutationTestRepo();
      repo.jj("new");
      const source = repo.ref("@");
      const { capability, prepared } = await prepareTestAbandon(repo, source);

      const run = repo.execution.run.bind(repo.execution);
      const result = await capability.apply(
        prepared.handleId,
        {
          signal: repo.execution.signal,
          run(invocation) {
            gitTest(
              repo,
              "-c",
              "user.name=Test",
              "-c",
              "user.email=test@example.com",
              "commit",
              "--allow-empty",
              "-q",
              "-m",
              "made by git",
            );
            return run(invocation);
          },
        },
        { cwd: repo.dir },
      );

      if (result.kind !== "ran" || result.change.kind !== "read") throw new Error("unreachable");
      const operations = result.change.value.operations;
      // jj wrote an import of Git's HEAD under the run's token; it is never the run's own.
      expect(operations.some((operation) => operation.description.startsWith("import git"))).toBe(
        true,
      );
      expect(operations.filter((operation) => operation.isOwn && !operation.isSnapshot)).toEqual(
        [],
      );
      expect(result.verdict).toMatchObject({
        outcome: "no-op",
        headline: "JJ had nothing to abandon.",
        warnings: ["Another operation removed this revision while the command ran."],
      });
    },
    JjMutationTestTimeoutMs,
  );

  colocatedTest(
    "completes on the right revision and discloses the import when Git's HEAD moved in the last window",
    async () => {
      const repo = createMutationTestRepo();
      const two = repo.ref("@-");
      const { capability, prepared } = await prepareTestAbandon(repo, two);

      const run = repo.execution.run.bind(repo.execution);
      const result = await capability.apply(
        prepared.handleId,
        {
          signal: repo.execution.signal,
          run(invocation) {
            gitTest(
              repo,
              "-c",
              "user.name=Test",
              "-c",
              "user.email=test@example.com",
              "commit",
              "--allow-empty",
              "-q",
              "-m",
              "made by git",
            );
            return run(invocation);
          },
        },
        { cwd: repo.dir },
      );

      if (result.kind !== "ran" || result.change.kind !== "read") throw new Error("unreachable");
      const operations = result.change.value.operations;
      expect(
        operations.filter((operation) => operation.description.startsWith("import git")),
      ).toMatchObject([{ isOwn: false }]);
      expect(
        operations.filter((operation) => operation.isOwn && !operation.isSnapshot),
      ).toMatchObject([{ description: expect.stringContaining("abandon commit") }]);
      expect(result.verdict.outcome).toBe("completed");
    },
    JjMutationTestTimeoutMs,
  );
});
