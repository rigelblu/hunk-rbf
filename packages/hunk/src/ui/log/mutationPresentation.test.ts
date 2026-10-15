import { createTestCleanSquashResult } from "../../../../../test/helpers/mutation-result";
import type {
  ExtensionVcsMutationPrepared,
  ExtensionVcsMutationRevision,
} from "../../extension-api/types";
import { expect, test } from "bun:test";
import type { ExtensionVcsMutationResult } from "../../extension-api/types";
import { cleanSquashResultNotice, mutationResultLines } from "./mutationPresentation";
import { squashErrorOutputAvailable } from "./HistoryOperationView";

/** Supply actual provider facts without running a command or inferring its verdict. */
function createTestMutationResult(): Extract<ExtensionVcsMutationResult, { kind: "ran" }> {
  return {
    kind: "ran",
    process: {
      started: true,
      exitCode: 0,
      signal: null,
      wasInterrupted: false,
      terminal: "captured",
      terminalRestored: true,
      text: "diagnostic\x1b[31m text",
    },
    change: {
      kind: "read",
      value: {
        revisions: [],
        bookmarks: [],
        operations: [
          {
            operationId: "actual-operation",
            description: "squash",
            isOwn: true,
            isSnapshot: false,
          },
        ],
      },
    },
    verdict: {
      outcome: "completed",
      headline: "Squashed exact source",
      warnings: ["Read this warning"],
      notes: ["Provider consequence"],
      named: [{ label: "Destination", revision: { revisionId: "destination" } }],
    },
    isWorkingCopyStale: false,
  };
}

test("compact result preserves actual warnings, notes and conditional reversal without routine diagnostic metadata", () => {
  const result = createTestMutationResult();
  const text = mutationResultLines(result, null, false, { compact: true }).join("\n");
  expect(text).toContain("Squashed exact source");
  expect(text).toContain("Warning: Read this warning");
  expect(text).toContain("Provider consequence");
  expect(text).toContain("jj op revert actual-operation");
  expect(text).toContain("nothing since has rewritten");
  expect(text).not.toContain("Destination:");
  expect(text).not.toContain("Provider output:");
  expect(squashErrorOutputAvailable(result)).toBe(false);
});

for (const outcome of ["failed", "unexpected"] as const)
  test(`${outcome} provides sanitized full output while its inline summary stays compact`, () => {
    const result = createTestMutationResult();
    result.verdict.outcome = outcome;
    expect(squashErrorOutputAvailable(result)).toBe(true);
    const full = mutationResultLines(result, null, true).join("\n");
    expect(full).toContain("Provider output:");
    expect(full).toContain("diagnostic text");
    expect(full).not.toContain("\x1b");
    expect(mutationResultLines(result, null, false, { compact: true }).join("\n")).not.toContain(
      "Provider output:",
    );
  });

test("unread and start-failed retain output access without reinterpreting provider success", () => {
  const result = createTestMutationResult();
  result.change = { kind: "unread", reason: "readback unavailable" };
  expect(squashErrorOutputAvailable(result)).toBe(true);
  expect(result.verdict.outcome).toBe("completed");
  expect(mutationResultLines(result, null, false, { compact: true }).join("\n")).toContain(
    "readback unavailable",
  );
  expect(
    squashErrorOutputAvailable({ kind: "not-run", reason: "start-failed", text: "spawn failure" }),
  ).toBe(true);
  expect(squashErrorOutputAvailable({ kind: "not-run", reason: "cancelled" })).toBe(false);
  expect(squashErrorOutputAvailable(null)).toBe(false);
});

/** Make a plural-capable provider specimen, without changing the bundled JJ provider's arity. */
function createTestNoticeReceipt(count = 1, includeInto = false) {
  const revision = (id: string): ExtensionVcsMutationRevision => ({
    revisionId: id,
    logicalId: id + "logical",
    parents: [],
    description: id,
    bookmarks: [],
    isEmpty: false,
    hasConflict: false,
    isDivergent: false,
    isWorkingCopy: false,
    isImmutable: false,
    isRoot: false,
  });
  const sources = Array.from({ length: count }, (_, i) => revision(`source${i}`));
  const destination = revision("destination");
  const prepared: ExtensionVcsMutationPrepared = {
    handleId: "test",
    request: {
      kind: "squash",
      sources: [...sources, ...(includeInto ? [destination] : [])] as [
        ExtensionVcsMutationRevision,
        ...ExtensionVcsMutationRevision[],
      ],
      destination,
    },
    facts: {
      providerVersion: "test",
      operationId: "before",
      files: { kind: "clean" },
      revisions: [...sources, destination],
    },
    projection: { headline: "Preview", warnings: [], notes: [], named: [] },
    isInteractive: false,
  };
  return { prepared, result: createTestCleanSquashResult(prepared) };
}
for (const count of [1, 4])
  test(`clean notice counts ${count} effective sources, excludes Into and descendants`, () => {
    const { prepared, result } = createTestNoticeReceipt(count, true);
    if (result.change.kind !== "read") throw new Error("Expected readback");
    const destination = result.change.value.revisions.at(-1)!;
    result.change.value.revisions.push({
      ...destination,
      before: [{ ...destination.before[0]!, revisionId: "descendant" }],
    });
    result.verdict.notes.push("1 other revision rebased.");
    const actual = JSON.stringify(result);
    expect(cleanSquashResultNotice(result, prepared)).toBe(
      count === 1 ? "1 revision was squashed." : count + " revisions were squashed.",
    );
    expect(JSON.stringify(result)).toBe(actual);
    expect(mutationResultLines(result, prepared, true)).toContain("1 other revision rebased.");
    // A provider-supported retained empty source still counts as a transfer source.
    const source = result.change.value.revisions[0]!;
    source.after = [{ ...source.before[0]!, revisionId: "retained-empty", isEmpty: true }];
    expect(cleanSquashResultNotice(result, prepared)).not.toBeNull();
  });
