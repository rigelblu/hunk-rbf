import { describe, expect, test } from "bun:test";
import type {
  ExtensionVcsMutationChange,
  ExtensionVcsMutationFacts,
  ExtensionVcsMutationProcessOutcome,
  ExtensionVcsMutationRequest,
  ExtensionVcsMutationRevision,
} from "hunkdiff/extension";
import { abandonKind } from "./mutationAbandon";
import { isJjMutationRefusal, type JjMutationPlan } from "./mutationKind";

type AbandonRequest = Extract<ExtensionVcsMutationRequest, { kind: "abandon" }>;

const ROOT_ID = "0".repeat(40);

/** Builds one observed revision with quiet defaults. */
function createTestRevision(
  overrides: Partial<ExtensionVcsMutationRevision> = {},
): ExtensionVcsMutationRevision {
  return {
    revisionId: "a".repeat(40),
    logicalId: "sourcechangeid",
    parents: [{ revisionId: "p".repeat(40), logicalId: "parentchangeid" }],
    description: "two\n\nbody",
    isEmpty: false,
    hasConflict: false,
    isDivergent: false,
    isWorkingCopy: false,
    isImmutable: false,
    isRoot: false,
    bookmarks: [],
    ...overrides,
  };
}

/** Builds the facts for one source revision. */
function createTestFacts(
  source: ExtensionVcsMutationRevision = createTestRevision(),
  files: ExtensionVcsMutationFacts["files"] = { kind: "clean" },
): ExtensionVcsMutationFacts {
  return { providerVersion: "0.46.0", operationId: "op0", revisions: [source], files };
}

/** Builds the request that names one source. */
function createTestRequest(source: ExtensionVcsMutationRevision): AbandonRequest {
  return {
    kind: "abandon",
    sources: [{ revisionId: source.revisionId, logicalId: source.logicalId }],
  };
}

/** Builds a change in which the source left and nothing else moved. */
function createTestChange(
  source: ExtensionVcsMutationRevision,
  overrides: Partial<ExtensionVcsMutationChange> = {},
): ExtensionVcsMutationChange {
  return {
    operations: [
      { operationId: "op1", description: "abandon commit", isSnapshot: false, isOwn: true },
    ],
    revisions: [{ logicalId: source.logicalId, before: [source], after: [] }],
    bookmarks: [],
    ...overrides,
  };
}

/** Builds how a captured command ended. */
function createTestProcess(exitCode: number | null = 0): ExtensionVcsMutationProcessOutcome {
  return {
    started: true,
    exitCode,
    signal: null,
    wasInterrupted: false,
    terminal: "captured",
    terminalRestored: true,
    text: "",
  };
}

const PLAN: JjMutationPlan = { args: [], preview: "dry-run", interactive: false };

describe("abandonKind.plan", () => {
  test("plans a dry run of abandon that retains bookmarks", () => {
    const source = createTestRevision();
    const request = createTestRequest(source);
    expect(abandonKind.revisions(request)).toEqual(request.sources);
    expect(abandonKind.plan({ request, facts: createTestFacts(source) })).toEqual({
      args: ["abandon", "--retain-bookmarks", { revision: request.sources[0] }],
      preview: "dry-run",
      interactive: false,
    });
  });

  test("refuses more than one source", () => {
    const source = createTestRevision();
    const other = { revisionId: "b".repeat(40) };
    const request: AbandonRequest = {
      kind: "abandon",
      sources: [createTestRequest(source).sources[0], other],
    };
    expect(abandonKind.plan({ request, facts: createTestFacts(source) })).toEqual({
      refused: "Abandon takes one revision for now.",
    });
  });

  test("refuses the root revision", () => {
    const root = createTestRevision({
      revisionId: ROOT_ID,
      isRoot: true,
      isImmutable: true,
      parents: [],
    });
    expect(
      abandonKind.plan({ request: createTestRequest(root), facts: createTestFacts(root) }),
    ).toEqual({
      refused: "The root revision cannot be abandoned.",
    });
  });

  test("leaves an immutable revision to jj's dry run", () => {
    const source = createTestRevision({ isImmutable: true });
    const plan = abandonKind.plan({
      request: createTestRequest(source),
      facts: createTestFacts(source),
    });
    expect(isJjMutationRefusal(plan)).toBe(false);
  });
});

