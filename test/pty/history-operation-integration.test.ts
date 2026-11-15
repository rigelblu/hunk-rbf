import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import type { Session } from "tuistory";
import { expectGroupedTimelineTestColumn } from "../helpers/historyTimeline";
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
function createOperationPtyTestRepo(recoveryCount = 0, withEditor: boolean | "nvim" = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunk-operation-pty-")));
  roots.push(root);
  const config = join(root, "jj.toml");
  writeFileSync(
    config,
    '[user]\nname = "Operation Tester"\nemail = "operation@example.com"\n[signing]\nbehavior = "drop"\n[revset-aliases]\n"immutable_heads()" = "none()"\n',
  );
  const editorPid = join(root, "editor-pid");
  const editor = join(root, "editor.cjs");
  if (withEditor) {
    writeFileSync(
      editor,
      `const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(editorPid)}, String(process.pid));
      const tty = fs.openSync('/dev/tty','r+'); fs.closeSync(tty);
      process.stdout.write('\\x1b[?1049h\\x1b[2J\\x1b[HHK27_EDITOR_READY '+process.stdout.columns+'x'+process.stdout.rows+'\\r\\n');
      process.stdin.setRawMode(true);
      process.on('SIGWINCH', () => process.stdout.write('HK27_EDITOR_RESIZE '+process.stdout.columns+'x'+process.stdout.rows+'\\r\\n'));
      // Read one byte so burst input also exercises the host's post-editor typeahead boundary.
      const key=Buffer.alloc(1); fs.read(0,key,0,1,null, () => {
      process.stdin.setRawMode(false); process.stdout.write('\\x1b[?1049l');
      if(key[0]===120 || key[0]===3) { process.stderr.write('HK27_EDITOR_ABORTED\\n'); process.exit(1); }
      fs.writeFileSync(process.argv.at(-1),'PTY chosen description\\n'); process.exit(0); });`,
    );
    writeFileSync(
      config,
      "[ui]\neditor = " +
        JSON.stringify(
          withEditor === "nvim"
            ? [Bun.which("nvim")!, "--clean", "-i", "NONE"]
            : [process.execPath, editor],
        ) +
        "\n",
      { flag: "a" },
    );
  }
  const env = { JJ_CONFIG: config, JJ_EDITOR: undefined, EDITOR: undefined, VISUAL: undefined };
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
  return { cwd, env, jj, source, destination, recovery, editorPid };
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
  await session.waitForText(kind === "squash" ? / From / : /Choose rebase sources/, {
    timeout: 10_000,
  });
}

