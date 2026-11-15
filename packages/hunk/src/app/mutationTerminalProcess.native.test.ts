import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHandedOverMutationProcess } from "./mutationTerminalProcess";

const unixTest = process.platform === "win32" ? test.skip : test;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Check process existence without signalling unrelated processes. */
function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

for (const mode of ["cancel", "normal-exit"] as const)
  unixTest(
    `owned terminal group settles a child forked during ${mode}`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), "hunk-terminal-group-"));
      roots.push(root);
      const script = join(root, "command.mjs");
      const ready = join(root, "ready");
      const child = join(root, "child");
      writeFileSync(
        script,
        `import {writeFileSync} from 'node:fs';
    function fork() { const child = Bun.spawn([process.execPath, '-e', 'await Bun.sleep(30000)'], {stdin:'ignore',stdout:'ignore',stderr:'ignore'}); writeFileSync(${JSON.stringify(child)}, String(child.pid)); process.exit(0); }
    ${mode === "cancel" ? "process.on('SIGTERM', fork);" : "setTimeout(fork, 100);"}
    writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(()=>{}, 1000);`,
      );
      const abort = new AbortController();
      const running = runHandedOverMutationProcess(
        { executable: process.execPath, args: [script], cwd: root, terminal: "handed-over" },
        abort.signal,
      );
      const deadline = Date.now() + 3000;
      while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
      expect(existsSync(ready)).toBe(true);
      if (mode === "cancel") abort.abort();
      const result = await running;
      expect(result).toMatchObject({
        started: true,
        terminalRestored: true,
        wasInterrupted: mode === "cancel",
      });
      expect(existsSync(child)).toBe(true);
      expect(processExists(Number(readFileSync(child, "utf8")))).toBe(false);
    },
    10000,
  );

unixTest(
  "PTY close failure retains a started successful command and prevents input restoration",
  async () => {
    const close = Bun.Terminal.prototype.close;
    const failure = spyOn(Bun.Terminal.prototype, "close").mockImplementation(
      function (this: Bun.Terminal) {
        close.call(this);
        throw new Error("test PTY close failure");
      },
    );
    try {
      const result = await runHandedOverMutationProcess(
        {
          executable: process.execPath,
          args: ["-e", "process.exit(0)"],
          cwd: process.cwd(),
          terminal: "handed-over",
        },
        new AbortController().signal,
      );
      expect(result).toMatchObject({ started: true, exitCode: 0, terminalRestored: false });
      expect(result.text).toContain("test PTY close failure");
    } finally {
      failure.mockRestore();
    }
  },
);
