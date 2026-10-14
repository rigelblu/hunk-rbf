import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionVcsMutationExecution,
  ExtensionVcsMutationRequest,
  ExtensionVcsMutationRevisionRef,
} from "hunkdiff/extension";
import { createJjMutationCapability } from "./mutationRunner";

const jjTest = Bun.which("jj") ? test : test.skip;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
/** Create sibling A/B revisions with distinct files and a separate working copy under explicit test config. */
function createNativeRebaseTestRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunk-rebase-native-")));
  roots.push(root);
  const config = join(root, "test.toml");
  writeFileSync(
    config,
    '[user]\nname = "Test"\nemail = "test@example.com"\n[signing]\nbehavior = "drop"\n[revset-aliases]\n"immutable_heads()" = "present(frozen)"\n',
  );
  const env = { ...process.env, JJ_CONFIG: config };
  const dir = join(root, "repo");
  const run = (cwd: string, args: string[]) => {
    const proc = Bun.spawnSync(["jj", "--no-pager", "--color", "never", ...args], {
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode) throw new Error(proc.stderr.toString());
    return proc.stdout.toString();
  };
  run(root, ["git", "init", dir]);
  const jj = (...args: string[]) => run(dir, args);
  const ref = (revset: string): ExtensionVcsMutationRevisionRef => {
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
  };
  writeFileSync(join(dir, "base.txt"), "base\n");
  jj("describe", "-m", "C");
  jj("status");
  const base = ref("@");
  jj("new", "-r", base.revisionId, "-m", "A");
  writeFileSync(join(dir, "a.txt"), "a\n");
  jj("status");
  const source = ref("@");
  jj("new", "-r", base.revisionId, "-m", "B");
  writeFileSync(join(dir, "b.txt"), "b\n");
  jj("status");
  const destination = ref("@");
  jj("new", "-r", base.revisionId, "-m", "W");
  const commands: string[][] = [];
  const execution: ExtensionVcsMutationExecution = {
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
        signal: proc.signalCode ?? null,
        wasInterrupted: false,
        terminal: invocation.terminal,
        terminalRestored: true,
        text: proc.stderr.toString() + proc.stdout.toString(),
      };
    },
  };
  return {
    dir,
    env,
    jj,
    ref,
    source,
    destination,
    base,
    execution,
    commands,
    capability: createJjMutationCapability({ env }),
  };
}

for (const placement of ["onto", "after", "before"] as const)
  jjTest(
    `native one-source Rebase ${placement} previews without moving then applies and reads exact placement`,
    async () => {
      const f = createNativeRebaseTestRepo();
      const observedOp = f.jj(
        "--ignore-working-copy",
        "op",
        "log",
        "--no-graph",
        "-n",
        "1",
        "-T",
        "id",
      );
      const request: ExtensionVcsMutationRequest = {
        kind: "rebase",
        sources: [f.source],
        destination: f.destination,
        placement,
        skipEmptied: false,
      };
      const preparation = await f.capability.prepare(request, { cwd: f.dir });
      expect(preparation.kind).toBe("ready");
      if (preparation.kind !== "ready") throw new Error(JSON.stringify(preparation));
      expect(f.jj("--ignore-working-copy", "op", "log", "--no-graph", "-n", "1", "-T", "id")).toBe(
        observedOp,
      );
      const result = await f.capability.apply(preparation.prepared.handleId, f.execution, {
        cwd: f.dir,
      });
      expect(result.kind).toBe("ran");
      if (result.kind !== "ran") throw new Error(JSON.stringify(result));
      expect(result.verdict.outcome).toBe("completed");
      expect(result.change.kind).toBe("read");
      expect(f.commands).toHaveLength(1);
      const target = placement === "before" ? f.destination.logicalId! : f.source.logicalId!;
      const parent = placement === "before" ? f.source.logicalId! : f.destination.logicalId!;
      expect(
        f.jj(
          "--ignore-working-copy",
          "log",
          "--no-graph",
          "-r",
          `parents(${target})`,
          "-T",
          "change_id",
        ),
      ).toContain(parent);
      await f.capability.dispose(preparation.prepared.handleId);
    },
    60_000,
  );
