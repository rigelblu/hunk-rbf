import { describe, expect, test } from "bun:test";
import type {
  ExtensionVcsMutationCapability,
  ExtensionVcsMutationInvocation,
  ExtensionVcsMutationPrepared,
  ExtensionVcsMutationProcessOutcome,
  ExtensionVcsMutationResult,
} from "../extension-api/types";
import {
  HISTORY_MUTATION_BUSY_REASON,
  HISTORY_MUTATION_TIMEOUT_REASON,
  createHistoryMutationCoordinator,
  runCapturedMutationCommand,
} from "./mutationCoordinator";

const REQUEST = { kind: "abandon", sources: [{ revisionId: "a".repeat(40) }] } as const;

/** Builds a prepared mutation with only the fields these tests read. */
function createTestPrepared(handleId: string): ExtensionVcsMutationPrepared {
  return {
    handleId,
    request: REQUEST,
    facts: {
      providerVersion: "0.46.0",
      operationId: "op0",
      revisions: [],
      files: { kind: "clean" },
    },
    projection: { headline: "Abandon", notes: [], warnings: [], named: [] },
    isInteractive: false,
  };
}

/** Builds how a captured command ended. */
function createTestOutcome(
  overrides: Partial<ExtensionVcsMutationProcessOutcome> = {},
): ExtensionVcsMutationProcessOutcome {
  return {
    started: true,
    exitCode: 0,
    signal: null,
    wasInterrupted: false,
    terminal: "captured",
    terminalRestored: true,
    text: "",
    ...overrides,
  };
}

/** Builds a capability whose calls a test replaces one at a time. */
function createTestCapability(
  overrides: Partial<ExtensionVcsMutationCapability> = {},
): ExtensionVcsMutationCapability & { disposed: string[] } {
  const disposed: string[] = [];
  return {
    disposed,
    availability: async () => ({
      kind: "supported",
      kinds: ["abandon"],
      providerVersion: "0.46.0",
    }),
    prepare: async () => ({ kind: "ready", prepared: createTestPrepared("h1") }),
    apply: async () => ({ kind: "not-run", reason: "stale-handle" }),
    dispose: (handleId) => {
      disposed.push(handleId);
    },
    ...overrides,
  };
}

const CAPTURED: ExtensionVcsMutationInvocation = {
  executable: "jj",
  args: ["abandon"],
  cwd: "/repo",
  terminal: "captured",
};

