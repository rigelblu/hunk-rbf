import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHistoryBootstrap } from "../../packages/hunk/src/app/historyBootstrap";
import { getBundledVcsCatalog } from "../../packages/hunk/src/app/vcsCatalog";
import { LogController } from "../../packages/hunk/src/ui/log/controller";

/** Run fixture commands and preserve a failed command's diagnostic. */
function runTestCommand(cwd: string, args: string[], stdin?: string) {
  const result = Bun.spawnSync(args, {
    cwd,
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

const jjTest = Bun.which("jj") && Bun.which("git") ? test : test.skip;

jjTest(
  "failed replacement preserves every page of a production JJ cursor",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "hunk-refresh-jj-"));
    const configHome = mkdtempSync(join(tmpdir(), "hunk-refresh-config-"));
    let controller: LogController | undefined;
    let shutdown: (() => Promise<void>) | undefined;
    try {
      runTestCommand(cwd, ["git", "init", "-q"]);
      runTestCommand(cwd, ["git", "symbolic-ref", "HEAD", "refs/heads/main"]);
      let stream = "";
      for (let i = 1; i <= 300; i++) {
        const subject = `History ${i}`;
        stream += `commit refs/heads/main\nmark :${i}\nauthor Test <history@example.com> ${1700000000 + i} +0000\ncommitter Test <history@example.com> ${1700000000 + i} +0000\ndata ${subject.length}\n${subject}\n${i > 1 ? `from :${i - 1}\n` : ""}\n`;
      }
      runTestCommand(cwd, ["git", "fast-import", "--quiet"], stream);
      runTestCommand(cwd, ["jj", "git", "init", "--colocate"]);
      const expectedIds = runTestCommand(cwd, [
        "jj",
        "--ignore-working-copy",
        "log",
        "--no-graph",
        "--revisions",
        "all() ~ root()",
        "--template",
        'commit_id ++ "\\n"',
      ])
        .trim()
        .split("\n");
      const runtime = await loadHistoryBootstrap({
        input: {
          kind: "history",
          color: "never",
          format: "compact",
          ascii: false,
          static: false,
          vcs: "jj",
          all: true,
          extensionsEnabled: false,
          extensionPaths: [],
        },
        cwd,
        env: { ...process.env, XDG_CONFIG_HOME: configHome },
        baseVcsCatalog: getBundledVcsCatalog(),
      });
      shutdown = () => runtime.extensionSession.shutdown();
      controller = new LogController(runtime);
      expect(await controller.loadMore()).toBeTrue();
      expect(controller.getSnapshot().rows.length).toBe(256);
      expect(controller.getSnapshot().historyDone).toBeFalse();
      const continuation = controller.loadMore();
      runtime.reopenSource = async () => {
        throw new Error("injected replacement-open failure");
      };
      expect(await controller.refresh()).toBeFalse();
      expect(await continuation).toBeTrue();
      while (!controller.getSnapshot().historyDone) expect(await controller.loadMore()).toBeTrue();
      const ids = controller.getSnapshot().rows.map((r) => r.commit.revisionId);
      expect(ids.length).toBeGreaterThan(256);
      expect(new Set(ids)).toEqual(new Set(expectedIds));
      expect(ids.length).toBe(expectedIds.length);
    } finally {
      await controller?.close();
      await shutdown?.();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(configHome, { recursive: true, force: true });
    }
  },
  20_000,
);

jjTest(
  "production JJ marks preserve A/C across B review, rewrites, and explicit unresolved removal",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "hunk-marked-jj-"));
    const configHome = mkdtempSync(join(tmpdir(), "hunk-marks-config-"));
    let controller: LogController | undefined;
    let shutdown: (() => Promise<void>) | undefined;
    try {
      runTestCommand(cwd, ["jj", "git", "init"]);
      for (const subject of ["C", "B", "A"]) {
        if (subject !== "C") runTestCommand(cwd, ["jj", "new"]);
        await Bun.write(join(cwd, "sample.txt"), `${subject}\n`);
        runTestCommand(cwd, ["jj", "describe", "-m", subject]);
      }
      const runtime = await loadHistoryBootstrap({
        input: {
          kind: "history",
          color: "never",
          format: "compact",
          ascii: false,
          static: false,
          vcs: "jj",
          extensionsEnabled: false,
          extensionPaths: [],
        },
        cwd,
        env: { ...process.env, XDG_CONFIG_HOME: configHome },
        baseVcsCatalog: getBundledVcsCatalog(),
      });
      shutdown = () => runtime.extensionSession.shutdown();
      controller = new LogController(runtime);
      await controller.loadMore();
      const index = (subject: string) =>
        controller!.getSnapshot().rows.findIndex((row) => row.commit.subject === subject);
      const a = index("A"),
        b = index("B"),
        c = index("C");
      expect([a, b, c]).toEqual([0, 1, 2]);
      const originalC = controller.getSnapshot().rows[c]!.commit.revisionId;
      const originalA = controller.getSnapshot().rows[a]!.commit.revisionId;
      controller.toggleMark(a);
      controller.toggleMark(c);
      await controller.select(b, 20);
      expect(controller.getSelectedRows().map((row) => row.commit.subject)).toEqual(["B"]);
      expect(await runtime.planReview(controller.getSelectedRow()!.commit)).toMatchObject({
        kind: "revision-show",
        revisionId: controller.getSelectedRow()!.commit.revisionId,
      });
      expect(controller.getOperationTargets()).toMatchObject({
        revisionIds: [originalA, originalC],
      });
      await controller.select(a, 20);
      await controller.select(c, 20, { extend: true });
      expect(controller.getSelectedRows().map((row) => row.commit.subject)).toEqual([
        "A",
        "B",
        "C",
      ]);
      runTestCommand(cwd, ["jj", "abandon", "-r", originalC]);
      expect(await controller.refresh()).toBeTrue();
      const replacementA = controller.getSnapshot().rows[index("A")]!.commit.revisionId;
      expect(replacementA).not.toBe(originalA);
      expect(controller.getSnapshot().marks).toMatchObject([
        { kind: "resolved", revisionId: replacementA },
        { kind: "unresolved", reason: "missing", mark: { revisionId: originalC, subject: "C" } },
      ]);
      expect(controller.getOperationTargets()).toMatchObject({
        kind: "blocked",
        reason: "unresolved",
      });
      controller.removeUnresolvedMarks();
      expect(controller.getOperationTargets()).toMatchObject({
        kind: "ready",
        revisionIds: [replacementA],
      });
    } finally {
      await controller?.close();
      await shutdown?.();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(configHome, { recursive: true, force: true });
    }
  },
  20_000,
);