jjTest(
  "native Rebase respects immutable destination placement and refuses protected source",
  async () => {
    const f = createNativeRebaseTestRepo();
    f.jj("bookmark", "create", "frozen", "-r", f.destination.revisionId);
    const request: ExtensionVcsMutationRequest = {
      kind: "rebase",
      sources: [f.source],
      destination: f.destination,
      placement: "onto",
      skipEmptied: false,
    };
    const onto = await f.capability.prepare(request, { cwd: f.dir });
    expect(onto.kind).toBe("ready");
    if (onto.kind === "ready") await f.capability.dispose(onto.prepared.handleId);
    const before = await f.capability.prepare({ ...request, placement: "before" }, { cwd: f.dir });
    expect(before.kind).toBe("refused");
    if (before.kind === "refused") expect(before.providerText).toContain("immutable");
    const protectedSource = await f.capability.prepare(
      { ...request, sources: [f.destination], destination: f.source },
      { cwd: f.dir },
    );
    expect(protectedSource.kind).toBe("refused");
  },
  60_000,
);
jjTest(
  "native already-positioned Rebase is a refusal with no Apply",
  async () => {
    const f = createNativeRebaseTestRepo();
    const preparation = await f.capability.prepare(
      {
        kind: "rebase",
        sources: [f.source],
        destination: f.base,
        placement: "onto",
        skipEmptied: false,
      },
      { cwd: f.dir },
    );
    expect(preparation.kind).toBe("refused");
    expect(f.commands).toHaveLength(0);
  },
  60_000,
);

/** Apply one native fixture request and retain both the preview and actual verdict. */
async function runNativeRebaseTest(
  f: ReturnType<typeof createNativeRebaseTestRepo>,
  placement: "onto" | "before" | "after" = "onto",
  skipEmptied = false,
) {
  const preparation = await f.capability.prepare(
    { kind: "rebase", sources: [f.source], destination: f.destination, placement, skipEmptied },
    { cwd: f.dir },
  );
  if (preparation.kind !== "ready") throw new Error(JSON.stringify(preparation));
  const result = await f.capability.apply(preparation.prepared.handleId, f.execution, {
    cwd: f.dir,
  });
  if (result.kind !== "ran") throw new Error(JSON.stringify(result));
  expect(result.verdict.outcome).toBe("completed");
  return { prepared: preparation.prepared, result };
}
for (const skipEmptied of [false, true])
  jjTest(
    `native newly empty source ${skipEmptied ? "leaves" : "stays"} only as previewed`,
    async () => {
      const f = createNativeRebaseTestRepo();
      f.jj("edit", "-r", f.destination.revisionId);
      writeFileSync(join(f.dir, "a.txt"), "a\n");
      f.jj("status");
      f.destination = f.ref("@");
      f.jj("new", "-r", f.base.revisionId, "-m", "W");
      const { prepared, result } = await runNativeRebaseTest(f, "onto", skipEmptied);
      if (skipEmptied) {
        expect(
          prepared.projection.warnings.some((line) => line.includes("will leave history")),
        ).toBe(true);
        expect(result.verdict.headline).toContain("left history as previewed");
        expect(result.verdict.selectAfter?.logicalId).toBe(f.destination.logicalId);
      } else {
        expect(prepared.projection.notes.some((line) => line.includes("will become empty"))).toBe(
          true,
        );
        expect(result.verdict.notes.some((line) => line.includes("became empty"))).toBe(true);
        expect(result.verdict.selectAfter?.logicalId).toBe(f.source.logicalId);
      }
    },
    60_000,
  );
for (const placement of ["before", "after"] as const)
  jjTest(
    `native skipped source ${placement} selects the specified surviving endpoint`,
    async () => {
      const f = createNativeRebaseTestRepo();
      f.jj("new", "-r", f.base.revisionId, "-m", "P");
      writeFileSync(join(f.dir, "a.txt"), "a\n");
      f.jj("status");
      const parent = f.ref("@");
      f.jj("rebase", "-r", f.destination.revisionId, "-o", parent.revisionId);
      f.destination = f.ref(f.destination.logicalId!);
      f.jj("new", "-r", f.base.revisionId, "-m", "W");
      const { result } = await runNativeRebaseTest(f, placement, true);
      expect(result.verdict.headline).toContain("left history as previewed");
      expect(result.verdict.selectAfter?.logicalId).toBe(
        placement === "before" ? parent.logicalId : f.destination.logicalId,
      );
    },
    60_000,
  );
