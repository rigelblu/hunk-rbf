import { expect, test } from "bun:test";
import { runHistoryMutationInTerminal } from "./runHistoryMutationInTerminal";
import type { ExtensionVcsMutationProcessOutcome } from "../../extension-api/types";

const invocation = {
  executable: "jj",
  args: ["squash"],
  cwd: process.cwd(),
  terminal: "handed-over" as const,
};
/** Observe ownership ordering while replacing only the OS process and stdin boundary. */
function createTerminalLeaseTest(exitCode = 0) {
  const events: string[] = [];
  const result: ExtensionVcsMutationProcessOutcome = {
    started: true,
    exitCode,
    signal: null,
    wasInterrupted: false,
    terminal: "handed-over",
    terminalRestored: true,
    text: "shown",
  };
  const options = {
    renderer: {
      isDestroyed: false,
      suspend: () => {
        events.push("suspend");
      },
      resume: () => {
        events.push("resume");
      },
    },
    run: async () => {
      events.push("run");
      return result;
    },
    acknowledge: async () => {
      events.push("ack");
    },
    drain: async () => {
      events.push("drain");
    },
    claimInterrupt: (_claim: () => boolean, native?: boolean) => {
      events.push(`claim:${native}`);
      return () => {
        events.push("withdraw");
      };
    },
    onRestoreFailure: () => {
      events.push("quit");
    },
  };
  return { events, options };
}
test("editor lease restores after settlement and drains typeahead before enabling Hunk input", async () => {
  const f = createTerminalLeaseTest();
  const result = await runHistoryMutationInTerminal(
    invocation,
    new AbortController().signal,
    f.options,
  );
  expect(f.events).toEqual(["suspend", "claim:true", "run", "drain", "resume", "withdraw"]);
  expect(result).toMatchObject({ started: true, exitCode: 0, terminalRestored: true });
});
test("nonzero editor output stays visible until acknowledgement before restoration", async () => {
  const f = createTerminalLeaseTest(1);
  await runHistoryMutationInTerminal(invocation, new AbortController().signal, f.options);
  expect(f.events).toEqual(["suspend", "claim:true", "run", "ack", "drain", "resume", "withdraw"]);
});
test("host abort skips acknowledgement but still restores after command settlement", async () => {
  const f = createTerminalLeaseTest(1);
  const abort = new AbortController();
  abort.abort();
  await runHistoryMutationInTerminal(invocation, abort.signal, f.options);
  expect(f.events).not.toContain("ack");
  expect(f.events).toContain("resume");
});
test("restore failure preserves actual process outcome and requests awaited shutdown", async () => {
  const f = createTerminalLeaseTest();
  f.options.renderer.resume = () => {
    throw new Error("restore failed");
  };
  const result = await runHistoryMutationInTerminal(
    invocation,
    new AbortController().signal,
    f.options,
  );
  expect(result).toMatchObject({ started: true, exitCode: 0, terminalRestored: false });
  expect(result.text).toContain("restore failed");
  expect(f.events.slice(-2)).toEqual(["quit", "withdraw"]);
});
test("launch rejection still drains and restores the renderer without inventing a started command", async () => {
  const f = createTerminalLeaseTest();
  f.options.run = async () => {
    throw new Error("launch failed");
  };
  const result = await runHistoryMutationInTerminal(
    invocation,
    new AbortController().signal,
    f.options,
  );
  expect(result).toMatchObject({ started: false, terminalRestored: true });
  expect(result.text).toContain("launch failed");
  expect(f.events).toContain("resume");
});

test("unsettled command group cannot restore Hunk input", async () => {
  const f = createTerminalLeaseTest();
  f.options.run = async () => ({
    started: true,
    exitCode: 0,
    signal: null,
    wasInterrupted: false,
    terminal: "handed-over",
    terminalRestored: false,
    text: "group did not stop",
  });
  const result = await runHistoryMutationInTerminal(
    invocation,
    new AbortController().signal,
    f.options,
  );
  expect(result.started).toBe(true);
  expect(result.terminalRestored).toBe(false);
  expect(f.events).not.toContain("resume");
  expect(f.events).toContain("quit");
});