describe("real operation selection PTY", () => {
  for (const cols of [80, 120])
    jjTest(
      `Space/checkmark input and I inspection retain exact selection at ${cols} columns`,
      async () => {
        const f = createOperationPtyTestRepo();
        const session = await launchOperationPtyTest(f, cols);
        try {
          await beginOperationPtyTest(session, "rebase");
          expectGroupedTimelineTestColumn(await session.text(), ["A source", "C base"], 7);
          await session.press("space");
          let text = await session.waitForText(/0 selected/);
          expect(text).not.toContain("Enter Continue");
          await session.press("enter");
          expect(await session.text()).toContain("Choose rebase sources");
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
          expect(await session.text()).not.toContain("Choose rebase sources");
          await session.press("q");
          text = await session.waitForText(/Choose rebase sources/, { timeout: 15_000 });
          expect(text).toContain("2 selected");
          expect(text.split("\n").find((line) => line.includes("B destination"))).toMatch(/>/);
          await session.press("escape");
          text = await harness.waitForSnapshot(
            session,
            (text) => !text.includes("Choose rebase sources") && text.includes("Jujutsu history"),
            10_000,
          );
          expect(text).not.toContain("✓");
          expectGroupedTimelineTestColumn(text, ["A source", "C base"], 3);
        } finally {
          session.close();
        }
      },
    );
  jjTest(
    "real Squash keeps From/Into in graph, opens configured editor once and retains the edited result",
    async () => {
      const f = createOperationPtyTestRepo(0, true);
      const session = await launchOperationPtyTest(f, 120);
      try {
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
        await beginOperationPtyTest(session, "squash");
        await session.press("enter");
        await session.waitForText(/ From /);
        await session.click("B destination");
        let text = await session.waitForText(/Enter Squash/, { timeout: 15_000 });
        expect(text).not.toContain("Into:");
        expect(text).toMatch(/ From +A source/);
        expect(text).toMatch(/ Into +B destination/);
        expect(text).not.toContain("Source is removed.");
        expect(text).not.toContain("Confirm squash");
        expect(text).not.toContain("Apply");
        await session.press("d");
        expect(await session.text()).not.toContain("Action details");
        await session.press("tab");
        expect(await session.text()).not.toContain("Details");
        await session.waitForText(/Enter Squash/);
        expect(
          f.jj("--ignore-working-copy", "op", "log", "--no-graph", "-n", "1", "-T", "id"),
        ).toBe(before);
        await session.press("enter");
        await session.waitForText(/HK27_EDITOR_READY 120x24/, { timeout: 15_000 });
        session.resize({ cols: 80, rows: 24 });
        await session.waitForText(/HK27_EDITOR_RESIZE 80x24/);
        session.writeRaw("e\r\r");
        text = await session.waitForText(/1 revision was squashed\./, { timeout: 20_000 });
        expect(text).not.toContain("✓");
        expect(text).not.toContain("[from]");
        expect(text).not.toContain("[into]");
        expect(text).not.toContain(" From ");
        expect(text).not.toContain(" Into ");
        expect(text).not.toContain("Confirm squash");
        expect(session.isDead).toBe(false);
        expect(
          f.jj(
            "--ignore-working-copy",
            "log",
            "--no-graph",
            "-r",
            `change_id(${f.destination[1]})`,
            "-T",
            "description",
          ),
        ).toBe("PTY chosen description\n");
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
        const files = f.jj(
          "--ignore-working-copy",
          "file",
          "list",
          "-r",
          `change_id(${f.destination[1]})`,
        );
        expect(files).toContain("a.ts");
        expect(files).toContain("b.ts");
        expect(await session.text()).toContain("Esc Dismiss");
        expect(await session.text()).not.toContain("jj op revert");
        await session.press("f10");
        await session.click("Operation result…");
        await session.waitForText(/Operation result/);
        for (let i = 0; i < 20 && !(await session.text()).includes("jj op revert"); i++)
          await session.press("pagedown");
        expect(await session.text()).toContain("jj op revert");
        expect(await session.text()).not.toContain("Details");
        expect(await session.text()).not.toContain("Error output");
        await session.press("escape");
        await session.waitForText(/Jujutsu history/);
        await session.press("f10");
        await session.click("Operation result…");
        expect(await session.waitForText(/Squashed /)).not.toContain("Confirm squash");
      } finally {
        session.close();
      }
    },
  );
  for (const key of ["x", ["ctrl", "c"]] as const)
    jjTest(
      `real editor failure via ${JSON.stringify(key)} keeps output visible and preserves repository`,
      async () => {
        const f = createOperationPtyTestRepo(0, true);
        const session = await launchOperationPtyTest(f);
        try {
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
          await beginOperationPtyTest(session, "squash");
          await session.press("enter");
          await session.waitForText(/ From /);
          await session.click("B destination");
          await session.waitForText(/Enter Squash/, { timeout: 15_000 });
          await session.press("enter");
          await session.waitForText(/HK27_EDITOR_READY/, { timeout: 15_000 });
          await session.press(typeof key === "string" ? key : [...key]);
          let text = await session.waitForText(/Press any key to return to Hunk/, {
            timeout: 15_000,
          });
          expect(text).toContain("HK27_EDITOR_ABORTED");
          expect(text).not.toContain("Enter Squash");
          expect(
            f.jj("--ignore-working-copy", "op", "log", "--no-graph", "-n", "1", "-T", "id"),
          ).toBe(before);
          await session.press("space");
          text = await session.waitForText(/JJ did not squash /, { timeout: 15_000 });
          expect(text).not.toContain("Squashed ");
          expect(session.isDead).toBe(false);
          expect(text).toContain("Error output");
          await session.press("o");
          await session.waitForText(/Squash error output/);
          await session.press("escape");
          expect(await session.waitForText(/JJ did not squash /)).toContain("Error output");
        } finally {
          session.close();
        }
      },
    );
  for (const signal of ["SIGTERM", "SIGHUP"] as const)
    jjTest(`host ${signal} waits for the editor group without committing a squash`, async () => {
      const f = createOperationPtyTestRepo(0, true);
      const session = await launchOperationPtyTest(f);
      try {
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
        await beginOperationPtyTest(session, "squash");
        await session.press("enter");
        await session.waitForText(/ From /);
        await session.click("B destination");
        await session.waitForText(/Enter Squash/, { timeout: 15_000 });
        await session.press("enter");
        await session.waitForText(/HK27_EDITOR_READY/, { timeout: 15_000 });
        const pid = Number(readFileSync(f.editorPid, "utf8"));
        if (signal === "SIGTERM") session.killProcess();
        else {
          const jjPid = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)], { stdout: "pipe" })
            .stdout.toString()
            .trim();
          const hostPid = Number(
            Bun.spawnSync(["ps", "-o", "ppid=", "-p", jjPid], { stdout: "pipe" })
              .stdout.toString()
              .trim(),
          );
          if (hostPid <= 1) throw new Error("Missing owned Hunk host PID.");
          process.kill(hostPid, signal);
        }
        expect(await session.waitForExit(10_000)).toBe(true);
        expect(() => process.kill(pid, 0)).toThrow();
        expect(
          f.jj("--ignore-working-copy", "op", "log", "--no-graph", "-n", "1", "-T", "id"),
        ).toBe(before);
      } finally {
        session.close();
      }
    });
  (Bun.which("nvim") && Bun.which("jj") ? test : test.skip)(
    "real Neovim editor saves its own description and returns to history",
    async () => {
      const f = createOperationPtyTestRepo(0, "nvim");
      const session = await launchOperationPtyTest(f);
      try {
        await beginOperationPtyTest(session, "squash");
        await session.press("enter");
        await session.waitForText(/ From /);
        await session.click("B destination");
        await session.waitForText(/Enter Squash/, { timeout: 15_000 });
        await session.press("enter");
        await session.waitForText(/Enter a description for the combined commit/, {
          timeout: 15_000,
        });
        await session.press(["ctrl", "c"]);
        session.writeRaw("ggdGiNeovim chosen description\x1b:wq\r");
        await session.waitForText(/1 revision was squashed\./, { timeout: 20_000 });
        expect(
          f.jj(
            "--ignore-working-copy",
            "log",
            "--no-graph",
            "-r",
            `change_id(${f.destination[1]})`,
            "-T",
            "description",
          ),
        ).toBe("Neovim chosen description\n");
        expect(session.isDead).toBe(false);
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
        session.writeRaw("R");
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
        await harness.pressAndWaitForSnapshot(session, "pagedown", (snapshot) =>
          snapshot.includes(`> ${f.recovery[8]!}`),
        );
        await harness.pressAndWaitForSnapshot(session, "y", (snapshot) =>
          snapshot.includes(`Copied ${f.recovery[8]!.slice(0, 8)}`),
        );
        expect(session.getRawOutput()).toContain(Buffer.from(f.recovery[8]!).toString("base64"));
        await session.press("end");
        await session.waitIdle();
        text = await session.text();
        expect(text).toContain("Recovery");
        await session.press("r");
        text = await session.waitForText(/0 selected/);
        expect(text).toContain("Choose rebase sources");
      } finally {
        session.close();
      }
    },
  );
});