jjTest(
  "native divergent empty source and nonempty sibling expose the exact retained-empty consequence",
  async () => {
    const f = createNativeRebaseTestRepo();
    f.jj("edit", "-r", f.destination.revisionId);
    writeFileSync(join(f.dir, "a.txt"), "a\n");
    f.jj("status");
    f.destination = f.ref("@");
    f.jj("edit", "-r", f.source.revisionId);
    const earlier = f
      .jj("--ignore-working-copy", "op", "log", "--no-graph", "-n", "1", "-T", "id")
      .trim();
    f.jj("describe", "-m", "A second version");
    f.jj(
      "--ignore-working-copy",
      "--at-op",
      earlier,
      "describe",
      "-r",
      `commit_id(${f.source.revisionId})`,
      "-m",
      "A first version",
    );
    f.jj("status");
    f.source = f.ref('description(substring:"first version")');
    f.jj("new", "-r", f.base.revisionId, "-m", "W");
    const { prepared, result } = await runNativeRebaseTest(f);
    expect(
      prepared.projection.notes.some(
        (line) => line.includes("A first version") && line.includes("empty"),
      ),
    ).toBe(true);
    expect(
      result.verdict.notes.some(
        (line) => line.includes("A first version") && line.includes("empty"),
      ),
    ).toBe(true);
  },
  60_000,
);
jjTest(
  "native new source conflict is not masked by an already-conflicted divergent sibling",
  async () => {
    const f = createNativeRebaseTestRepo();
    f.jj("edit", "-r", f.destination.revisionId);
    writeFileSync(join(f.dir, "a.txt"), "b\n");
    f.jj("status");
    f.destination = f.ref("@");
    f.jj("new", "-r", f.base.revisionId, "-m", "W");
    const earlier = f
      .jj("--ignore-working-copy", "op", "log", "--no-graph", "-n", "1", "-T", "id")
      .trim();
    f.jj("rebase", "-r", f.source.revisionId, "-o", f.destination.revisionId);
    f.jj("describe", "-r", f.source.logicalId!, "-m", "A second version");
    f.jj(
      "--ignore-working-copy",
      "--at-op",
      earlier,
      "describe",
      "-r",
      `commit_id(${f.source.revisionId})`,
      "-m",
      "A first version",
    );
    f.jj("status");
    f.source = f.ref('description(substring:"first version")');
    const { prepared, result } = await runNativeRebaseTest(f);
    expect(
      prepared.projection.warnings.some(
        (line) => line.includes("A first version") && line.includes("conflicts"),
      ),
    ).toBe(true);
    expect(
      result.verdict.warnings.some(
        (line) => line.includes("A first version") && line.includes("conflicts"),
      ),
    ).toBe(true);
  },
  60_000,
);
jjTest(
  "native one divergent version onto its other version may leave with the toggle off",
  async () => {
    const f = createNativeRebaseTestRepo();
    f.jj("edit", "-r", f.source.revisionId);
    const earlier = f
      .jj("--ignore-working-copy", "op", "log", "--no-graph", "-n", "1", "-T", "id")
      .trim();
    f.jj("describe", "-m", "A second version");
    f.jj(
      "--ignore-working-copy",
      "--at-op",
      earlier,
      "describe",
      "-r",
      `commit_id(${f.source.revisionId})`,
      "-m",
      "A first version",
    );
    f.jj("status");
    f.source = f.ref('description(substring:"first version")');
    f.destination = f.ref('description(substring:"second version")');
    f.jj("new", "-r", f.base.revisionId, "-m", "W");
    const { prepared, result } = await runNativeRebaseTest(f);
    expect(prepared.request.kind === "rebase" && prepared.request.skipEmptied).toBe(false);
    expect(result.verdict.headline).toContain("left history as previewed");
  },
  60_000,
);

for (const effect of ["conflicted", "empty"] as const)
  jjTest(
    `native multiple rewritten divergent descendants expose resulting ${effect} versions`,
    async () => {
      const f = createNativeRebaseTestRepo();
      f.jj("new", "-r", f.source.revisionId, "-m", "D");
      if (effect === "empty") rmSync(join(f.dir, "a.txt"));
      else writeFileSync(join(f.dir, "a.txt"), "d\n");
      f.jj("status");
      const child = f.ref("@");
      const earlier = f
        .jj("--ignore-working-copy", "op", "log", "--no-graph", "-n", "1", "-T", "id")
        .trim();
      f.jj("describe", "-m", "D second version");
      f.jj(
        "--ignore-working-copy",
        "--at-op",
        earlier,
        "describe",
        "-r",
        `commit_id(${child.revisionId})`,
        "-m",
        "D first version",
      );
      f.jj("status");
      f.jj("new", "-r", f.base.revisionId, "-m", "W");
      const { prepared, result } = await runNativeRebaseTest(f);
      const previewWords =
        effect === "conflicted" ? prepared.projection.warnings : prepared.projection.notes;
      const actualWords = effect === "conflicted" ? result.verdict.warnings : result.verdict.notes;
      expect(
        previewWords.some(
          (line) =>
            line.includes("2 resulting versions") &&
            line.includes(effect === "conflicted" ? "conflicts" : "empty"),
        ),
      ).toBe(true);
      expect(
        actualWords.some(
          (line) =>
            line.includes("2 resulting versions") &&
            line.includes(effect === "conflicted" ? "conflicts" : "empty"),
        ),
      ).toBe(true);
    },
    60_000,
  );
