/**
 * Runs the history view's mutations against one provider, one at a time.
 *
 * The history view asks to prepare a change, the user confirms it, and Apply
 * runs it. This module sits between the two: it gives the provider the
 * repository to work in, runs the provider's command when Apply is confirmed,
 * and refuses a second mutation while one is still running in this process.
 * It also bounds how long a preparation may read the repository.
 *
 * The provider owns what the command is and what its result means. The history
 * view owns every dialog. Handing the terminal to an interactive command is a
 * later slice; until then such a command is reported as not started.
 */
import type {
  ExtensionVcsMutationCapability,
  ExtensionVcsMutationInvocation,
  ExtensionVcsMutationPreparation,
  ExtensionVcsMutationProcessOutcome,
  ExtensionVcsMutationRequest,
  ExtensionVcsMutationResult,
} from "../extension-api/types";

/** How long a preparation may read the repository before it is refused. */
export const HISTORY_MUTATION_PREPARE_TIMEOUT_MS = 30_000;
/** How long one Apply may take in all, so a command that never returns cannot leave Hunk busy for good. */
export const HISTORY_MUTATION_APPLY_TIMEOUT_MS = 300_000;
const TERMINATION_GRACE_MS = 250;

export const HISTORY_MUTATION_BUSY_REASON = "Another history change is still running in this Hunk.";
export const HISTORY_MUTATION_TIMEOUT_REASON =
  "Reading the repository took longer than 30 seconds.";

export interface HistoryMutationCoordinatorOptions {
  capability: ExtensionVcsMutationCapability;
  /** The repository the provider's commands run in. */
  cwd: string;
  prepareTimeoutMs?: number;
  applyTimeoutMs?: number;
  /** Runs a captured command. Tests replace it; the default starts a real process. */
  runCaptured?: (
    invocation: ExtensionVcsMutationInvocation,
    signal: AbortSignal,
  ) => Promise<ExtensionVcsMutationProcessOutcome>;
}

/**
 * What the history view calls. `ui/history/types.ts` mirrors this shape as
 * `HistoryMutationRuntime`, because this tier may not import the UI's types.
 */
export interface HistoryMutationCoordinator {
  availability(signal?: AbortSignal): ReturnType<ExtensionVcsMutationCapability["availability"]>;
  prepare(
    request: ExtensionVcsMutationRequest,
    signal?: AbortSignal,
  ): Promise<ExtensionVcsMutationPreparation>;
  apply(handleId: string, signal: AbortSignal): Promise<ExtensionVcsMutationResult>;
  dispose(handleId: string): Promise<void>;
}

/**
 * Runs one command with Hunk keeping the terminal, and stops it when Hunk is asked to.
 *
 * The command gets its own process group, so stopping it also stops what it started: a signing
 * helper or a hook that kept the output pipes open would otherwise keep this call waiting.
 */