describe("createHistoryMutationCoordinator", () => {
  test("gives the provider the repository for every call", async () => {
    const seen: string[] = [];
    const capability = createTestCapability({
      availability: async ({ cwd }) => {
        seen.push(cwd);
        return { kind: "unsupported", reason: "too old" };
      },
      prepare: async (_request, { cwd }) => {
        seen.push(cwd);
        return { kind: "ready", prepared: createTestPrepared("h1") };
      },
      apply: async (_handleId, _execution, { cwd }) => {
        seen.push(cwd);
        return { kind: "not-run", reason: "cancelled" };
      },
    });
    const coordinator = createHistoryMutationCoordinator({ capability, cwd: "/repo" });

    expect(await coordinator.availability()).toEqual({ kind: "unsupported", reason: "too old" });
    expect(await coordinator.prepare(REQUEST)).toMatchObject({ kind: "ready" });
    await coordinator.apply("h1", new AbortController().signal);
    await coordinator.dispose("h1");

    expect(seen).toEqual(["/repo", "/repo", "/repo"]);
    expect(capability.disposed).toEqual(["h1"]);
  });

  test("runs a captured command once per Apply", async () => {
    const commands: ExtensionVcsMutationInvocation[] = [];
    let secondRun: unknown;
    const capability = createTestCapability({
      apply: async (_handleId, execution): Promise<ExtensionVcsMutationResult> => {
        const process = await execution.run(CAPTURED);
        secondRun = await execution.run(CAPTURED).catch((error: Error) => error.message);
        return {
          kind: "ran",
          process,
          change: { kind: "unread", reason: "test" },
          verdict: { outcome: "completed", headline: "", notes: [], warnings: [], named: [] },
          isWorkingCopyStale: false,
        };
      },
    });
    const coordinator = createHistoryMutationCoordinator({
      capability,
      cwd: "/repo",
      runCaptured: async (invocation) => {
        commands.push(invocation);
        return createTestOutcome();
      },
    });

    const result = await coordinator.apply("h1", new AbortController().signal);

    expect(result).toMatchObject({ kind: "ran", process: { started: true, exitCode: 0 } });
    expect(commands).toEqual([CAPTURED]);
    expect(secondRun).toBe("A history change may run its command only once.");
  });

  test("reports a command that needs the terminal as not started", async () => {
    let outcome: ExtensionVcsMutationProcessOutcome | undefined;
    const capability = createTestCapability({
      apply: async (_handleId, execution) => {
        outcome = await execution.run({ ...CAPTURED, terminal: "handed-over" });
        return { kind: "not-run", reason: "start-failed", text: outcome.text };
      },
    });
    const coordinator = createHistoryMutationCoordinator({
      capability,
      cwd: "/repo",
      runCaptured: async () => {
        throw new Error("must not run");
      },
    });

    await coordinator.apply("h1", new AbortController().signal);

    expect(outcome).toMatchObject({ started: false, terminal: "handed-over" });
  });

  test("refuses a preparation while an Apply is still running, and allows it afterwards", async () => {
    let finish!: () => void;
    const running = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const capability = createTestCapability({
      apply: async () => {
        await running;
        return { kind: "not-run", reason: "cancelled" };
      },
    });
    const coordinator = createHistoryMutationCoordinator({ capability, cwd: "/repo" });

    const applying = coordinator.apply("h1", new AbortController().signal);
    expect(await coordinator.prepare(REQUEST)).toEqual({
      kind: "refused",
      reason: HISTORY_MUTATION_BUSY_REASON,
    });
    finish();
    await applying;

    expect(await coordinator.prepare(REQUEST)).toMatchObject({ kind: "ready" });
  });

  test("refuses a preparation that reads too long, and tells it from a cancel", async () => {
    const capability = createTestCapability({
      prepare: (_request, { signal }) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => resolve({ kind: "cancelled" }), { once: true });
        }),
    });
    const coordinator = createHistoryMutationCoordinator({
      capability,
      cwd: "/repo",
      prepareTimeoutMs: 5,
    });

    expect(await coordinator.prepare(REQUEST)).toEqual({
      kind: "refused",
      reason: HISTORY_MUTATION_TIMEOUT_REASON,
    });

    const patient = createHistoryMutationCoordinator({ capability, cwd: "/repo" });
    const cancel = new AbortController();
    const cancelled = patient.prepare(REQUEST, cancel.signal);
    cancel.abort();
    expect(await cancelled).toEqual({ kind: "cancelled" });
  });
});

describe("the coordinator's bounds", () => {
  test("refuses at the bound even when the provider ignores the signal", async () => {
    let resolveLate!: (value: { kind: "ready"; prepared: ExtensionVcsMutationPrepared }) => void;
    const capability = createTestCapability({
      prepare: () =>
        new Promise((resolve) => {
          resolveLate = resolve;
        }),
    });
    const coordinator = createHistoryMutationCoordinator({
      capability,
      cwd: "/repo",
      prepareTimeoutMs: 5,
    });

    expect(await coordinator.prepare(REQUEST)).toEqual({
      kind: "refused",
      reason: HISTORY_MUTATION_TIMEOUT_REASON,
    });
    // A preparation that arrives after the refusal is disposed, so its handle cannot be applied.
    resolveLate({ kind: "ready", prepared: createTestPrepared("late") });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(capability.disposed).toEqual(["late"]);
  });

  test("gives Apply's reads a signal that ends at the bound, and frees the coordinator", async () => {
    const capability = createTestCapability({
      apply: (_handleId, _execution, { signal }) =>
        new Promise((resolve) => {
          signal?.addEventListener(
            "abort",
            () => resolve({ kind: "not-run", reason: "cancelled" }),
            {
              once: true,
            },
          );
        }),
    });
    const coordinator = createHistoryMutationCoordinator({
      capability,
      cwd: "/repo",
      applyTimeoutMs: 5,
    });

    expect(await coordinator.apply("h1", new AbortController().signal)).toEqual({
      kind: "not-run",
      reason: "cancelled",
    });
    expect(await coordinator.prepare(REQUEST)).toMatchObject({ kind: "ready" });
  });
});