describe("abandonKind.project", () => {
  const source = createTestRevision();
  const request = createTestRequest(source);
  const facts = createTestFacts(source);

  test("names the source and what moves with it", () => {
    const child = createTestRevision({
      parents: [{ revisionId: source.revisionId, logicalId: source.logicalId }],
      revisionId: "c".repeat(40),
      logicalId: "childchangeid",
      description: "three",
    });
    const change = createTestChange(source, {
      revisions: [
        { logicalId: source.logicalId, before: [source], after: [] },
        {
          logicalId: child.logicalId,
          before: [child],
          after: [{ ...child, revisionId: "d".repeat(40), parents: source.parents }],
        },
      ],
      bookmarks: [
        {
          name: "feature",
          before: [{ revisionId: source.revisionId }],
          after: [{ revisionId: "p".repeat(40) }],
          isConflicted: false,
          followsRevision: false,
        },
        {
          name: "tip",
          before: [{ revisionId: child.revisionId }],
          after: [{ revisionId: "d".repeat(40) }],
          isConflicted: false,
          followsRevision: true,
        },
      ],
    });
    expect(
      abandonKind.project({
        request,
        facts,
        plan: PLAN,
        dryRun: { kind: "change", change, text: "" },
      }),
    ).toEqual({
      headline: 'Abandon sourcech "two"',
      notes: [
        "1 descendant will be rebased onto its parent.",
        "Bookmark feature moves to the parent.",
      ],
      warnings: [],
      named: [{ label: "Source", revision: request.sources[0] }],
    });
  });

  test("warns when a retained bookmark lands where Git cannot hold it", () => {
    const change = createTestChange(source, {
      bookmarks: [
        {
          name: "feature",
          before: [{ revisionId: source.revisionId }],
          after: [{ revisionId: ROOT_ID }],
          isConflicted: false,
          followsRevision: false,
        },
        {
          name: "main",
          remote: "origin",
          before: [{ revisionId: source.revisionId }],
          after: [{ revisionId: "p".repeat(40) }, { revisionId: "q".repeat(40) }],
          isConflicted: true,
          followsRevision: false,
        },
      ],
    });
    const projection = abandonKind.project({
      request,
      facts,
      plan: PLAN,
      dryRun: { kind: "change", change, text: "" },
    });
    expect(projection).toMatchObject({
      warnings: [
        "Bookmark feature will point at the root revision. Git cannot hold it.",
        "Bookmark main@origin will be conflicted. Git cannot hold it.",
      ],
    });
  });

  test("warns that pending edits leave the files when the source is the working copy", () => {
    const workingCopy = createTestRevision({ isWorkingCopy: true, description: "" });
    const pendingFacts = createTestFacts(workingCopy, {
      kind: "pending",
      paths: ["a.txt", "b.txt"],
    });
    const created = createTestRevision({
      revisionId: "e".repeat(40),
      logicalId: "newchangeid",
      description: "",
      isEmpty: true,
      isWorkingCopy: true,
    });
    const change = createTestChange(workingCopy, {
      revisions: [
        { logicalId: workingCopy.logicalId, before: [workingCopy], after: [] },
        { logicalId: created.logicalId, before: [], after: [created] },
      ],
    });
    expect(
      abandonKind.project({
        request: createTestRequest(workingCopy),
        facts: pendingFacts,
        plan: PLAN,
        dryRun: { kind: "change", change, text: "" },
      }),
    ).toMatchObject({
      headline: "Abandon sourcech (no description)",
      notes: ["JJ creates a new empty working-copy revision on its parent."],
      warnings: [
        "This is the working-copy revision. Abandoning it takes its unrecorded changes to 2 files out of your files.",
      ],
    });
  });

  test("warns about descendants that gain conflicts", () => {
    const child = createTestRevision({
      parents: [{ revisionId: source.revisionId, logicalId: source.logicalId }],
      revisionId: "c".repeat(40),
      logicalId: "childchangeid",
    });
    const change = createTestChange(source, {
      revisions: [
        { logicalId: source.logicalId, before: [source], after: [] },
        {
          logicalId: child.logicalId,
          before: [child],
          after: [
            { ...child, revisionId: "d".repeat(40), hasConflict: true, parents: source.parents },
          ],
        },
      ],
    });
    expect(
      abandonKind.project({
        request,
        facts,
        plan: PLAN,
        dryRun: { kind: "change", change, text: "" },
      }),
    ).toMatchObject({
      warnings: ["JJ will create conflicts in 1 descendant."],
    });
  });

  test("refuses a preview that rewrites the source or removes every version of a divergent change", () => {
    const rewritten = createTestChange(source, {
      revisions: [
        {
          logicalId: source.logicalId,
          before: [source],
          after: [{ ...source, revisionId: "g".repeat(40) }],
        },
      ],
    });
    const other = createTestRevision({ revisionId: "f".repeat(40), isDivergent: true });
    const divergent = { ...source, isDivergent: true };
    const bothLeft = createTestChange(divergent, {
      revisions: [{ logicalId: source.logicalId, before: [divergent, other], after: [] }],
    });
    for (const change of [rewritten, bothLeft]) {
      expect(
        abandonKind.project({
          request,
          facts: createTestFacts(change === bothLeft ? divergent : source),
          plan: PLAN,
          dryRun: { kind: "change", change, text: "" },
        }),
      ).toEqual({ refused: "JJ's preview does not abandon this revision." });
    }
  });

  test("says another version stays only when the preview keeps one", () => {
    const other = createTestRevision({ revisionId: "f".repeat(40), isDivergent: true });
    const divergent = { ...source, isDivergent: true };
    const change = createTestChange(divergent, {
      revisions: [
        {
          logicalId: source.logicalId,
          before: [divergent, other],
          after: [{ ...other, isDivergent: false }],
        },
      ],
    });
    expect(
      abandonKind.project({
        request,
        facts: createTestFacts(divergent),
        plan: PLAN,
        dryRun: { kind: "change", change, text: "" },
      }),
    ).toMatchObject({
      notes: ["Only this version is abandoned. Another version of the change stays."],
    });
  });

  test("does not call a working copy that jj only recorded a rebased descendant", () => {
    const workingCopy = createTestRevision({
      revisionId: "c".repeat(40),
      logicalId: "workingcopyid",
      isWorkingCopy: true,
    });
    const change = createTestChange(source, {
      operations: [
        { operationId: "op1", description: "snapshot working copy", isSnapshot: true, isOwn: true },
        { operationId: "op2", description: "abandon commit", isSnapshot: false, isOwn: true },
      ],
      revisions: [
        { logicalId: source.logicalId, before: [source], after: [] },
        {
          logicalId: workingCopy.logicalId,
          before: [workingCopy],
          after: [{ ...workingCopy, revisionId: "d".repeat(40) }],
        },
      ],
    });
    const dryRun = { kind: "change", change, text: "" } as const;
    expect(abandonKind.project({ request, facts, plan: PLAN, dryRun })).toMatchObject({
      notes: [],
    });
    const verdict = abandonKind.judge({
      request,
      facts,
      plan: PLAN,
      process: createTestProcess(),
      preview: null,
      change,
    });
    expect(verdict).toMatchObject({ outcome: "completed", notes: [] });
  });

  test("words a bookmark from where it ends up", () => {
    const bookmark = (name: string, after: string[]) => ({
      name,
      before: [{ revisionId: source.revisionId }],
      after: after.map((revisionId) => ({ revisionId })),
      isConflicted: false,
      followsRevision: false,
    });
    const change = createTestChange(source, {
      bookmarks: [
        bookmark("gone", []),
        bookmark("elsewhere", ["9".repeat(40)]),
        bookmark("kept", ["p".repeat(40)]),
      ],
    });
    expect(
      abandonKind.project({
        request,
        facts,
        plan: PLAN,
        dryRun: { kind: "change", change, text: "" },
      }),
    ).toMatchObject({
      notes: [
        "Bookmark gone will be removed.",
        "Bookmark elsewhere moves.",
        "Bookmark kept moves to the parent.",
      ],
    });
  });

  test("counts every descendant of the source, and nothing that only jj's snapshot rewrote", () => {
    const child = createTestRevision({
      revisionId: "c".repeat(40),
      logicalId: "childchangeid",
      parents: [{ revisionId: source.revisionId, logicalId: source.logicalId }],
    });
    // A grandchild keeps its parent's change id; only the parent's commit id changes.
    const grandchild = createTestRevision({
      revisionId: "e".repeat(40),
      logicalId: "grandchangeid",
      parents: [{ revisionId: child.revisionId, logicalId: child.logicalId }],
    });
    // Elsewhere: a working copy jj recorded, and its child, which gets a new parent id as well.
    const workingCopy = createTestRevision({
      revisionId: "1".repeat(40),
      logicalId: "workingcopyid",
      isWorkingCopy: true,
    });
    const besideIt = createTestRevision({
      revisionId: "2".repeat(40),
      logicalId: "besidechangeid",
      parents: [{ revisionId: workingCopy.revisionId, logicalId: workingCopy.logicalId }],
    });
    const rewrite = (revision: typeof source, id: string, parent: string) => ({
      ...revision,
      revisionId: id.repeat(40),
      parents: [{ revisionId: parent.repeat(40), logicalId: revision.parents[0]!.logicalId }],
    });
    const change = createTestChange(source, {
      revisions: [
        { logicalId: source.logicalId, before: [source], after: [] },
        { logicalId: child.logicalId, before: [child], after: [rewrite(child, "d", "p")] },
        {
          logicalId: grandchild.logicalId,
          before: [grandchild],
          after: [rewrite(grandchild, "f", "d")],
        },
        {
          logicalId: workingCopy.logicalId,
          before: [workingCopy],
          after: [{ ...workingCopy, revisionId: "3".repeat(40) }],
        },
        { logicalId: besideIt.logicalId, before: [besideIt], after: [rewrite(besideIt, "4", "3")] },
      ],
    });
    expect(
      abandonKind.project({
        request,
        facts,
        plan: PLAN,
        dryRun: { kind: "change", change, text: "" },
      }),
    ).toMatchObject({ notes: ["2 descendants will be rebased onto its parent."] });
  });

  test("turns a failed dry run into one plain sentence", () => {
    const dryRun = {
      kind: "failed",
      exitCode: 1,
      text: "Error: Commit 1234 is immutable",
    } as const;
    expect(abandonKind.project({ request, facts, plan: PLAN, dryRun })).toEqual({
      refused: "JJ will not abandon this revision.",
    });
  });

  test("calls a dry run without an operation a no-op only for jj's known text", () => {
    const known = abandonKind.project({
      request,
      facts,
      plan: PLAN,
      dryRun: { kind: "no-operation", text: "No revisions to abandon.\n" },
    });
    expect(known).toMatchObject({
      headline: 'Nothing to abandon: JJ no longer sees sourcech "two".',
    });

    const reworded = abandonKind.project({
      request,
      facts,
      plan: PLAN,
      dryRun: { kind: "no-operation", text: "Done.\n" },
    });
    expect(reworded).toEqual({ refused: "Hunk could not read JJ's preview of this abandon." });
  });

  test("refuses a preview in which the source stays", () => {
    const change = createTestChange(source, { revisions: [] });
    expect(
      abandonKind.project({
        request,
        facts,
        plan: PLAN,
        dryRun: { kind: "change", change, text: "" },
      }),
    ).toEqual({
      refused: "JJ's preview does not abandon this revision.",
    });
  });
});