for (const cols of [42, 80, 120])
  jjTest(
    `real Squash keeps inline roles and IDs with a minimal footer and cancel at ${cols} columns`,
    async () => {
      const f = createOperationPtyTestRepo();
      const session = await launchOperationPtyTest(f, cols);
      try {
        const before = await session.text();
        await beginOperationPtyTest(session, "squash");
        await session.press("enter");
        await session.waitForText(/ From /);
        await session.click("B destination");
        const ready = await session.waitForText(/Enter Squash/, { timeout: 15_000 });
        const destination = ready.split("\n").find((line) => line.includes(" Into "))!;
        expect(destination, ready).toBeDefined();
        expect(destination).toContain(f.destination[1].slice(0, 8));
        // A narrow dock can put the source below the viewport; preserve that scrolling policy.
        await session.press("down");
        const sourceFrame = await harness.waitForSnapshot(
          session,
          (text) => text.includes(" From ") && text.includes("This is the source."),
          10_000,
        );
        const source = sourceFrame.split("\n").find((line) => line.includes(" From "))!;
        expect(source, sourceFrame).toBeDefined();
        expect(source).toContain(f.source[1].slice(0, 8));
        expect(sourceFrame).not.toContain(" Into ");
        expect(source.indexOf(f.source[1].slice(0, 8))).toBe(
          before
            .split("\n")
            .find((line) => line.includes("A source"))!
            .indexOf(f.source[1].slice(0, 8)),
        );
        await session.press("up");
        await session.waitForText(/Enter Squash/);
        await session.press("d");
        expect(await session.text()).not.toContain("Action details");
        expect(await session.text()).not.toContain("Details");
        expect(await session.text()).not.toContain("From:");
        expect(await session.text()).not.toContain("Source is removed.");
        const returned = await session.waitForText(/Enter Squash/);
        expect(returned).toContain(" Into ");
        await session.press("escape");
        const cancelled = await harness.waitForSnapshot(
          session,
          (text) => !text.includes(" From ") && text.includes("No explicit selection"),
          10_000,
        );
        expect(cancelled).not.toContain(" From ");
        expect(cancelled).not.toContain(" Into ");
        expect(
          f.jj(
            "--ignore-working-copy",
            "log",
            "--no-graph",
            "-r",
            f.source[0],
            "-T",
            "description",
          ),
        ).toContain("A source");
      } finally {
        session.close();
      }
    },
  );

