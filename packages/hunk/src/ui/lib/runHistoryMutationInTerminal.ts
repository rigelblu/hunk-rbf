/** Lend the session terminal to JJ/editor and restore input only after the command settles. */
import type { CliRenderer } from "@opentui/core";
import type {
  ExtensionVcsMutationInvocation,
  ExtensionVcsMutationProcessOutcome,
} from "../../extension-api/types";
import { suspendTerminalSession, resumeTerminalSession } from "../../core/process/focusReporting";

type TerminalOwner = Pick<CliRenderer, "suspend" | "resume" | "isDestroyed">;

/** Consume editor typeahead while Hunk has no stdin listener attached. */
async function drainTerminalInput() {
  const discard = () => undefined;
  process.stdin.on("data", discard);
  process.stdin.resume();
  try {
    await new Promise((resolve) => setTimeout(resolve, 35));
  } finally {
    process.stdin.pause();
    process.stdin.off("data", discard);
  }
}

/** Preserve inherited error output until acknowledged, unless the host is shutting down. */
async function acknowledgeTerminalFailure(exitCode: number | null, signal: AbortSignal) {
  if (signal.aborted || !process.stdin.isTTY) return;
  process.stdout.write(
    `\nCommand exited with status ${exitCode ?? "unknown"}. Press any key to return to Hunk.\n`,
  );
  process.stdin.setRawMode(true);
  await new Promise<void>((resolve) => {
    const done = () => {
      process.stdin.pause();
      process.stdin.off("data", done);
      process.stdin.off("end", done);
      signal.removeEventListener("abort", done);
      resolve();
    };
    process.stdin.once("data", done);
    process.stdin.once("end", done);
    signal.addEventListener("abort", done, { once: true });
    process.stdin.resume();
    if (signal.aborted) done();
  });
}

/** Balance the terminal lease even for launch, editor, acknowledgement or restoration failures. */
export async function runHistoryMutationInTerminal(
  invocation: ExtensionVcsMutationInvocation,
  signal: AbortSignal,
  options: {
    renderer: TerminalOwner;
    claimInterrupt?: (claim: () => boolean, nativeSignal?: boolean) => () => void;
    onRestoreFailure: () => void;
    run: (
      invocation: ExtensionVcsMutationInvocation,
      signal: AbortSignal,
      setInterrupt?: (handler: () => void) => void,
    ) => Promise<ExtensionVcsMutationProcessOutcome>;
    acknowledge?: typeof acknowledgeTerminalFailure;
    drain?: typeof drainTerminalInput;
  },
): Promise<ExtensionVcsMutationProcessOutcome> {
  let result: ExtensionVcsMutationProcessOutcome = {
    started: false,
    exitCode: null,
    signal: null,
    wasInterrupted: false,
    terminal: "handed-over",
    terminalRestored: true,
    text: "",
  };
  let withdraw: (() => void) | undefined;
  let interrupt: (() => void) | undefined;
  /** Restore trusted UI input only after the command releases its terminal. */
  const restore = async () => {
    await (options.drain ?? drainTerminalInput)();
    if (!result.terminalRestored)
      throw new Error("The editor command has not safely released the terminal.");
    if (options.renderer.isDestroyed) throw new Error("The terminal renderer was destroyed.");
    resumeTerminalSession(options.renderer);
  };
  try {
    suspendTerminalSession(options.renderer);
    // Native SIGINT belongs to the foreground JJ/editor; SIGTERM/HUP still request host shutdown.
    withdraw = options.claimInterrupt?.(() => {
      interrupt?.();
      return true;
    }, true);
    result = await options.run(invocation, signal, (handler) => {
      interrupt = handler;
    });
    if (result.started && (result.exitCode !== 0 || result.signal) && !signal.aborted)
      await (options.acknowledge ?? acknowledgeTerminalFailure)(result.exitCode, signal);
  } catch (error) {
    result = { ...result, text: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      await restore();
    } catch (error) {
      process.stdin.pause();
      result = {
        ...result,
        terminalRestored: false,
        text: `${result.text}\nHunk could not restore terminal input: ${String(error)}`.trim(),
      };
      options.onRestoreFailure();
    } finally {
      withdraw?.();
    }
  }
  return result;
}