const attentionCases: Record<string, (f: ReturnType<typeof createTestNoticeReceipt>) => void> = {
  failed: (f) => {
    f.result.verdict.outcome = "failed";
  },
  noop: (f) => {
    f.result.verdict.outcome = "no-op";
  },
  unexpected: (f) => {
    f.result.verdict.outcome = "unexpected";
  },
  unread: (f) => {
    f.result.change = { kind: "unread", reason: "unavailable" };
  },
  stale: (f) => {
    f.result.isWorkingCopyStale = true;
  },
  warning: (f) => {
    f.result.verdict.warnings.push("Conflict");
  },
  note: (f) => {
    f.result.verdict.notes.push("Read this consequence");
  },
  previewWarning: (f) => {
    f.prepared.projection.warnings.push("Attention");
  },
  processFailure: (f) => {
    f.result.process.exitCode = 1;
  },
  unstarted: (f) => {
    f.result.process.started = false;
  },
  interrupted: (f) => {
    f.result.process.wasInterrupted = true;
  },
  signal: (f) => {
    f.result.process.signal = "SIGINT";
  },
  restoreFailure: (f) => {
    f.result.process.terminalRestored = false;
  },
  writer: (f) => {
    if (f.result.change.kind === "read")
      f.result.change.value.operations.push({
        operationId: "other",
        isOwn: false,
        isSnapshot: false,
        description: "other writer",
      });
  },
  noOperation: (f) => {
    if (f.result.change.kind === "read") f.result.change.value.operations = [];
  },
  conflict: (f) => {
    if (f.result.change.kind === "read")
      f.result.change.value.revisions.at(-1)!.after[0]!.hasConflict = true;
  },
  divergent: (f) => {
    if (f.result.change.kind === "read")
      f.result.change.value.revisions.at(-1)!.after[0]!.isDivergent = true;
  },
  missingSource: (f) => {
    if (f.result.change.kind === "read") f.result.change.value.revisions.shift();
  },
  missingDestination: (f) => {
    if (f.result.change.kind === "read") f.result.change.value.revisions.pop();
  },
  ambiguousDestination: (f) => {
    if (f.result.change.kind === "read") {
      const entry = f.result.change.value.revisions.at(-1)!;
      entry.after.push(entry.after[0]!);
    }
  },
  unchangedSource: (f) => {
    if (f.result.change.kind === "read") {
      const entry = f.result.change.value.revisions[0]!;
      entry.after = [entry.before[0]!];
    }
  },
  unchangedDestination: (f) => {
    if (f.result.change.kind === "read") {
      const entry = f.result.change.value.revisions.at(-1)!;
      entry.after = [entry.before[0]!];
    }
  },
  ambiguousSource: (f) => {
    if (f.result.change.kind === "read")
      f.result.change.value.revisions.push(f.result.change.value.revisions[0]!);
  },
  changedPreview: (f) => {
    f.prepared.preview = { operations: [], revisions: [], bookmarks: [] };
  },
};
for (const [name, change] of Object.entries(attentionCases))
  test(`notice keeps ${name} outcome in attention`, () => {
    const f = createTestNoticeReceipt();
    f.result.verdict.notes.push("1 other revision rebased.");
    change(f);
    expect(cleanSquashResultNotice(f.result, f.prepared)).toBeNull();
  });
test("full Squash result retains exact request/readback/recovery once without the blanket safety claim", () => {
  const { result, prepared } = createTestNoticeReceipt(4);
  const text = mutationResultLines(result, prepared, true).join("\n");
  expect(text).toContain("Source: source0logical · source0");
  expect(text).toContain("Destination before: destinationlogical · destination");
  expect(text).toContain("After destinationlogical · rewritten-destination");
  expect(text.split("exact-operation")).toHaveLength(2);
  expect(text).toContain("jj op revert exact-operation");
  expect(text).toContain("Later repository changes may cause conflicts or divergence");
  expect(text).not.toContain("That stays clean only");
});

for (const note of ["2 other revisions rebased.", "12 other revisions rebased."])
  test("routine descendant completion stays compact: " + note, () => {
    const { result, prepared } = createTestNoticeReceipt();
    result.verdict.notes.push(note);
    expect(cleanSquashResultNotice(result, prepared)).toBe("1 revision was squashed.");
    expect(mutationResultLines(result, prepared, true)).toContain(note);
  });

for (const note of [
  "Bookmark main moved to the source's parent.",
  "1 other revision rebased. Check the conflict.",
  "2 other revisions rebased.\nAnother consequence",
])
  test("nonroutine completion still needs attention: " + note, () => {
    const { result, prepared } = createTestNoticeReceipt();
    result.verdict.notes.push(note);
    expect(cleanSquashResultNotice(result, prepared)).toBeNull();
  });
