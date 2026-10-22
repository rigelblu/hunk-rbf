import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, mkdirSync, chmodSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import type { Session } from "tuistory";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();
const directories: string[] = [];
const jjTest = Bun.which("jj") ? test : test.skip;
setDefaultTimeout(45_000);

/** Create an isolated merge fixture with a distinctive wide configured JJ node glyph. */
function createNativeGraphTestRepo(remap = false) {
  const cwd = mkdtempSync(join(tmpdir(), "hunk-native-graph-pty-"));
  const config = mkdtempSync(join(tmpdir(), "hunk-native-config-"));
  directories.push(cwd, config);
  const env = { ...process.env, XDG_CONFIG_HOME: config };
  const jj = (...args: string[]) => {
    const p = Bun.spawnSync(
      [
        "jj",
        "--config",
        'user.name="Native Tester"',
        "--config",
        'user.email="native@example.invalid"',
        ...args,
      ],
      { cwd, env, stdout: "pipe", stderr: "pipe" },
    );
    if (p.exitCode !== 0) throw Error(p.stderr.toString());
    return p.stdout.toString();
  };
  jj("git", "init", "--no-colocate", ".");
  writeFileSync(join(cwd, "base.ts"), "export const base = 1;\n");
  jj("commit", "-m", "Native base");
  jj("bookmark", "create", "main", "-r", "@-");
  for (const name of ["left", "right"]) {
    jj("new", "main", "-m", `Native ${name}`);
    writeFileSync(join(cwd, `${name}.ts`), `export const ${name} = 1;\n`);
    jj("bookmark", "create", name, "-r", "@");
  }
  jj("new", "left", "right");
  writeFileSync(join(cwd, "merge.ts"), "export const merge = true;\n");
  jj("describe", "-m", "Native merge focus");
  jj("config", "set", "--repo", 'revset-aliases."trunk()"', "main");
  jj("config", "set", "--repo", "templates.log_node", JSON.stringify('"界"'));
  if (remap) {
    mkdirSync(join(config, "hunk"));
    writeFileSync(
      join(config, "hunk", "config.toml"),
      '[keybindings]\n"hunk.history.toggleNativeGraph" = "ctrl+n"\n',
    );
  }
  return { cwd, env };
}

/** Open View through its real mouse hit target and wait for the graph choices. */
async function openNativeTestView(session: Session) {
  await session.click("View");
  return session.waitForText(/Graph view \(jj style\)/, { timeout: 5000 });
}

/** Observe accepted native rows, with the dropdown closed, rather than a transient loading notice. */
async function waitNativeTestStyle(session: Session, native: boolean) {
  return harness.waitForSnapshot(
    session,
    (text) =>
      text.includes("Native merge focus") &&
      text.includes("界") === native &&
      !text.includes("Graph view (jj style)"),
    15000,
  );
}

