/** Run JJ and its editor in an owned terminal group before returning the actual process result. */
import type {
  ExtensionVcsMutationInvocation,
  ExtensionVcsMutationProcessOutcome,
} from "../extension-api/types";

const TERMINATION_GRACE_MS = 250;
const SETTLEMENT_TIMEOUT_MS = 2_000;

/** Probe only the process group created for this command, including orphaned editor children. */
function groupExists(pid: number) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/** Signal the owned group; an already empty group needs no further cleanup. */
function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** Stop every remaining group member and verify settlement before Hunk can reclaim input. */
async function settleGroup(pid: number) {
  if (!groupExists(pid)) return;
  signalGroup(pid, "SIGTERM");
  const started = performance.now();
  while (groupExists(pid)) {
    if (performance.now() - started >= TERMINATION_GRACE_MS) signalGroup(pid, "SIGKILL");
    if (performance.now() - started >= SETTLEMENT_TIMEOUT_MS)
      throw new Error(
        "The editor process group did not stop; Hunk cannot safely reclaim terminal input.",
      );
    await Bun.sleep(10);
  }
}

/** Proxy the session's terminal to an owned PTY and settle cancellation before provider readback. */
export async function runHandedOverMutationProcess(
  invocation: ExtensionVcsMutationInvocation,
  signal: AbortSignal,
  setInterrupt?: (handler: () => void) => void,
): Promise<ExtensionVcsMutationProcessOutcome> {
  let outcome: ExtensionVcsMutationProcessOutcome = {
    started: false,
    exitCode: null,
    signal: null,
    wasInterrupted: signal.aborted,
    terminal: "handed-over",
    terminalRestored: true,
    text: "",
  };
  if (signal.aborted) return outcome;
  // ConPTY alone cannot own or verify a Windows process tree. Refuse before starting a write.
  if (process.platform === "win32")
    return {
      ...outcome,
      text: "Interactive history commands need Windows process-job support before Hunk can run them.",
    };
  let proc: Bun.Subprocess | undefined;
  let terminal: Bun.Terminal | undefined;
  const wasRaw = Boolean(process.stdin.isRaw);
  let terminalEnded!: () => void;
  const terminalEOF = new Promise<void>((resolve) => {
    terminalEnded = resolve;
  });
  let interrupted = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let cleanupFailure: unknown;
  const resize = () => terminal?.resize(process.stdout.columns || 80, process.stdout.rows || 24);
  const input = (bytes: Buffer) => {
    terminal?.write(bytes);
  };
  const stop = () => {
    if (!proc || interrupted) return;
    interrupted = true;
    try {
      signalGroup(proc.pid, "SIGTERM");
    } catch (error) {
      cleanupFailure = error;
    }
    killTimer = setTimeout(() => {
      try {
        signalGroup(proc!.pid, "SIGKILL");
      } catch (error) {
        cleanupFailure = error;
      }
    }, TERMINATION_GRACE_MS);
  };
  try {
    // Bun's PTY spawn creates a foreground process group with PID=PGID and a controlling /dev/tty.
    proc = Bun.spawn([invocation.executable, ...invocation.args], {
      cwd: invocation.cwd,
      detached: true,
      terminal: {
        cols: process.stdout.columns || 80,
        rows: process.stdout.rows || 24,
        data: (_terminal, bytes) => {
          process.stdout.write(bytes);
        },
        exit: () => {
          terminalEnded();
        },
      },
    });
    terminal = proc.terminal;
    outcome = {
      ...outcome,
      started: true,
      text: "Command output was shown in the terminal and was not captured.",
    };
    setInterrupt?.(() => signalGroup(proc!.pid, "SIGINT"));
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on("data", input);
    process.stdout.on("resize", resize);
    signal.addEventListener("abort", stop, { once: true });
    process.stdin.resume();
    if (signal.aborted) stop();
    const exitCode = await proc.exited;
    outcome = {
      ...outcome,
      exitCode: proc.signalCode ? null : exitCode,
      signal: proc.signalCode ?? null,
      wasInterrupted: interrupted,
    };
  } catch (error) {
    outcome = { ...outcome, text: `${outcome.text}\n${String(error)}`.trim() };
  } finally {
    process.stdin.pause();
    process.stdin.off("data", input);
    process.stdout.off("resize", resize);
    signal.removeEventListener("abort", stop);
    if (killTimer) clearTimeout(killTimer);
    try {
      // Normal JJ exit must also retire an editor/helper that retained the PTY.
      if (proc) {
        await settleGroup(proc.pid);
        const exitCode = await proc.exited;
        outcome = {
          ...outcome,
          exitCode: proc.signalCode ? null : exitCode,
          signal: proc.signalCode ?? null,
          wasInterrupted: interrupted,
        };
        await Promise.race([terminalEOF, Bun.sleep(250)]);
      }
    } catch (error) {
      outcome = {
        ...outcome,
        terminalRestored: false,
        text: `${outcome.text}\n${String(error)}`.trim(),
      };
    }
    if (cleanupFailure)
      outcome = {
        ...outcome,
        terminalRestored: false,
        text: `${outcome.text}\n${String(cleanupFailure)}`.trim(),
      };
    try {
      terminal?.close();
    } catch (error) {
      outcome = {
        ...outcome,
        terminalRestored: false,
        text: `${outcome.text}\nCould not close the editor terminal: ${String(error)}`.trim(),
      };
    }
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
    } catch (error) {
      outcome = {
        ...outcome,
        terminalRestored: false,
        text: `${outcome.text}\nCould not restore terminal mode: ${String(error)}`.trim(),
      };
    }
  }
  return outcome;
}