describe("runCapturedMutationCommand", () => {
  test("captures the command's text and exit code", async () => {
    const outcome = await runCapturedMutationCommand(
      {
        executable: process.execPath,
        args: ["-e", "console.error('to stderr'); console.log('to stdout'); process.exit(3)"],
        cwd: process.cwd(),
        terminal: "captured",
      },
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({
      started: true,
      exitCode: 3,
      wasInterrupted: false,
      text: "to stderr\nto stdout",
    });
  });

  test("reports a command that cannot start", async () => {
    const outcome = await runCapturedMutationCommand(
      { executable: "hunk-no-such-command", args: [], cwd: process.cwd(), terminal: "captured" },
      new AbortController().signal,
    );
    expect(outcome.started).toBe(false);
  });

  test("stops the command when Hunk is asked to", async () => {
    const abort = new AbortController();
    const running = runCapturedMutationCommand(
      {
        executable: process.execPath,
        args: ["-e", "setTimeout(() => {}, 60000)"],
        cwd: process.cwd(),
        terminal: "captured",
      },
      abort.signal,
    );
    setTimeout(() => abort.abort(), 50);
    expect(await running).toMatchObject({ started: true, wasInterrupted: true });
  });

  const unixTest = process.platform === "win32" ? test.skip : test;
  unixTest(
    "stops what the command started, so a child holding the output cannot keep it waiting",
    async () => {
      const abort = new AbortController();
      const started = Date.now();
      const running = runCapturedMutationCommand(
        {
          executable: "/bin/sh",
          // The shell exits on the signal; without the process group its child would keep the pipes open.
          args: ["-c", "sleep 30 & wait"],
          cwd: process.cwd(),
          terminal: "captured",
        },
        abort.signal,
      );
      setTimeout(() => abort.abort(), 50);

      expect(await running).toMatchObject({ started: true, wasInterrupted: true });
      expect(Date.now() - started).toBeLessThan(3000);
    },
  );

  const perlTest = process.platform !== "win32" && Bun.which("perl") ? test : test.skip;
  perlTest("does not wait for a process the command left behind holding the output", async () => {
    const started = Date.now();
    const outcome = await runCapturedMutationCommand(
      {
        executable: "/bin/sh",
        // The survivor starts its own session, so stopping the command's group would not reach it.
        args: ["-c", "perl -e 'use POSIX; POSIX::setsid(); sleep 8' & echo done"],
        cwd: process.cwd(),
        terminal: "captured",
      },
      new AbortController().signal,
    );

    expect(outcome).toMatchObject({ started: true, exitCode: 0, wasInterrupted: false });
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

test("handed-over executor owns the human wait without the captured-command deadline", async () => {
  let finalSignal: AbortSignal | undefined;
  const capability = createTestCapability({
    apply: async (_handle, execution, context) => {
      finalSignal = context.signal;
      const process = await execution.run({ ...CAPTURED, terminal: "handed-over" });
      return { kind: "not-run", reason: "start-failed", text: process.text };
    },
  });
  const coordinator = createHistoryMutationCoordinator({
    capability,
    cwd: "/repo",
    applyTimeoutMs: 5,
  });
  let runs = 0;
  const result = await coordinator.apply("h", new AbortController().signal, async () => {
    runs++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finalSignal?.aborted).toBe(false);
    return createTestOutcome({ terminal: "handed-over", text: "editor returned" });
  });
  expect(runs).toBe(1);
  expect(result).toMatchObject({ text: "editor returned" });
});