jjTest("delayed Squash feedback keeps a real pending preview non-executable", async () => {
  const f = createOperationPtyTestRepo(0, true);
  const realJj = Bun.which("jj")!;
  const shimDir = join(f.cwd, "..", "shim");
  mkdirSync(shimDir);
  const release = join(shimDir, "release");
  const shim = join(shimDir, "jj");
  writeFileSync(
    shim,
    `#!${process.execPath}
import { existsSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("squash")) while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(10);
const child = Bun.spawn([${JSON.stringify(realJj)}, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.exit(await child.exited);
`,
  );
  chmodSync(shim, 0o755);
  const gatedFixture = {
    ...f,
    env: { ...f.env, PATH: `${shimDir}${delimiter}${process.env.PATH ?? ""}` },
  };
  const session = await launchOperationPtyTest(gatedFixture);
  try {
    await beginOperationPtyTest(session, "squash");
    await session.press("enter");
    await session.waitForText(/ From /);
    await session.click("B destination");
    const checking = await session.waitForText(/Checking squash/, { timeout: 15_000 });
    expect(checking).toContain(" Into ");
    expect(checking).toContain("Esc Cancel");
    expect(checking).not.toContain("Enter Squash");
    await session.press("enter");
    expect(existsSync(f.editorPid)).toBe(false);
    writeFileSync(release, "release the preview\n");
    const ready = await session.waitForText(/Enter Squash/, { timeout: 15_000 });
    expect(ready).not.toContain("Checking squash");
    expect(existsSync(f.editorPid)).toBe(false);
    await session.press("escape");
    expect(
      f.jj("--ignore-working-copy", "log", "--no-graph", "-r", f.source[0], "-T", "description"),
    ).toContain("A source");
  } finally {
    writeFileSync(release, "release cleanup\n");
    session.close();
  }
});