afterEach(async () => {
  await harness.cleanup();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("native JJ graph terminal interactions", () => {
  jjTest("checks only the visible graph style across menu and shortcut transitions", async () => {
    const f = createNativeGraphTestRepo();
    const session = await harness.launchHunk({
      args: ["log", "--vcs", "jj", "--color", "never", "--no-extensions"],
      ...f,
      cols: 120,
      rows: 24,
    });
    /** Read both graph checks from the accepted View menu rather than a cached preference. */
    const expectGraphMenu = async (hunk: boolean, native: boolean) => {
      const menu = await openNativeTestView(session);
      expect(menu).toMatch(new RegExp(`\\[${hunk ? "x" : " "}\\] Graph view(?! \\(jj style\\))`));
      expect(menu).toContain(`[${native ? "x" : " "}] Graph view (jj style)`);
    };
    try {
      await session.waitForText(/Native merge focus/, { timeout: 15000 });
      await expectGraphMenu(false, false);
      await session.click("Graph view (jj style)");
      await waitNativeTestStyle(session, true);
      await expectGraphMenu(false, true);
      await session.click(/Graph view(?! \(jj style\))/);
      const hunk = await waitNativeTestStyle(session, false);
      expect(hunk).not.toContain("Commits on");
      await expectGraphMenu(true, false);
      await session.click(/Graph view(?! \(jj style\))/);
      await harness.waitForSnapshot(session, (text) => text.includes("Commits on"), 5000);
      await expectGraphMenu(false, false);
      await session.press("escape");
      session.sendKey(["ctrl", "g"]);
      await waitNativeTestStyle(session, true);
      await expectGraphMenu(false, true);
      await session.press("escape");
      session.sendKey(["ctrl", "g"]);
      await waitNativeTestStyle(session, false);
      await expectGraphMenu(true, false);
    } finally {
      session.close();
    }
  });

  jjTest(
    "mouse/shortcut transitions preserve native preference, selected revision and review routing",
    async () => {
      const f = createNativeGraphTestRepo();
      const session = await harness.launchHunk({
        args: ["log", "--vcs", "jj", "--color", "never", "--no-extensions", "--max-count", "100"],
        ...f,
        cols: 120,
        rows: 24,
      });
      try {
        await session.waitForText(/Native merge focus/, { timeout: 15000 });
        const initial = await openNativeTestView(session);
        expect(initial).toContain("[ ] Graph view (jj style)");
        expect(initial.search(/Graph view(?! \(jj style\))/)).toBeLessThan(
          initial.indexOf("Graph view (jj style)"),
        );
        expect(initial).toMatch(/Graph view \(jj style\).*Ctrl\+G/);
        await session.click("Graph view (jj style)");
        await waitNativeTestStyle(session, true);
        const enabled = await openNativeTestView(session);
        expect(enabled).toMatch(/\[ \] Graph view(?! \(jj style\))/);
        expect(enabled).toContain("[x] Graph view (jj style)");
        expect(enabled).toContain("Unicode lines (JJ config)");
        await session.click(/Graph view(?! \(jj style\))/);
        await waitNativeTestStyle(session, false);
        const hunk = await openNativeTestView(session);
        expect(hunk).toMatch(/\[x\] Graph view(?! \(jj style\))/);
        expect(hunk).toContain("[ ] Graph view (jj style)");
        await session.click(/Graph view(?! \(jj style\))/);
        await harness.waitForSnapshot(session, (text) => text.includes("Commits on"), 5000);
        const grouped = await openNativeTestView(session);
        expect(grouped).toMatch(/\[ \] Graph view(?! \(jj style\))/);
        expect(grouped).toContain("[ ] Graph view (jj style)");
        await session.click("Graph view (jj style)");
        await waitNativeTestStyle(session, true);
        session.sendKey(["ctrl", "g"]);
        await waitNativeTestStyle(session, false);
        session.sendKey(["ctrl", "g"]);
        await waitNativeTestStyle(session, true);
        await session.press("y");
        const copied = await session.waitForText(/Copied [a-z0-9]+/, { timeout: 5000 });
        const identity = copied.match(/Copied ([a-z0-9]+)/)![1];
        session.resize({ cols: 80, rows: 5 });
        await session.waitIdle();
        await session.press("pagedown");
        await session.press("y");
        expect(await session.text()).toContain(`Copied ${identity}`);
        session.resize({ cols: 120, rows: 24 });
        await waitNativeTestStyle(session, true);
        await session.press("enter");
        await session.waitForText(/merge.ts/, { timeout: 15000 });
        await session.press("q");
        await waitNativeTestStyle(session, true);
        const returned = await openNativeTestView(session);
        expect(returned).toContain("[x] Graph view (jj style)");
        await session.press("escape");
      } finally {
        session.close();
      }
    },
  );

  jjTest("remapped key/help use one command and text editors own their keys", async () => {
    const f = createNativeGraphTestRepo(true);
    const session = await harness.launchHunk({
      args: ["log", "--vcs", "jj", "--color", "never", "--no-extensions", "--max-count", "100"],
      ...f,
      cols: 120,
      rows: 24,
    });
    try {
      await session.waitForText(/Native merge focus/, { timeout: 15000 });
      const menu = await openNativeTestView(session);
      expect(menu).toMatch(/Graph view \(jj style\).*Ctrl\+N/);
      await session.press("escape");
      session.sendKey(["ctrl", "g"]);
      await waitNativeTestStyle(session, false);
      session.sendKey(["ctrl", "n"]);
      await waitNativeTestStyle(session, true);
      session.writeRaw("L");
      await session.waitForText(/Edit revset/, { timeout: 5000 });
      session.sendKey(["ctrl", "n"]);
      await session.press("escape");
      await waitNativeTestStyle(session, true);
      await session.press("/");
      await session.waitForText(/search commits/i, { timeout: 5000 });
      session.sendKey(["ctrl", "n"]);
      await session.press("escape");
      await waitNativeTestStyle(session, true);
      session.writeRaw("L\x15@ | main\x1bOQ");
      const custom = await session.waitForText(/Custom revset: range review unavailable./, {
        timeout: 15000,
      });
      expect(custom).toContain("界");
      expect(custom).not.toContain("graph links and range");
      await session.press("r");
      await session.waitForText(/History refreshed./, { timeout: 15000 });
      expect(await session.text()).toContain("界");
    } finally {
      session.close();
    }
  });
});

jjTest("Escape cancels a delayed native cursor without changing accepted menu state", async () => {
  const f = createNativeGraphTestRepo();
  const realJj = Bun.which("jj")!;
  const bin = mkdtempSync(join(tmpdir(), "hunk-native-delay-bin-"));
  directories.push(bin);
  const wrapper = join(bin, "jj");
  writeFileSync(
    wrapper,
    `#!${process.execPath}
const args=process.argv.slice(2);
if(args.includes("log")&&!args.includes("--no-graph"))await Bun.sleep(2000);
const child=Bun.spawn([${JSON.stringify(realJj)},...args],{stdin:"inherit",stdout:"inherit",stderr:"inherit"});
process.exit(await child.exited);
`,
  );
  chmodSync(wrapper, 0o755);
  const session = await harness.launchHunk({
    args: ["log", "--vcs", "jj", "--color", "never", "--no-extensions"],
    cwd: f.cwd,
    env: { ...f.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
    cols: 120,
    rows: 24,
  });
  try {
    await session.waitForText(/Native merge focus/, { timeout: 15000 });
    session.sendKey(["ctrl", "g"]);
    await session.waitForText(/Switching graph/, { timeout: 5000 });
    await session.press("escape");
    await waitNativeTestStyle(session, false);
    const canceled = await openNativeTestView(session);
    expect(canceled).toContain("[ ] Graph view (jj style)");
    expect(canceled).toMatch(/\[ \] Graph view(?! \(jj style\))/);
    await session.press("escape");
    await waitNativeTestStyle(session, false);
    session.sendKey(["ctrl", "g"]);
    await waitNativeTestStyle(session, true);
  } finally {
    session.close();
  }
});
