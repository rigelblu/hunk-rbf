import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionVcsMutationExecution,
  ExtensionVcsMutationRevisionRef,
} from "hunkdiff/extension";
import { createJjMutationCapability } from "./mutationRunner";

const jjTest = Bun.which("jj") ? test : test.skip;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
/** Create sibling A/B revisions with distinct files and a separate working copy under explicit test config. */
function createNativeSquashTestRepo(
  mode: "edit" | "abort" = "edit",
  sourceDescription = "A",
  destinationDescription = "B",
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunk-squash-native-")));
  roots.push(root);
  const config = join(root, "test.toml");
  const editor = join(root, "editor.cjs");
  const edited = join(root, "editor-called");
  writeFileSync(
    editor,
    `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(edited)}, 'called'); ${mode === "abort" ? "process.exit(1)" : "fs.writeFileSync(process.argv.at(-1), 'Chosen combined description\\n')"};`,
  );
  writeFileSync(
    config,
    '[user]\nname = "Test"\nemail = "test@example.com"\n[signing]\nbehavior = "drop"\n[revset-aliases]\n"immutable_heads()" = "present(frozen)"\n',
  );
  writeFileSync(config, "[ui]\neditor = " + JSON.stringify([process.execPath, editor]) + "\n", {
    flag: "a",
  });
  const env = {
    ...process.env,
    JJ_CONFIG: config,
    JJ_EDITOR: undefined,
    EDITOR: undefined,
    VISUAL: undefined,
  };
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
  jj("new", "-r", base.revisionId, "-m", sourceDescription);
  writeFileSync(join(dir, "a.txt"), "a\n");
  jj("status");
  const source = ref("@");
  jj("new", "-r", base.revisionId, "-m", destinationDescription);
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
    edited,
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

for (const mode of ["edit", "abort"] as const)
  jjTest(
    `native Squash ${mode} leaves final message to configured JJ editor`,
    async () => {
      const f = createNativeSquashTestRepo(mode);
      const before = f.jj(
        "--ignore-working-copy",
        "op",
        "log",
        "--no-graph",
        "-n",
        "1",
        "-T",
        "id",
      );
      const prepared = await f.capability.prepare(
        { kind: "squash", sources: [f.source], destination: f.destination },
        { cwd: f.dir },
      );
      expect(prepared.kind).toBe("ready");
      if (prepared.kind !== "ready") throw new Error(JSON.stringify(prepared));
      expect(existsSync(f.edited)).toBe(false);
      expect(prepared.prepared.isInteractive).toBe(true);
      expect(f.jj("--ignore-working-copy", "op", "log", "--no-graph", "-n", "1", "-T", "id")).toBe(
        before,
      );
      const result = await f.capability.apply(prepared.prepared.handleId, f.execution, {
        cwd: f.dir,
      });
      expect(existsSync(f.edited)).toBe(true);
      expect(f.commands).toHaveLength(1);
      expect(f.commands[0]!.some((arg) => arg.startsWith("--message"))).toBe(false);
      expect(result.kind).toBe("ran");
      if (result.kind !== "ran") throw new Error(JSON.stringify(result));
      expect(result.process.terminal).toBe("handed-over");
      expect(result.verdict.outcome).toBe(mode === "edit" ? "completed" : "failed");
      if (mode === "edit") {
        expect(
          f.jj(
            "--ignore-working-copy",
            "log",
            "--no-graph",
            "-r",
            `change_id(${f.destination.logicalId})`,
            "-T",
            "description",
          ),
        ).toBe("Chosen combined description\n");
        expect(result.verdict.warnings).toEqual([]);
      } else
        expect(
          f.jj("--ignore-working-copy", "op", "log", "--no-graph", "-n", "1", "-T", "id"),
        ).toBe(before);
    },
    60000,
  );
for (const pair of [
  ["", "B"],
  ["A", ""],
  ["", ""],
])
  jjTest(
    `native Squash descriptions ${JSON.stringify(pair)} follow JJ without an editor`,
    async () => {
      const f = createNativeSquashTestRepo("edit", pair[0], pair[1]);
      const prepared = await f.capability.prepare(
        { kind: "squash", sources: [f.source], destination: f.destination },
        { cwd: f.dir },
      );
      expect(prepared.kind).toBe("ready");
      if (prepared.kind !== "ready") throw new Error(JSON.stringify(prepared));
      const result = await f.capability.apply(prepared.prepared.handleId, f.execution, {
        cwd: f.dir,
      });
      expect(result).toMatchObject({ kind: "ran", verdict: { outcome: "completed" } });
      expect(existsSync(f.edited)).toBe(false);
    },
    60000,
  );