jjTest(
  "ordinary selection survives real singleton Squash into a selected destination",
  async () => {
    const f = createOperationPtyTestRepo(0, true);
    const session = await launchOperationPtyTest(f);
    try {
      await session.click("A source");
      await session.press("m");
      await session.waitForText(/1 selected/);
      await session.click("B destination");
      await session.press("m");
      await session.waitForText(/2 selected/);
      session.writeRaw("S");
      let text = await session.waitForText(/Enter Squash/, { timeout: 15_000 });
      expect(text).toMatch(/From +A source/);
      expect(text).toMatch(/Into +B destination/);
      expect(text).not.toContain("Continue");
      expect(text).not.toContain("Inspect");
      await session.press("enter");
      await session.waitForText(/HK27_EDITOR_READY/);
      await session.press("enter");
      await session.waitForText(/Esc Dismiss/, { timeout: 15_000 });
      text = await session.waitForText(/1 selected/);
      expect(text).toMatch(/Selected +PTY chosen description/);
      expect(text).not.toContain("A source");
      expect(
        f.jj("log", "--no-graph", "-r", `change_id(${f.source[1]})`, "-T", "commit_id").trim(),
      ).toBe("");
      expect(f.jj("file", "show", "-r", `change_id(${f.destination[1]})`, "a.ts")).toContain(
        "source = true",
      );
    } finally {
      session.close();
    }
  },
);

for (const [cols, rows] of [
  [80, 24],
  [42, 24],
  [28, 14],
])
  jjTest(
    `clean Squash notice leaves native history usable and retains full receipt at ${cols}x${rows}`,
    async () => {
      const f = createOperationPtyTestRepo(0, true);
      if (cols === 42) {
        // A source above B leaves a working-copy descendant that JJ routinely rewrites.
        f.jj("rebase", "--source", f.source[0], "--destination", f.destination[0]);
        f.source[0] = f
          .jj("--ignore-working-copy", "log", "--no-graph", "-r", f.source[1], "-T", "commit_id")
          .trim();
        f.jj("new", "-r", f.source[0], "-m", "W current");
      }
      const session =
        cols === 28
          ? await harness.launchHunk({
              args: ["log", "--vcs", "jj", "--all", "--color", "never", "--no-extensions"],
              cwd: f.cwd,
              env: f.env,
              cols,
              rows,
            })
          : await launchOperationPtyTest(f, cols, rows);
      try {
        if (cols === 28) {
          await session.waitForText(/No explicit selection/);
          await session.press("down");
          await session.press("down");
          await session.waitForText(/A source/);
        }
        await beginOperationPtyTest(session, "squash");
        if (cols === 42) await session.click("B destination");
        else await session.press("up");
        const ready = await session.waitForText(/Enter Squash/, { timeout: 15_000 });
        if (cols === 42) expect(ready).toContain("Into B destination");
        await session.press("enter");
        await session.waitForText(/HK27_EDITOR_READY/, { timeout: 15_000 });
        session.writeRaw("e");
        let text = await session.waitForText(/Esc Dismiss/, { timeout: 20_000 });
        const compact = text.replace(/\s+/g, " ");
        expect(compact).toContain("1 revision was squashed.");
        expect(text).not.toContain("other revision rebased.");
        expect(text).not.toContain("PgUp/PgDn Messages");
        expect(text).not.toContain("jj op revert");
        expect(text).not.toContain("Recorded as operation");
        expect(text).not.toContain(" From ");
        expect(text).not.toContain(" Into ");
        const actualDestination = f
          .jj(
            "--ignore-working-copy",
            "log",
            "--no-graph",
            "-r",
            `change_id(${f.destination[1]})`,
            "-T",
            "commit_id",
          )
          .trim();
        expect(f.jj("file", "show", "-r", actualDestination, "a.ts")).toContain("source = true");
        expect(f.jj("file", "show", "-r", actualDestination, "b.ts")).toContain(
          "destination = true",
        );
        const op = f
          .jj("--ignore-working-copy", "op", "log", "--no-graph", "-n", "1", "-T", "id")
          .trim();
        // Review opens immediately; returning does not erase the persistent notice.
        await session.press("enter");
        await session.waitForText(/a.ts/, { timeout: 15_000 });
        await session.press("q");
        await session.waitForText(/Esc Dismiss/, { timeout: 15_000 });
        session.writeRaw("m");
        await session.waitForText(/1 selected/);
        session.writeRaw("M");
        await session.waitForText(/No explicit selection/);
        await session.press("up");
        await session.press("down");
        expect(await session.text()).toContain("Esc Dismiss");
        await session.press("f10");
        await session.click("Operation result…");
        await session.waitForText(/Operation result/);
        await session.press("end");
        text = await session.text();
        expect(text).toContain("Esc Close");
        await session.press("escape");
        await session.waitForText(/Esc Dismiss/);
        await session.press("escape");
        expect(await session.text()).not.toContain("Esc Dismiss");
        await session.press("f10");
        await session.click("Operation result…");
        await session.waitForText(/Operation result/);
        await session.press("escape");
        expect(await session.text()).not.toContain("Esc Dismiss");
        expect(
          f.jj("--ignore-working-copy", "op", "log", "--no-graph", "-n", "1", "-T", "id").trim(),
        ).toBe(op);
      } finally {
        session.close();
      }
    },
  );

