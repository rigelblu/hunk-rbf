import { describe, expect, test } from "bun:test";
import type {
  ExtensionVcsMutationChange,
  ExtensionVcsMutationFacts,
  ExtensionVcsMutationProcessOutcome,
  ExtensionVcsMutationRequest,
  ExtensionVcsMutationRevision,
} from "hunkdiff/extension";
import { isJjMutationRefusal, type JjDryRun, type JjMutationPlan } from "./mutationKind";
import { composeSquashDescription, squashKind } from "./mutationSquash";

type SquashRequest = Extract<ExtensionVcsMutationRequest, { kind: "squash" }>;

const ROOT_ID = "0".repeat(40);

/** Builds one observed revision with quiet defaults. */
function createTestRevision(
  overrides: Partial<ExtensionVcsMutationRevision> = {},
): ExtensionVcsMutationRevision {
  return {
    revisionId: "a".repeat(40),
    logicalId: "sourcechangeid",
    parents: [{ revisionId: "p".repeat(40), logicalId: "parentchangeid" }],
    description: "Source\n",
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

/** Builds the destination revision the tests squash into. */
function createTestDestination(
  overrides: Partial<ExtensionVcsMutationRevision> = {},
): ExtensionVcsMutationRevision {
  return createTestRevision({
    revisionId: "d".repeat(40),
    logicalId: "destchangeid",
    description: "Destination\n",
    ...overrides,
  });
}

/** Builds the facts in the order the kind declares: the source, then the destination. */
function createTestFacts(
  source: ExtensionVcsMutationRevision = createTestRevision(),
  destination: ExtensionVcsMutationRevision = createTestDestination(),
  files: ExtensionVcsMutationFacts["files"] = { kind: "clean" },
): ExtensionVcsMutationFacts {
  return { providerVersion: "0.46.0", operationId: "op0", revisions: [source, destination], files };
}

/** Builds the request that names one source and one destination. */
function createTestRequest(
  source: ExtensionVcsMutationRevision = createTestRevision(),
  destination: ExtensionVcsMutationRevision = createTestDestination(),
): SquashRequest {
  return {
    kind: "squash",
    sources: [{ revisionId: source.revisionId, logicalId: source.logicalId }],
    destination: { revisionId: destination.revisionId, logicalId: destination.logicalId },
  };
}

/** Builds a change in which the source left and the destination was rewritten. */
function createTestChange(
  source: ExtensionVcsMutationRevision,
  destination: ExtensionVcsMutationRevision,
  overrides: Partial<ExtensionVcsMutationChange> = {},
): ExtensionVcsMutationChange {
  return {
    operations: [
      { operationId: "op1", description: "squash commits", isSnapshot: false, isOwn: true },
    ],
    revisions: [
      { logicalId: source.logicalId, before: [source], after: [] },
      {
        logicalId: destination.logicalId,
        before: [destination],
        after: [
          { ...destination, revisionId: "e".repeat(40), description: "Destination\n\nSource\n" },
        ],
      },
    ],
    bookmarks: [],
    ...overrides,
  };
}

/** Wraps a change as the dry run the runner hands to `project`. */
function createTestDryRun(change: ExtensionVcsMutationChange): JjDryRun {
  return { kind: "change", change, text: "" };
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

/** Refers to a test revision by both ids, as the kind does. */
function refOfTest(revision: ExtensionVcsMutationRevision) {
  return { revisionId: revision.revisionId, logicalId: revision.logicalId };
}

/** The plan the confirm step and the judgement receive, with the description the fixtures compose. */
const PLAN: JjMutationPlan = {
  args: [],
  preview: "dry-run",
  interactive: false,
  description: "Destination\n\nSource\n",
};

describe("composeSquashDescription", () => {
  test("puts the destination first, one blank line, then the source", () => {
    expect(composeSquashDescription("dest\n", "src\n")).toBe("dest\n\nsrc\n");
  });

  test("keeps multi-line bodies on both sides intact", () => {
    expect(composeSquashDescription("subject\n\nbody one\n", "second\n\nbody two\n")).toBe(
      "subject\n\nbody one\n\nsecond\n\nbody two\n",
    );
  });

  test("uses the only description when the other side has none", () => {
    expect(composeSquashDescription("", "src\n")).toBe("src\n");
    expect(composeSquashDescription("dest\n", "")).toBe("dest\n");
  });

  test("stays empty when neither side has a description", () => {
    expect(composeSquashDescription("", "")).toBe("");
  });

  // Measured on jj 0.46.0: a message without a final newline is stored with one added.
  test("ends a non-empty result with the final newline Jujutsu stores", () => {
    expect(composeSquashDescription("dest", "src")).toBe("dest\n\nsrc\n");
    expect(composeSquashDescription("", "src")).toBe("src\n");
  });

  // Every expectation from here to the `JJ:` test is Jujutsu 0.46.0's own result for `jj squash`
  // with no message and an editor that accepts the combined text unchanged.
  test("keeps a description made only of spaces as a description", () => {
    expect(composeSquashDescription("  \n", "src\n")).toBe("  \n\nsrc\n");
    expect(composeSquashDescription("dest\n", "  \n")).toBe("dest\n\n  \n");
  });

  test("lets a side made only of newlines contribute nothing when both sides are set", () => {
    expect(composeSquashDescription("\n", "src\n")).toBe("src\n");
    expect(composeSquashDescription("\n\n", "src\n")).toBe("src\n");
    expect(composeSquashDescription("dest\n", "\n")).toBe("dest\n");
    expect(composeSquashDescription("\n", "\n")).toBe("");
  });

  test("keeps blank lines between the two sides", () => {
    expect(composeSquashDescription("dest\n\n", "src\n")).toBe("dest\n\n\nsrc\n");
    expect(composeSquashDescription("dest\n", "\nsrc\n")).toBe("dest\n\n\nsrc\n");
  });

  test("drops newlines at the very start and very end of the joined text", () => {
    expect(composeSquashDescription("\ndest\n", "src\n")).toBe("dest\n\nsrc\n");
    expect(composeSquashDescription("dest\n", "src\n\n")).toBe("dest\n\nsrc\n");
  });

  test("leaves the only description unchanged, edge newlines included", () => {
    expect(composeSquashDescription("", "src\n\n")).toBe("src\n\n");
    expect(composeSquashDescription("", "\nsrc\n")).toBe("\nsrc\n");
    expect(composeSquashDescription("\n", "")).toBe("\n");
    expect(composeSquashDescription(" \n", "")).toBe(" \n");
  });

  test("keeps trailing spaces and tabs on text lines", () => {
    expect(composeSquashDescription("dest  \n", "src\t\n")).toBe("dest  \n\nsrc\t\n");
  });

  // Deliberate difference: Jujutsu's editor cleanup would delete these lines.
  test("keeps a line that starts with JJ:, which is the user's text here", () => {
    expect(composeSquashDescription("JJ: note\nreal\n", "src\n")).toBe("JJ: note\nreal\n\nsrc\n");
    expect(composeSquashDescription("dest\nJJ: ignore-rest\nkept\n", "src\n")).toBe(
      "dest\nJJ: ignore-rest\nkept\n\nsrc\n",
    );
  });
});

describe("squashKind.plan", () => {
  test("observes the source and then the destination", () => {
    const request = createTestRequest();
    expect(squashKind.revisions(request)).toEqual([request.sources[0], request.destination]);
  });

  test("previews a provisional description while leaving final editing to JJ", () => {
    const request = createTestRequest();
    expect(squashKind.plan({ request, facts: createTestFacts() })).toEqual({
      args: [
        "squash",
        "--from",
        { revision: request.sources[0] },
        "--into",
        { revision: request.destination },
      ],
      previewArgs: [
        "squash",
        "--from",
        { revision: request.sources[0] },
        "--into",
        { revision: request.destination },
        "--message=Destination\n\nSource\n",
      ],
      preview: "dry-run",
      interactive: true,
      description: "Destination\n\nSource\n",
    });
  });

  test("uses an empty provisional description without forcing the final message", () => {
    const source = createTestRevision({ description: "" });
    const destination = createTestDestination({ description: "" });
    const plan = squashKind.plan({
      request: createTestRequest(source, destination),
      facts: createTestFacts(source, destination),
    });
    if (isJjMutationRefusal(plan)) throw new Error(plan.refused);
    expect(plan.previewArgs?.at(-1)).toBe("--message=");
    expect(plan.args.some((arg) => typeof arg === "string" && arg.startsWith("--message"))).toBe(
      false,
    );
    expect(plan.description).toBe("");
  });

  test("refuses more than one source", () => {
    const request: SquashRequest = {
      ...createTestRequest(),
      sources: [createTestRequest().sources[0], { revisionId: "b".repeat(40) }],
    };
    expect(squashKind.plan({ request, facts: createTestFacts() })).toEqual({
      refused: "Squash takes one revision for now.",
    });
  });

  test("refuses a source that is its own destination and facts it cannot read", () => {
    const source = createTestRevision();
    expect(
      squashKind.plan({
        request: createTestRequest(source, source),
        facts: createTestFacts(source, source),
      }),
    ).toEqual({ refused: "A revision cannot be squashed into itself." });
    expect(
      squashKind.plan({
        request: createTestRequest(),
        facts: { ...createTestFacts(), revisions: [source] },
      }),
    ).toEqual({ refused: "Hunk could not read these revisions." });
  });
});

describe("squashKind.project", () => {
  const source = createTestRevision();
  const destination = createTestDestination();
  const request = createTestRequest(source, destination);
  const facts = createTestFacts(source, destination);

  test("names both revisions and says the source is removed", () => {
    const projection = squashKind.project({
      request,
      facts,
      plan: PLAN,
      dryRun: createTestDryRun(createTestChange(source, destination)),
    });
    expect(projection).toEqual({
      headline: 'Squash sourcech "Source" into destchan "Destination"',
      notes: ["The source revision is removed."],
      warnings: [],
      named: [
        {
          label: "From",
          revision: { revisionId: source.revisionId, logicalId: "sourcechangeid" },
        },
        {
          label: "Into",
          revision: { revisionId: destination.revisionId, logicalId: "destchangeid" },
        },
      ],
    });
  });

  test("refuses when the preview is missing, failed, or not this squash", () => {
    const unreadable = { refused: "Hunk could not read JJ's preview of this squash." };
    expect(squashKind.project({ request, facts, plan: PLAN, dryRun: null })).toEqual(unreadable);
    expect(
      squashKind.project({
        request,
        facts,
        plan: PLAN,
        dryRun: { kind: "failed", exitCode: 1, text: "Error: Commit is immutable" },
      }),
    ).toEqual({ refused: "JJ will not squash this revision." });
    const sourceStays = createTestChange(source, destination, {
      revisions: [{ logicalId: source.logicalId, before: [source], after: [source] }],
    });
    expect(
      squashKind.project({ request, facts, plan: PLAN, dryRun: createTestDryRun(sourceStays) }),
    ).toEqual({ refused: "JJ's preview is not a squash of this revision into this destination." });
  });

  test("calls a dry run a no-op only for jj's own text", () => {
    const known = squashKind.project({
      request,
      facts,
      plan: PLAN,
      dryRun: { kind: "no-operation", text: "Nothing changed.\n" },
    });
    if (isJjMutationRefusal(known)) throw new Error(known.refused);
    expect(known.headline).toBe(
      'Nothing to squash: JJ would change nothing for sourcech "Source".',
    );
    expect(
      squashKind.project({
        request,
        facts,
        plan: PLAN,
        dryRun: { kind: "no-operation", text: "Nothing changed. Probably." },
      }),
    ).toEqual({ refused: "Hunk could not read JJ's preview of this squash." });
  });

  test("notes an empty source, rebased revisions, a divergent source and a new working copy", () => {
    const emptySource = createTestRevision({ isEmpty: true, isDivergent: true });
    const child = createTestRevision({ revisionId: "c".repeat(40), logicalId: "childchangeid" });
    const change = createTestChange(emptySource, destination);
    change.revisions.push(
      {
        logicalId: child.logicalId,
        before: [child],
        after: [{ ...child, parents: [{ revisionId: "e".repeat(40) }], hasConflict: true }],
      },
      {
        logicalId: "newworkingcopy",
        before: [],
        after: [createTestRevision({ revisionId: "f".repeat(40), isWorkingCopy: true })],
      },
    );
    const projection = squashKind.project({
      request: createTestRequest(emptySource, destination),
      facts: createTestFacts(emptySource, destination),
      plan: PLAN,
      dryRun: createTestDryRun(change),
    });
    if (isJjMutationRefusal(projection)) throw new Error(projection.refused);
    expect(projection.notes).toEqual([
      "The source revision is removed.",
      "The source has no changes. Only its description moves.",
      "1 other revision will be rebased.",
      "Only this version is squashed. Another version of the change stays.",
      "JJ creates a new empty working-copy revision.",
    ]);
    expect(projection.warnings).toEqual(["JJ will create conflicts in 1 other revision."]);
  });

  test("warns about pending working-copy files and a conflicted destination", () => {
    const workingCopy = createTestRevision({ isWorkingCopy: true });
    const change = createTestChange(workingCopy, destination);
    change.revisions[1]!.after = [{ ...change.revisions[1]!.after[0]!, hasConflict: true }];
    const projection = squashKind.project({
      request: createTestRequest(workingCopy, destination),
      facts: createTestFacts(workingCopy, destination, {
        kind: "pending",
        paths: ["b.txt", "new.txt", "old.txt"],
      }),
      plan: PLAN,
      dryRun: createTestDryRun(change),
    });
    if (isJjMutationRefusal(projection)) throw new Error(projection.refused);
    expect(projection.warnings).toEqual([
      "This is the working-copy revision. Its unrecorded changes to 3 files move into the destination.",
      "JJ will create conflicts in the destination.",
    ]);
  });

  test("does not count a working copy jj only recorded as rebased", () => {
    const workingCopy = createTestRevision({
      revisionId: "w".repeat(40),
      logicalId: "workingcopyid",
      isWorkingCopy: true,
    });
    const change = createTestChange(source, destination);
    change.revisions.push({
      logicalId: workingCopy.logicalId,
      before: [workingCopy],
      after: [{ ...workingCopy, revisionId: "x".repeat(40) }],
    });
    const projection = squashKind.project({
      request,
      facts,
      plan: PLAN,
      dryRun: createTestDryRun(change),
    });
    if (isJjMutationRefusal(projection)) throw new Error(projection.refused);
    expect(projection.notes).toEqual(["The source revision is removed."]);
  });

  test("does not call a working copy with pending files empty", () => {
    const workingCopy = createTestRevision({ isWorkingCopy: true, isEmpty: true });
    const projection = squashKind.project({
      request: createTestRequest(workingCopy, destination),
      facts: createTestFacts(workingCopy, destination, { kind: "pending", paths: ["b.txt"] }),
      plan: PLAN,
      dryRun: createTestDryRun(createTestChange(workingCopy, destination)),
    });
    if (isJjMutationRefusal(projection)) throw new Error(projection.refused);
    expect(projection.notes).toEqual(["The source revision is removed."]);
    expect(projection.warnings).toEqual([
      "This is the working-copy revision. Its unrecorded changes to 1 file move into the destination.",
    ]);
  });

  test("refuses a preview that stores another description or leaves the destination as it was", () => {
    const otherDescription = createTestChange(source, destination);
    otherDescription.revisions[1]!.after = [
      { ...otherDescription.revisions[1]!.after[0]!, description: "Something else\n" },
    ];
    expect(
      squashKind.project({
        request,
        facts,
        plan: PLAN,
        dryRun: createTestDryRun(otherDescription),
      }),
    ).toEqual({ refused: "JJ's preview stores a different description than the one composed." });
    const destinationStays = createTestChange(source, destination);
    destinationStays.revisions[1]!.after = [destination];
    expect(
      squashKind.project({
        request,
        facts,
        plan: PLAN,
        dryRun: createTestDryRun(destinationStays),
      }),
    ).toEqual({ refused: "JJ's preview is not a squash of this revision into this destination." });
  });

  test("shows trailers jj adds to the description as a note and still projects", () => {
    const change = createTestChange(source, destination);
    change.revisions[1]!.after = [
      {
        ...change.revisions[1]!.after[0]!,
        description: "Destination\n\nSource\n\nSigned-off-by: Test <test@example.com>\n",
      },
    ];
    const projection = squashKind.project({
      request,
      facts,
      plan: PLAN,
      dryRun: createTestDryRun(change),
    });
    if (isJjMutationRefusal(projection)) throw new Error(projection.refused);
    expect(projection.notes).toEqual([
      "The source revision is removed.",
      "JJ adds your configured trailers to the description: Signed-off-by: Test <test@example.com>",
    ]);
    const verdict = squashKind.judge({
      request,
      facts,
      plan: PLAN,
      process: createTestProcess(),
      preview: null,
      change,
    });
    expect(verdict.outcome).toBe("completed");
    expect(verdict.warnings).toEqual([]);
  });

  test("words where jj leaves the source's bookmarks and skips one that only followed", () => {
    const change = createTestChange(source, destination, {
      bookmarks: [
        {
          name: "topic",
          before: [{ revisionId: source.revisionId }],
          after: [{ revisionId: "p".repeat(40) }],
          isConflicted: false,
          followsRevision: false,
        },
        {
          name: "main",
          before: [{ revisionId: destination.revisionId }],
          after: [{ revisionId: "e".repeat(40) }],
          isConflicted: false,
          followsRevision: true,
        },
        {
          name: "merged",
          remote: "origin",
          before: [{ revisionId: source.revisionId }],
          after: [{ revisionId: "l".repeat(40) }, { revisionId: "r".repeat(40) }],
          isConflicted: true,
          followsRevision: false,
        },
        {
          name: "rooted",
          before: [{ revisionId: source.revisionId }],
          after: [{ revisionId: ROOT_ID }],
          isConflicted: false,
          followsRevision: false,
        },
      ],
    });
    const projection = squashKind.project({
      request,
      facts,
      plan: PLAN,
      dryRun: createTestDryRun(change),
    });
    if (isJjMutationRefusal(projection)) throw new Error(projection.refused);
    expect(projection.notes).toEqual([
      "The source revision is removed.",
      "Bookmark topic moves to the source's parent.",
      "JJ leaves the source's bookmarks on the source's parents. Hunk moves none.",
    ]);
    expect(projection.warnings).toEqual([
      "Bookmark merged@origin will be conflicted. Git cannot hold it.",
      "Bookmark rooted will point at the root revision. Git cannot hold it.",
    ]);
  });
});

describe("squashKind.judge", () => {
  const source = createTestRevision();
  const destination = createTestDestination();
  const request = createTestRequest(source, destination);
  const facts = createTestFacts(source, destination);
  const judge = (change: ExtensionVcsMutationChange | null, process = createTestProcess()) =>
    squashKind.judge({ request, facts, plan: PLAN, process, preview: null, change });

  test("completes and selects the destination as rewritten", () => {
    const verdict = judge(createTestChange(source, destination));
    expect(verdict.outcome).toBe("completed");
    expect(verdict.headline).toBe('Squashed sourcech "Source" into destchan "Destination"');
    expect(verdict.selectAfter).toEqual({
      revisionId: "e".repeat(40),
      logicalId: "destchangeid",
    });
    expect(verdict.warnings).toEqual([]);
  });

  test("completes with a warning that names a conflict in the destination", () => {
    const change = createTestChange(source, destination);
    change.revisions[1]!.after = [{ ...change.revisions[1]!.after[0]!, hasConflict: true }];
    const verdict = judge(change);
    expect(verdict.outcome).toBe("completed");
    expect(verdict.warnings).toEqual(["JJ created conflicts in the destination."]);
  });

  test("is a no-op when the run recorded no operation of its own beyond a snapshot", () => {
    const verdict = judge(
      createTestChange(source, destination, {
        operations: [
          { operationId: "op1", description: "snapshot", isSnapshot: true, isOwn: true },
          { operationId: "op2", description: "other writer", isSnapshot: false, isOwn: false },
        ],
        revisions: [],
      }),
    );
    expect(verdict.outcome).toBe("no-op");
    expect(verdict.selectAfter).toBeUndefined();
  });

  test("fails on a non-zero exit, even after a snapshot", () => {
    const verdict = judge(
      createTestChange(source, destination, {
        operations: [
          { operationId: "op1", description: "snapshot", isSnapshot: true, isOwn: true },
        ],
        revisions: [],
      }),
      createTestProcess(1),
    );
    expect(verdict.outcome).toBe("failed");
    expect(verdict.headline).toBe('JJ did not squash sourcech "Source".');
  });

  test("is unexpected when the read-back failed or is not the confirmed squash", () => {
    expect(judge(null).outcome).toBe("unexpected");
    const sourceStays = createTestChange(source, destination, {
      revisions: [{ logicalId: source.logicalId, before: [source], after: [source] }],
    });
    expect(judge(sourceStays)).toMatchObject({
      outcome: "unexpected",
      headline: "JJ ran, but the result is not the squash that was confirmed.",
    });
  });

  test("is unexpected when the change has no entry for the source or the destination stayed", () => {
    const noSourceEntry = createTestChange(source, destination);
    noSourceEntry.revisions.shift();
    expect(judge(noSourceEntry).outcome).toBe("unexpected");
    const destinationStays = createTestChange(source, destination);
    destinationStays.revisions[1]!.after = [destination];
    expect(judge(destinationStays).outcome).toBe("unexpected");
  });

  test("selects a divergent destination's rewritten version by its description, not its position", () => {
    const otherVersion = createTestDestination({
      revisionId: "o".repeat(40),
      description: "Other version\n",
      isDivergent: true,
    });
    const change = createTestChange(source, destination);
    const rewritten = change.revisions[1]!.after[0]!;
    change.revisions[1] = {
      logicalId: destination.logicalId,
      before: [otherVersion, destination],
      after: [{ ...otherVersion, revisionId: "n".repeat(40), hasConflict: true }, rewritten],
    };
    const verdict = judge(change);
    expect(verdict.outcome).toBe("completed");
    expect(verdict.selectAfter).toEqual(refOfTest(rewritten));
    expect(verdict.warnings).toEqual([]);
  });

  test("completes with a warning when the stored description differs", () => {
    const change = createTestChange(source, destination);
    change.revisions[1]!.after = [
      { ...change.revisions[1]!.after[0]!, description: "Something else\n" },
    ];
    const verdict = judge(change);
    expect(verdict.outcome).toBe("completed");
    expect(verdict.warnings).toEqual([
      "The destination's description is not the one shown at confirmation. Read it in the history.",
    ]);
  });

  test("says the repository changed when jj fails after its own operation", () => {
    const verdict = judge(createTestChange(source, destination), createTestProcess(1));
    expect(verdict.outcome).toBe("failed");
    expect(verdict.headline).toBe(
      'JJ reported a failure after it changed the repository while squashing sourcech "Source".',
    );
  });

  test("is unexpected when the source was rewritten instead of removed", () => {
    const sourceRewritten = createTestChange(source, destination);
    sourceRewritten.revisions[0]!.after = [{ ...source, revisionId: "s".repeat(40) }];
    expect(judge(sourceRewritten).outcome).toBe("unexpected");
    expect(
      squashKind.project({
        request,
        facts,
        plan: PLAN,
        dryRun: createTestDryRun(sourceRewritten),
      }),
    ).toEqual({ refused: "JJ's preview is not a squash of this revision into this destination." });
  });

  test("is unexpected when only another version of the destination's change was rewritten", () => {
    const sibling = createTestDestination({ revisionId: "o".repeat(40), isDivergent: true });
    const change = createTestChange(source, destination);
    change.revisions[1] = {
      logicalId: destination.logicalId,
      before: [destination, sibling],
      after: [{ ...sibling, revisionId: "n".repeat(40) }],
    };
    expect(judge(change).outcome).toBe("unexpected");
  });

  test("completes when the source and the destination share one change id", () => {
    const sharedSource = createTestRevision({ logicalId: "destchangeid", isDivergent: true });
    const change = createTestChange(sharedSource, destination);
    const rewritten = change.revisions[1]!.after[0]!;
    change.revisions = [
      { logicalId: "destchangeid", before: [sharedSource, destination], after: [rewritten] },
    ];
    const verdict = squashKind.judge({
      request: createTestRequest(sharedSource, destination),
      facts: createTestFacts(sharedSource, destination),
      plan: PLAN,
      process: createTestProcess(),
      preview: null,
      change,
    });
    expect(verdict.outcome).toBe("completed");
    expect(verdict.selectAfter).toEqual(refOfTest(rewritten));
  });

  test("warns about a conflict in a divergent bystander and leaves the highlight when it cannot tell", () => {
    const onSource = createTestRevision({
      revisionId: "1".repeat(40),
      logicalId: "bystanderid",
      parents: [{ revisionId: source.revisionId }],
    });
    const onParent = createTestRevision({ revisionId: "2".repeat(40), logicalId: "bystanderid" });
    const change = createTestChange(source, destination);
    const rewritten = change.revisions[1]!.after[0]!;
    change.revisions[1]!.before = [destination, { ...destination, revisionId: "3".repeat(40) }];
    change.revisions[1]!.after = [rewritten, { ...rewritten, revisionId: "4".repeat(40) }];
    change.revisions.push({
      logicalId: "bystanderid",
      before: [onSource, onParent],
      after: [{ ...onSource, parents: onParent.parents, hasConflict: true }, onParent],
    });
    const verdict = judge(change);
    expect(verdict.outcome).toBe("completed");
    expect(verdict.selectAfter).toBeUndefined();
    expect(verdict.warnings).toEqual([
      "Hunk cannot tell which version of the destination JJ rewrote. Check it in the history.",
      "JJ created conflicts in 1 other revision.",
    ]);
  });

  test("never offers undo or promises a clean reversal in its own words", () => {
    const change = createTestChange(source, destination);
    const texts = [
      judge(change),
      judge(null),
      judge(change, createTestProcess(1)),
      judge(createTestChange(source, destination, { revisions: [] }), createTestProcess(1)),
      squashKind.project({ request, facts, plan: PLAN, dryRun: createTestDryRun(change) }),
    ].flatMap((result) =>
      "refused" in result
        ? [result.refused]
        : [result.headline, ...result.notes, ...result.warnings],
    );
    for (const text of texts) expect(text).not.toMatch(/undo|revert|clean/i);
  });
});

test("Squash accepts an intentional editor description without a mismatch warning", () => {
  const source = createTestRevision();
  const destination = createTestDestination();
  const change = createTestChange(source, destination);
  change.revisions[1]!.after[0] = {
    ...change.revisions[1]!.after[0]!,
    description: "Chosen in editor\n",
  };
  const verdict = squashKind.judge({
    request: createTestRequest(source, destination),
    facts: createTestFacts(source, destination),
    plan: { ...PLAN, interactive: true },
    process: createTestProcess(),
    preview: null,
    change,
  });
  expect(verdict.outcome).toBe("completed");
  expect(verdict.warnings).toEqual([]);
  expect(verdict.selectAfter?.revisionId).toBe(change.revisions[1]!.after[0]!.revisionId);
});
