import { expect, test } from "bun:test";
import type {
  ExtensionVcsMutationChange,
  ExtensionVcsMutationFacts,
  ExtensionVcsMutationProcessOutcome,
  ExtensionVcsMutationRequest,
  ExtensionVcsMutationRevision,
} from "hunkdiff/extension";
import { rebaseKind } from "./mutationRebase";
import { isJjMutationRefusal } from "./mutationKind";

/** Hand-author exact versions and logical parents independently of the kind's implementation. */
function revisionTest(
  id: string,
  logicalId = id,
  parents: string[] = ["C"],
): ExtensionVcsMutationRevision {
  return {
    revisionId: id,
    logicalId,
    parents: parents.map((id) => ({ revisionId: id, logicalId: id })),
    description: id,
    isEmpty: false,
    hasConflict: false,
    isDivergent: false,
    isWorkingCopy: false,
    isImmutable: false,
    isRoot: false,
    bookmarks: [],
  };
}
const source = revisionTest("A");
const destination = revisionTest("B");
const facts: ExtensionVcsMutationFacts = {
  providerVersion: "test",
  operationId: "old",
  revisions: [source, destination],
  files: { kind: "clean" },
};
const process: ExtensionVcsMutationProcessOutcome = {
  started: true,
  exitCode: 0,
  signal: null,
  wasInterrupted: false,
  terminal: "captured",
  terminalRestored: true,
  text: "",
};
/** Build one explicit own operation, keeping effect entries test-authored. */
function changeTest(
  before: ExtensionVcsMutationRevision[],
  after: ExtensionVcsMutationRevision[],
  other: ExtensionVcsMutationChange["revisions"] = [],
): ExtensionVcsMutationChange {
  return {
    operations: [{ operationId: "own", description: "rebase", isOwn: true, isSnapshot: false }],
    revisions: [{ logicalId: before[0]?.logicalId, before, after }, ...other],
    bookmarks: [],
  };
}
/** Build a one-source request at the public provider seam. */
function requestTest(
  placement: "onto" | "after" | "before" = "onto",
  skipEmptied = false,
): Extract<ExtensionVcsMutationRequest, { kind: "rebase" }> {
  return {
    kind: "rebase",
    sources: [{ revisionId: "A", logicalId: "A" }],
    destination: { revisionId: "B", logicalId: "B" },
    placement,
    skipEmptied,
  };
}
/** Judge against an independently supplied actual change and preview. */
function judgeTest(
  change: ExtensionVcsMutationChange | null,
  options: {
    request?: ReturnType<typeof requestTest>;
    facts?: ExtensionVcsMutationFacts;
    process?: ExtensionVcsMutationProcessOutcome;
    preview?: ExtensionVcsMutationChange | null;
  } = {},
) {
  const request = options.request ?? requestTest();
  const observed = options.facts ?? facts;
  const plan = rebaseKind.plan({ request, facts: observed });
  if (isJjMutationRefusal(plan)) throw new Error(plan.refused);
  return rebaseKind.judge({
    request,
    facts: observed,
    plan,
    process: options.process ?? process,
    change,
    preview: options.preview ?? change,
  });
}