/** Require native launch context and visible history before accepting an upper-context position. */
function expectOperationPtyUpperContext(text: string, context: string) {
  const lines = text.split("\n");
  const policy = lines.findIndex((line) => line.includes("Launch policy"));
  const revset = lines.findIndex((line) => line.includes("Revset:"));
  const task = lines.findIndex((line) => line.includes(context));
  const body = lines.findIndex(
    (line) => line.includes("Commits on") || /[AB] (source|destination)/.test(line),
  );
  expect(revset, text).toBeGreaterThanOrEqual(0);
  expect(policy, text).toBeGreaterThanOrEqual(0);
  expect(task, text).toBeGreaterThan(policy);
  expect(body, text).toBeGreaterThanOrEqual(0);
  expect(task, text).toBeLessThan(body);
  return { lines, body };
}

jjTest(
  "native upper selection and Squash context survives destination browsing and cancel at42",
  async () => {
    const f = createOperationPtyTestRepo();
    const session = await launchOperationPtyTest(f, 42, 24);
    try {
      await session.click("A source");
      await session.press("m");
      expectOperationPtyUpperContext(await session.waitForText(/1 selected/), "1 selected");
      session.writeRaw("S");
      const initial = await session.waitForText(/ From /);
      expectOperationPtyUpperContext(initial, "Squash");
      expect(initial).not.toContain("Enter Squash");
      await session.click("B destination");
      const ready = await session.waitForText(/Enter Squash/, { timeout: 15_000 });
      expectOperationPtyUpperContext(ready, "Squash");
      expect(ready).toContain("1 revision will be squashed.");
      expect(ready).not.toContain("other revision will be rebased");
      expect(ready).toContain(f.destination[1].slice(0, 8));
      expect(ready).toContain("↑↓ Destination");
      expect(ready.split("\n").some((line) => line.includes("Enter Squash · Esc Cancel"))).toBe(
        true,
      );
      await session.click("A source");
      const refused = await session.waitForText(/This is the source/);
      const { lines, body } = expectOperationPtyUpperContext(refused, "Squash");
      expect(lines.findIndex((line) => line.includes("This is the source"))).toBeGreaterThan(body);
      expect(refused).not.toContain("Enter Squash");
      await session.click("B destination");
      await session.waitForText(/Enter Squash/, { timeout: 15_000 });
      await session.press("escape");
      const cancelled = await session.waitForText(/1 selected/);
      expectOperationPtyUpperContext(cancelled, "1 selected");
      expect(cancelled).not.toContain(" From ");
      expect(cancelled).not.toContain(" Into ");
      expect(cancelled).toContain(f.source[1].slice(0, 8));
    } finally {
      session.close();
    }
  },
);