describe("abandonKind.judge", () => {
  const source = createTestRevision();
  const request = createTestRequest(source);
  const facts = createTestFacts(source);
  const judge = (change: ExtensionVcsMutationChange | null, exitCode: number | null = 0) =>
    abandonKind.judge({
      request,
      facts,
      plan: PLAN,
      process: createTestProcess(exitCode),
      preview: null,
      change,
    });

  test("completes when the observed version left, and selects its first parent", () => {
    expect(judge(createTestChange(source))).toEqual({
      outcome: "completed",
      headline: 'Abandoned sourcech "two"',
      notes: [],
      warnings: [],
      named: [{ label: "Source", revision: request.sources[0] }],
      selectAfter: source.parents[0],
    });
  });

  test("completes for a divergent source whose other version stays", () => {
    const other = createTestRevision({ revisionId: "f".repeat(40), isDivergent: true });
    const divergent = { ...source, isDivergent: true };
    const change = createTestChange(divergent, {
      revisions: [
        {
          logicalId: source.logicalId,
          before: [divergent, other],
          after: [{ ...other, isDivergent: false }],
        },
      ],
    });
    expect(judge(change).outcome).toBe("completed");
  });

  test("is unexpected when the read-back failed, whatever the exit code", () => {
    expect(judge(null, 1)).toMatchObject({
      outcome: "unexpected",
      headline: "Hunk could not read back the result of this abandon.",
    });
  });

  test("is failed when jj exits non-zero, even with a recorded snapshot", () => {
    const change = createTestChange(source, {
      operations: [
        { operationId: "op1", description: "snapshot working copy", isSnapshot: true, isOwn: true },
      ],
      revisions: [],
    });
    expect(judge(change, 1).outcome).toBe("failed");
    expect(judge(change, null).outcome).toBe("failed");
  });

  test("is a no-op when no own operation other than a snapshot was recorded", () => {
    const snapshotOnly = createTestChange(source, {
      operations: [
        { operationId: "op1", description: "snapshot working copy", isSnapshot: true, isOwn: true },
      ],
      revisions: [],
    });
    const foreign = createTestChange(source, {
      operations: [
        { operationId: "op1", description: "abandon commit", isSnapshot: false, isOwn: false },
      ],
    });
    expect(judge(snapshotOnly).outcome).toBe("no-op");
    expect(judge(foreign).outcome).toBe("no-op");
    expect(judge({ operations: [], revisions: [], bookmarks: [] }).outcome).toBe("no-op");
  });

  test("speaks for the command only when it changed nothing", () => {
    // Another writer's operation removed the source; the command itself had nothing to do.
    const foreign = createTestChange(source, {
      operations: [
        { operationId: "op1", description: "import git refs", isSnapshot: false, isOwn: false },
      ],
    });
    expect(judge(foreign)).toMatchObject({
      outcome: "no-op",
      headline: "JJ had nothing to abandon.",
    });
  });

  test("says so, and selects the parent, when another operation removed the source", () => {
    const foreign = createTestChange(source, {
      operations: [
        { operationId: "op1", description: "import git head", isSnapshot: false, isOwn: false },
      ],
    });
    expect(judge(foreign)).toEqual({
      outcome: "no-op",
      headline: "JJ had nothing to abandon.",
      notes: [],
      warnings: ["Another operation removed this revision while the command ran."],
      named: [{ label: "Source", revision: request.sources[0] }],
      selectAfter: source.parents[0],
    });
    // Nothing left: nothing to warn about, and the highlight stays where it was.
    const untouched = { operations: [], revisions: [], bookmarks: [] };
    expect(judge(untouched)).toMatchObject({ outcome: "no-op", warnings: [] });
    expect(judge(untouched).selectAfter).toBeUndefined();
  });

  test("does not deny an abandon that happened when jj also reported an error", () => {
    expect(judge(createTestChange(source), 1)).toMatchObject({
      outcome: "failed",
      headline: 'JJ reported an error, and sourcech "two" was abandoned.',
    });
    expect(judge(createTestChange(source, { revisions: [] }), 1)).toMatchObject({
      outcome: "failed",
      headline: 'JJ did not abandon sourcech "two".',
    });
  });

  test("is unexpected when an own operation ran and the source is still there", () => {
    const stayed = createTestChange(source, { revisions: [] });
    const rewritten = createTestChange(source, {
      revisions: [
        {
          logicalId: source.logicalId,
          before: [source],
          after: [{ ...source, revisionId: "g".repeat(40) }],
        },
      ],
    });
    expect(judge(stayed).outcome).toBe("unexpected");
    expect(judge(rewritten).outcome).toBe("unexpected");
  });
});