export async function runCapturedMutationCommand(
  invocation: ExtensionVcsMutationInvocation,
  signal: AbortSignal,
): Promise<ExtensionVcsMutationProcessOutcome> {
  const outcome = (
    overrides: Partial<ExtensionVcsMutationProcessOutcome>,
  ): ExtensionVcsMutationProcessOutcome => ({
    started: true,
    exitCode: null,
    signal: null,
    wasInterrupted: false,
    terminal: "captured",
    terminalRestored: true,
    text: "",
    ...overrides,
  });

  const ownsProcessGroup = process.platform !== "win32";
  let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
  try {
    proc = Bun.spawn([invocation.executable, ...invocation.args], {
      cwd: invocation.cwd,
      detached: ownsProcessGroup,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return outcome({
      started: false,
      text: error instanceof Error ? error.message : String(error),
    });
  }

  const kill = (killSignal: "SIGTERM" | "SIGKILL") => {
    try {
      if (ownsProcessGroup) {
        process.kill(-proc.pid, killSignal);
      } else {
        // Bun cannot signal a Windows process group; taskkill ends the whole tree.
        Bun.spawn(
          ["taskkill", "/pid", String(proc.pid), "/t", ...(killSignal === "SIGKILL" ? ["/f"] : [])],
          { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
        );
      }
    } catch {
      // The command exited between the request and the signal.
    }
  };
  let wasInterrupted = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const interrupt = () => {
    if (wasInterrupted) return;
    wasInterrupted = true;
    kill("SIGTERM");
    killTimer = setTimeout(() => kill("SIGKILL"), TERMINATION_GRACE_MS);
    killTimer.unref?.();
  };
  signal.addEventListener("abort", interrupt, { once: true });
  if (signal.aborted) interrupt();
  try {
    const output = Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    // Once the command has exited, its text is whatever arrives within a short grace. A process it
    // left behind in another session can hold the pipes open, and must not keep Hunk busy.
    const [stdout, stderr] = await Promise.race([
      output,
      new Promise<[string, string]>((resolve) =>
        setTimeout(() => resolve(["", ""]), TERMINATION_GRACE_MS),
      ),
    ]);
    return outcome({
      exitCode: proc.signalCode ? null : exitCode,
      signal: proc.signalCode ?? null,
      wasInterrupted,
      text: [stderr.trim(), stdout.trim()].filter(Boolean).join("\n"),
    });
  } finally {
    signal.removeEventListener("abort", interrupt);
    if (killTimer) clearTimeout(killTimer);
  }
}

/** Creates the mutation runtime the history view calls. */
export function createHistoryMutationCoordinator({
  capability,
  cwd,
  prepareTimeoutMs = HISTORY_MUTATION_PREPARE_TIMEOUT_MS,
  applyTimeoutMs = HISTORY_MUTATION_APPLY_TIMEOUT_MS,
  runCaptured = runCapturedMutationCommand,
}: HistoryMutationCoordinatorOptions): HistoryMutationCoordinator {
  /** True from the start of an Apply until its result is in. */
  let isApplying = false;

  return {
    availability(signal) {
      return capability.availability({ cwd, signal });
    },

    async prepare(
      request: ExtensionVcsMutationRequest,
      signal?: AbortSignal,
    ): Promise<ExtensionVcsMutationPreparation> {
      if (isApplying) return { kind: "refused", reason: HISTORY_MUTATION_BUSY_REASON };

      // One signal for both ways a preparation ends early: the user cancels, or the read runs too long.
      const abort = new AbortController();
      const cancel = () => abort.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      const preparing = capability.prepare(request, { cwd, signal: abort.signal });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"timed-out">((resolve) => {
        timer = setTimeout(() => resolve("timed-out"), prepareTimeoutMs);
      });
      try {
        const preparation = await Promise.race([preparing, timedOut]);
        if (preparation !== "timed-out") return preparation;
        // The bound holds even when the provider ignores the signal. `cancelled` is only for a cancel
        // the user asked for, so a read that ran too long is a refusal.
        abort.abort();
        void preparing.then(
          (late) => {
            if (late.kind === "ready") void capability.dispose(late.prepared.handleId);
          },
          () => undefined,
        );
        return { kind: "refused", reason: HISTORY_MUTATION_TIMEOUT_REASON };
      } catch (error) {
        if (signal?.aborted) return { kind: "cancelled" };
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      }
    },

    async apply(handleId: string, signal: AbortSignal): Promise<ExtensionVcsMutationResult> {
      if (isApplying) throw new Error(HISTORY_MUTATION_BUSY_REASON);
      isApplying = true;
      let hasRun = false;
      // The provider's reads stop at this bound, and so does the command. The user's cancel is `signal`.
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), applyTimeoutMs);
      try {
        return await capability.apply(
          handleId,
          {
            signal,
            async run(invocation) {
              // One confirmation authorizes one command.
              if (hasRun) throw new Error("A history change may run its command only once.");
              hasRun = true;
              if (invocation.terminal === "handed-over") {
                return {
                  started: false,
                  exitCode: null,
                  signal: null,
                  wasInterrupted: false,
                  terminal: "handed-over",
                  terminalRestored: true,
                  text: "Hunk cannot hand the terminal to this command yet.",
                };
              }
              return runCaptured(invocation, AbortSignal.any([signal, deadline.signal]));
            },
          },
          { cwd, signal: deadline.signal },
        );
      } finally {
        clearTimeout(timer);
        isApplying = false;
      }
    },

    async dispose(handleId) {
      await capability.dispose(handleId);
    },
  };
}