test("Rebase builds typed exact version args and adds skip only when requested", () => {
  for (const [placement, flag] of [
    ["onto", "-o"],
    ["after", "-A"],
    ["before", "-B"],
  ] as const) {
    const request = requestTest(placement);
    const plan = rebaseKind.plan({ request, facts });
    expect(plan).toEqual({
      args: [
        "rebase",
        "-r",
        { revision: request.sources[0] },
        flag,
        { revision: request.destination },
      ],
      preview: "dry-run",
      interactive: false,
    });
    const skip = rebaseKind.plan({ request: requestTest(placement, true), facts });
    expect(isJjMutationRefusal(skip)).toBe(false);
    if (!isJjMutationRefusal(skip)) expect(skip.args.at(-1)).toBe("--skip-emptied");
  }
  const protectedFacts = {
    ...facts,
    revisions: [
      { ...source, isImmutable: true, isRoot: true },
      { ...destination, isImmutable: true },
    ],
  };
  expect(
    isJjMutationRefusal(rebaseKind.plan({ request: requestTest(), facts: protectedFacts })),
  ).toBe(false);
});
test("Rebase refuses multiple sources and identical exact source/destination", () => {
  expect(
    isJjMutationRefusal(
      rebaseKind.plan({
        request: { ...requestTest(), sources: [{ revisionId: "A" }, { revisionId: "D" }] },
        facts,
      }),
    ),
  ).toBe(true);
  expect(
    isJjMutationRefusal(
      rebaseKind.plan({ request: requestTest(), facts: { ...facts, revisions: [source, source] } }),
    ),
  ).toBe(true);
});
test("Rebase refuses failed/unknown/no-op native previews and preserves their text", () => {
  const request = requestTest();
  const plan = rebaseKind.plan({ request, facts });
  if (isJjMutationRefusal(plan)) throw new Error();
  for (const dryRun of [
    { kind: "failed", exitCode: 1, text: "JJ protected revision" },
    { kind: "no-operation", text: "Nothing changed." },
    { kind: "no-operation", text: "Unexpected output" },
  ] as const) {
    const projection = rebaseKind.project({ request, facts, plan, dryRun });
    expect(isJjMutationRefusal(projection)).toBe(true);
    if (isJjMutationRefusal(projection)) expect(projection.providerText).toBe(dryRun.text);
  }
});
test("onto/after recognize moved source and select its exact resulting version", () => {
  const moved = revisionTest("A2", "A", ["B"]);
  const change = changeTest([source], [moved]);
  for (const placement of ["onto", "after"] as const) {
    const verdict = judgeTest(change, { request: requestTest(placement) });
    expect(verdict.outcome).toBe("completed");
    expect(verdict.selectAfter).toEqual({ revisionId: "A2", logicalId: "A" });
  }
});
test("Before recognizes rewritten destination parent placement and a stayed source", () => {
  const movedDestination = revisionTest("B2", "B", ["A"]);
  const change: ExtensionVcsMutationChange = {
    operations: [{ operationId: "own", description: "rebase", isOwn: true, isSnapshot: false }],
    revisions: [{ logicalId: "B", before: [destination], after: [movedDestination] }],
    bookmarks: [],
  };
  const verdict = judgeTest(change, { request: requestTest("before") });
  expect(verdict.outcome).toBe("completed");
  expect(verdict.selectAfter).toEqual({ revisionId: "A", logicalId: "A" });
  expect(verdict.notes).toContain("1 other revision rebased.");
});
test("missing source entry does not mean abandonment; bad placement is unexpected", () => {
  const unchanged: ExtensionVcsMutationChange = {
    operations: [{ operationId: "own", description: "rebase", isOwn: true, isSnapshot: false }],
    revisions: [],
    bookmarks: [],
  };
  expect(judgeTest(unchanged).outcome).toBe("unexpected");
  expect(judgeTest(unchanged).headline).not.toContain("left history");
});
test("actual judgment first matches unread, failed/signal, then no-own operation", () => {
  expect(judgeTest(null).outcome).toBe("unexpected");
  const change = changeTest([source], [revisionTest("A2", "A", ["B"])]);
  expect(judgeTest(change, { process: { ...process, exitCode: 1 } }).outcome).toBe("failed");
  expect(judgeTest(change, { process: { ...process, signal: "SIGTERM" } }).outcome).toBe("failed");
  change.operations[0]!.isOwn = false;
  const verdict = judgeTest(change);
  expect(verdict.outcome).toBe("no-op");
  expect(verdict.warnings[0]).toContain("does not recognize as its own");
  change.revisions = [];
  expect(judgeTest(change).headline).toContain("already in that position");
});
test("source abandonment completes only when previewed and selects the proper retained endpoint", () => {
  const left = changeTest([source], []);
  expect(
    judgeTest(left, { preview: changeTest([source], [revisionTest("A2", "A", ["B"])]) }).outcome,
  ).toBe("unexpected");
  expect(judgeTest(left).selectAfter).toEqual({ revisionId: "B", logicalId: "B" });
  expect(judgeTest(left, { request: requestTest("before") }).selectAfter).toEqual({
    revisionId: "C",
    logicalId: "C",
  });
});
test("divergent sibling identity is retained without selecting an arbitrary new version", () => {
  const sibling = revisionTest("sibling", "A", ["C"]);
  const moved = revisionTest("A2", "A", ["B"]);
  expect(judgeTest(changeTest([source, sibling], [sibling, moved])).selectAfter).toEqual({
    revisionId: "A2",
    logicalId: "A",
  });
  expect(
    judgeTest(
      changeTest(
        [source, sibling],
        [revisionTest("A2", "A", ["B"]), revisionTest("A3", "A", ["B"]), sibling],
      ),
    ).outcome,
  ).toBe("unexpected");
});
test("a sibling working-copy snapshot is not mistaken for the moved source", () => {
  const sibling = { ...revisionTest("sibling", "A"), isWorkingCopy: true, description: "sibling" };
  const recorded = { ...sibling, revisionId: "recorded" };
  const moved = revisionTest("A2", "A", ["B"]);
  expect(judgeTest(changeTest([source, sibling], [recorded, moved])).selectAfter).toEqual({
    revisionId: "A2",
    logicalId: "A",
  });
});
test("semantic effects name newly conflicted/empty/abandoned revisions and bookmark moves", () => {
  const moved = revisionTest("A2", "A", ["B"]);
  const child = revisionTest("D", "D", ["A"]);
  const after = { ...revisionTest("D2", "D", ["A"]), isEmpty: true, hasConflict: true };
  const change = changeTest(
    [source],
    [moved],
    [{ logicalId: "D", before: [child], after: [after] }],
  );
  change.bookmarks.push({
    name: "topic",
    before: [{ revisionId: "A", logicalId: "A" }],
    after: [{ revisionId: "B", logicalId: "B" }],
    followsRevision: false,
    isConflicted: true,
  });
  const verdict = judgeTest(change);
  expect(verdict.notes).toContain("1 other revision rebased.");
  expect(verdict.notes.some((line) => line.includes("empty and stays"))).toBe(true);
  expect(verdict.warnings.some((line) => line.includes("conflicts"))).toBe(true);
  expect(verdict.warnings.some((line) => line.includes("Git cannot hold it"))).toBe(true);
});
