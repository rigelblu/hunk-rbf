import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Session } from "tuistory";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();
const roots: string[] = [];
const jjTest = Bun.which("jj") ? test : test.skip;
setDefaultTimeout(60_000);
afterEach(async () => {
  await harness.cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Create real sibling revisions and a separate working copy with deterministic test configuration. */
function createOperationPtyTestRepo(recoveryCount = 0) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunk-operation-pty-")));
  roots.push(root);
  const config = join(root, "jj.toml");
  writeFileSync(
    config,
    '[user]\nname = "Operation Tester"\nemail = "operation@example.com"\n[signing]\nbehavior = "drop"\n[revset-aliases]\n"immutable_heads()" = "none()"\n',
  );
  const env = { JJ_CONFIG: config };
  const cwd = join(root, "repo");
  const run = (dir: string, args: string[]) => {
    const result = Bun.spawnSync(["jj", "--no-pager", "--color", "never", ...args], {
      cwd: dir,
      env: { ...process.env, ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode) throw new Error(result.stderr.toString());
    return result.stdout.toString();
  };
  run(root, ["git", "init", cwd]);
  const jj = (...args: string[]) => run(cwd, args);
  const identity = (revset: string) =>
    jj(
      "--ignore-working-copy",
      "log",
      "--no-graph",
      "-r",
      revset,
      "-T",
      'commit_id ++ " " ++ change_id',
    )
      .trim()
      .split(" ") as [string, string];
  writeFileSync(join(cwd, "base.ts"), "export const base = true;\n");
  jj("describe", "-m", "C base");
  jj("status");
  const [base] = identity("@");
  jj("new", "-r", base, "-m", "A source");
  writeFileSync(join(cwd, "a.ts"), "export const source = true;\n");
  jj("status");
  const source = identity("@");
  jj("new", "-r", base, "-m", "B destination");
  writeFileSync(join(cwd, "b.ts"), "export const destination = true;\n");
  jj("status");
  const destination = identity("@");
  jj("new", "-r", base, "-m", "W current");
  const recovery: string[] = [];
  for (let i = 0; i < recoveryCount; i++) {
    jj("new", "-m", `Recovery ${i}`);
    writeFileSync(join(cwd, `recovery-${i}.ts`), `export const value${i} = ${i};\n`);
    jj("status");
    recovery.push(identity("@")[0]);
  }
  return { cwd, env, jj, source, destination, recovery };
}
/** Read terminal row coordinates from actual cells, stripping Tuistory's presentation newline. */
async function clickOperationTestCell(session: Session, subject: string, x: number, button = 0) {
  const text = (await session.text({ immediate: true })).replace(/^\n/, "");
  const y = text.split("\n").findIndex((line) => line.includes(subject));
  if (y < 0) throw new Error(`Missing ${subject}:\n${text}`);
  session.writeRaw(`\x1b[<${button};${x + 1};${y + 1}M\x1b[<${button};${x + 1};${y + 1}m`);
  await session.waitIdle();
}
/** Launch the production CLI and provider, without any operation test harness. */
async function launchOperationPtyTest(
  f: ReturnType<typeof createOperationPtyTestRepo>,
  cols = 80,
  rows = 24,
) {
  const session = await harness.launchHunk({
    args: ["log", "--vcs", "jj", "--all", "--color", "never", "--no-extensions"],
    cwd: f.cwd,
    env: f.env,
    cols,
    rows,
  });
  await session.waitForText(
    f.recovery.length ? new RegExp(`Recovery ${f.recovery.length - 1}`) : /A source/,
    { timeout: 15_000 },
  );
  return session;
}
/** Choose a real source then enter its operation-local selection mode. */
async function beginOperationPtyTest(session: Session, kind: "squash" | "rebase") {
  await session.click("A source");
  session.writeRaw(kind === "squash" ? "S" : "R");
  await session.waitForText(new RegExp(`Choose ${kind} sources`), { timeout: 10_000 });
}

describe("real operation selection PTY", () => {
  for (const cols of [80, 120])
    jjTest(
      `Space/checkmark input and I inspection retain exact selection at ${cols} columns`,
      async () => {
        const f = createOperationPtyTestRepo();
        const session = await launchOperationPtyTest(f, cols);
        try {
          await beginOperationPtyTest(session, "squash");
          await session.press("space");
          let text = await session.waitForText(/0 selected/);
          expect(text).not.toContain("Enter Continue");
          await session.press("enter");
          expect(await session.text()).toContain("Choose squash sources");
          await session.press("space");
          await session.waitForText(/1 selected/);
          await session.click("C base");
          await session.press("space");
          await session.waitForText(/2 selected/);
          await clickOperationTestCell(session, "B destination", 3, 2);
          expect(await session.text()).toContain("2 selected");
          await clickOperationTestCell(session, "B destination", 3);
          await session.waitForText(/3 selected/);
          await clickOperationTestCell(session, "B destination", 3);
          await session.waitForText(/2 selected/);
          text = await session.text();
          expect(text.split("\n").find((line) => line.includes("C base"))).toMatch(/>.*✓/);
          await session.click("B destination");
          session.writeRaw("I");
          await session.waitForText(/export const destination = true/, { timeout: 15_000 });
          expect(await session.text()).not.toContain("Choose squash sources");
          await session.press("q");
          text = await session.waitForText(/Choose squash sources/, { timeout: 15_000 });
          expect(text).toContain("2 selected");
          expect(text.split("\n").find((line) => line.includes("B destination"))).toMatch(/>/);
          await session.press("escape");
          text = await harness.waitForSnapshot(
            session,
            (text) => !text.includes("Choose squash sources") && text.includes("Jujutsu history"),
            10_000,
          );
          expect(text).not.toContain("✓");
        } finally {
          session.close();
        }
      },
    );
  jjTest(
    "real Squash confirmation Cancel is safe, Apply runs once, and actual result stays reopenable",
    async () => {
      const f = createOperationPtyTestRepo();
      const session = await launchOperationPtyTest(f, 120);
      try {
        await beginOperationPtyTest(session, "squash");
        await session.press("enter");
        await session.waitForText(/Choose squash destination/);
        await session.click("B destination");
        await session.press("enter");
        let text = await session.waitForText(/Confirm squash/, { timeout: 15_000 });
        expect(text).toContain("[Cancel]");
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
        await session.press("enter");
        await session.waitForText(/Choose squash destination/);
        expect(
          f.jj("--ignore-working-copy", "op", "log", "--no-graph", "-n", "1", "-T", "id"),
        ).toBe(before);
        await session.press("enter");
        await session.waitForText(/Confirm squash/);
        await session.press("tab");
        await session.press("enter");
        text = await session.waitForText(/Squashed /, { timeout: 20_000 });
        expect(text).toContain("Operation result");
        expect(text).not.toContain("✓");
        await session.waitForText(/Scroll/);
        await session.press("end");
        expect(await session.text()).toContain("jj op revert");
        await session.press("up");
        expect(await session.text()).toContain("Scroll");
        expect(
          f
            .jj(
              "--ignore-working-copy",
              "log",
              "--no-graph",
              "-r",
              `all() & change_id(${f.source[1]})`,
              "-T",
              "commit_id",
            )
            .trim(),
        ).toBe("");
        expect(
          f.jj("--ignore-working-copy", "file", "list", "-r", `change_id(${f.destination[1]})`),
        ).toContain("a.ts");
        expect(
          f.jj("--ignore-working-copy", "file", "list", "-r", `change_id(${f.destination[1]})`),
        ).toContain("b.ts");
        await session.press("escape");
        await session.waitForText(/Jujutsu history/);
        await session.press("f10");
        await session.click("Operation result…");
        await session.waitForText(/Squashed /);
        expect(await session.text()).toContain("Operation result");
      } finally {
        session.close();
      }
    },
  );
  jjTest(
    "real Rebase After, Details and empty toggle share one preparation/Apply/readback flow",
    async () => {
      const f = createOperationPtyTestRepo();
      const session = await launchOperationPtyTest(f, 80);
      try {
        await beginOperationPtyTest(session, "rebase");
        await session.press("enter");
        await session.waitForText(/Choose rebase destination/);
        await session.click("B destination");
        session.writeRaw("A");
        await session.waitForText(/\[After\]/);
        await session.press("enter");
        await session.waitForText(/Confirm rebase/, { timeout: 15_000 });
        await session.waitForText(/abandon if empty: off/);
        expect(await session.text()).toContain("Scroll");
        await session.press("end");
        expect(await session.text()).toContain("Other tools can still");
        await session.press("home");
        session.writeRaw("s");
        await session.waitForText(/abandon if empty: on/, { timeout: 15_000 });
        await session.click("Details");
        await session.waitForText(/Action details/);
        await session.press("end");
        await session.waitIdle();
        expect(await session.text()).toContain("Provider preview");
        await session.press("enter");
        await session.waitForText(/Confirm rebase/);
        await session.click("Apply");
        const result = await session.waitForText(/Moved /, { timeout: 20_000 });
        expect(result).toContain("Operation result");
        expect(result).not.toContain("✓");
        expect(
          f.jj(
            "--ignore-working-copy",
            "log",
            "--no-graph",
            "-r",
            `parents(change_id(${f.source[1]}))`,
            "-T",
            "change_id",
          ),
        ).toContain(f.destination[1]);
      } finally {
        session.close();
      }
    },
  );
  jjTest(
    "narrow/short resize keeps destination Cancel and blocks hidden confirmation Apply",
    async () => {
      const f = createOperationPtyTestRepo();
      const session = await launchOperationPtyTest(f);
      try {
        await beginOperationPtyTest(session, "rebase");
        await session.press("enter");
        session.resize({ cols: 28, rows: 12 });
        let text = await session.waitForText(/Esc Cancel/);
        expect(text).toContain("Source:");
        session.resize({ cols: 80, rows: 24 });
        await session.click("B destination");
        await session.press("enter");
        await session.waitForText(/Confirm rebase/, { timeout: 15_000 });
        const operation = f.jj(
          "--ignore-working-copy",
          "op",
          "log",
          "--no-graph",
          "-n",
          "1",
          "-T",
          "id",
        );
        session.resize({ cols: 28, rows: 10 });
        await session.waitForText(/Terminal is too/);
        expect(await session.text()).toContain("Resize");
        await session.press("tab");
        await session.press("enter");
        await session.waitIdle();
        expect(
          f.jj("--ignore-working-copy", "op", "log", "--no-graph", "-n", "1", "-T", "id"),
        ).toBe(operation);
      } finally {
        session.close();
      }
    },
  );
  jjTest(
    "explicit source-phase refresh retains missing intent and recovery copies original IDs",
    async () => {
      const f = createOperationPtyTestRepo(12);
      const session = await launchOperationPtyTest(f, 80, 18);
      try {
        await session.click("Recovery 11");
        session.writeRaw("S");
        await session.waitForText(/1 selected/);
        for (let i = 0; i < 11; i++) {
          await session.press("down");
          await session.press("space");
        }
        await session.waitForText(/12 selected/);
        f.jj("abandon", "-r", 'description(glob:"Recovery *")');
        await session.press("r");
        let text = await session.waitForText(/Resolve your marks/, { timeout: 15_000 });
        expect(text).toContain("12 selected");
        expect(text).not.toContain("Enter Continue");
        await session.press("r");
        await session.waitForText(/Review marks/);
        await session.press("pagedown");
        await session.press("y");
        expect(session.getRawOutput()).toContain(Buffer.from(f.recovery[8]!).toString("base64"));
        await session.press("end");
        await session.waitIdle();
        text = await session.text();
        expect(text).toContain("Recovery");
        await session.press("r");
        text = await session.waitForText(/0 selected/);
        expect(text).toContain("Choose squash sources");
      } finally {
        session.close();
      }
    },
  );
});
