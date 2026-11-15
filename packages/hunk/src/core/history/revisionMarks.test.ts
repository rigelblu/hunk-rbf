import { describe, expect, test } from "bun:test";
import { planHistoryPage } from "./lanePlanner";
import type { HistoryCommandInput, HistoryExpressionInput } from "../run/commandInputs";
import {
  reconcileRevisionMarks,
  revisionMark,
  revisionMarkLogicalFallbackEligible,
  revisionMarkSeenUnder,
  revisionMarkTraversalKey,
} from "./revisionMarks";
import type { HistoryCommit } from "./types";

type TestHistoryScope = Parameters<typeof revisionMarkSeenUnder>[1];

/** Build an unfiltered, unlimited history input, the only shape eligible for logical fallback. */
function createTestHistoryInput(overrides: Partial<HistoryCommandInput> = {}): HistoryCommandInput {
  return {
    kind: "history",
    color: "never",
    format: "compact",
    ascii: false,
    static: false,
    extensionsEnabled: false,
    extensionPaths: [],
    ...overrides,
  };
}

/** Stand in for an input kind this module does not list, which the type system forbids today. */
function createTestUnlistedInput(fields: Record<string, unknown>) {
  return {
    ...createTestHistoryInput(),
    kind: "unlisted",
    ...fields,
  } as unknown as HistoryCommandInput;
}

/** Build one deterministic history commit carrying an optional logical change identity. */
function createTestMarkCommit(revisionId: string, logicalId?: string): HistoryCommit {
  return {
    revisionId,
    displayId: revisionId,
    parentRevisionIds: [],
    subject: revisionId,
    ...(logicalId ? { logicalId } : {}),
    authorName: "Test",
    authoredAt: "2026-01-01T00:00:00Z",
    decorations: [],
  };
}

/** Plan provider-ordered rows for mark reconciliation. */
function createTestMarkRows(...commits: HistoryCommit[]) {
  return planHistoryPage(commits).rows;
}

describe("revision mark input kinds", () => {
  test("denies the logical fallback by default: only a listed input kind can be eligible", () => {
    expect(revisionMarkLogicalFallbackEligible(createTestHistoryInput())).toBeTrue();
    expect(
      revisionMarkLogicalFallbackEligible(createTestHistoryInput({ maxCount: 5 })),
    ).toBeFalse();
    // Every filter field is absent here, so only the unlisted kind can deny it.
    expect(revisionMarkLogicalFallbackEligible(createTestUnlistedInput({}))).toBeFalse();
  });

  test("denies the logical fallback when a revision or first-parent filter selects the rows", () => {
    for (const filter of [
      { revision: "@" },
      { firstParent: true },
      { revision: "@", firstParent: true },
    ]) {
      expect(revisionMarkLogicalFallbackEligible(createTestHistoryInput(filter))).toBeFalse();
    }
    // Neither the default launch nor `--all` narrows the visible revisions in scope.
    expect(revisionMarkLogicalFallbackEligible(createTestHistoryInput())).toBeTrue();
    expect(revisionMarkLogicalFallbackEligible(createTestHistoryInput({ all: true }))).toBeTrue();
    expect(
      revisionMarkLogicalFallbackEligible(createTestHistoryInput({ firstParent: false })),
    ).toBeTrue();
  });

  test("keys an unlisted input kind on its whole input, apart from every listed kind", () => {
    const first = revisionMarkTraversalKey(createTestUnlistedInput({ expression: "mine()" }));
    const second = revisionMarkTraversalKey(createTestUnlistedInput({ expression: "trunk()" }));
    expect(first).not.toBe(second);
    expect(first).not.toBe(revisionMarkTraversalKey(createTestHistoryInput()));
    expect(revisionMarkTraversalKey(createTestHistoryInput({ revision: "a" }))).not.toBe(
      revisionMarkTraversalKey(createTestHistoryInput({ revision: "b" })),
    );
    expect(revisionMarkTraversalKey(createTestHistoryInput({ theme: "nord" }))).toBe(
      revisionMarkTraversalKey(createTestHistoryInput()),
    );
  });
});

describe("where a revision mark was last seen", () => {
  const key = revisionMarkTraversalKey(createTestHistoryInput());
  const boundedAt = (boundaryRevisionId: string): TestHistoryScope => ({
    kind: "bounded",
    boundaryRevisionId,
  });
  const fallback = (reason: "unavailable" | "ambiguous"): TestHistoryScope => ({
    kind: "fallback",
    reason,
  });

  test("names the same traversal with the same bound, fallback reason, or no scope identically", () => {
    expect(revisionMarkSeenUnder(key, boundedAt("T1"))).toBe(
      revisionMarkSeenUnder(key, boundedAt("T1")),
    );
    expect(revisionMarkSeenUnder(key, fallback("unavailable"))).toBe(
      revisionMarkSeenUnder(key, fallback("unavailable")),
    );
    expect(revisionMarkSeenUnder(key, undefined)).toBe(revisionMarkSeenUnder(key, undefined));
  });

  test("names a moved bound, a changed kind or reason, a scope appearing or leaving, and another traversal differently", () => {
    const names = [
      revisionMarkSeenUnder(key, boundedAt("T1")),
      revisionMarkSeenUnder(key, boundedAt("T2")),
      revisionMarkSeenUnder(key, fallback("unavailable")),
      revisionMarkSeenUnder(key, fallback("ambiguous")),
      revisionMarkSeenUnder(key, undefined),
      revisionMarkSeenUnder(
        revisionMarkTraversalKey(createTestHistoryInput({ revision: "other" })),
        boundedAt("T1"),
      ),
      // A boundary id must not collide with a fallback reason of the same text.
      revisionMarkSeenUnder(key, boundedAt("unavailable")),
    ];
    expect(new Set(names).size).toBe(names.length);
  });

  test("keys an unlisted scope kind on its whole value", () => {
    const unlisted = (value: string) =>
      ({ kind: "unlisted", value }) as unknown as TestHistoryScope;
    expect(revisionMarkSeenUnder(key, unlisted("a"))).not.toBe(
      revisionMarkSeenUnder(key, unlisted("b")),
    );
  });
});

describe("revision mark reconciliation against where each mark was last seen", () => {
  const here = "rows-here";
  const complete = { seenUnder: here, complete: true };

  test("keeps an exact match resolved under any rows and records them as where it was last seen", () => {
    const mark = revisionMark(createTestMarkCommit("kept", "kept-change"), "rows-elsewhere");
    const rows = createTestMarkRows(createTestMarkCommit("kept", "kept-change"));

    for (const evidence of [complete, { seenUnder: here, complete: false }])
      expect(reconcileRevisionMarks([mark], rows, evidence)).toEqual([
        { kind: "resolved", mark: { ...mark, seenUnder: here }, revisionId: "kept" },
      ]);
  });

  test("never re-targets or calls missing a mark last seen under other rows, and keeps its record", () => {
    const sibling = revisionMark(createTestMarkCommit("c1", "change"), "rows-elsewhere");
    const alone = revisionMark(createTestMarkCommit("B", "b"), "rows-elsewhere");
    const rows = createTestMarkRows(createTestMarkCommit("c3", "change"));

    const first = reconcileRevisionMarks([sibling, alone], rows, complete);
    expect(first).toEqual([
      { kind: "unresolved", mark: sibling, reason: "incomplete" },
      { kind: "unresolved", mark: alone, reason: "incomplete" },
    ]);
    // Feeding the result back in models the next refresh: the record did not move, so nothing does.
    expect(
      reconcileRevisionMarks(
        first.map((entry) => entry.mark),
        rows,
        complete,
      ),
    ).toEqual(first);
  });

  test("decides each mark on its own record within one reconciliation", () => {
    const seenHere = revisionMark(createTestMarkCommit("old", "change"), here);
    const seenElsewhere = revisionMark(createTestMarkCommit("c1", "other"), "rows-elsewhere");
    const rows = createTestMarkRows(
      createTestMarkCommit("new", "change"),
      createTestMarkCommit("c3", "other"),
    );

    expect(reconcileRevisionMarks([seenHere, seenElsewhere], rows, complete)).toMatchObject([
      { kind: "resolved", revisionId: "new", mark: { revisionId: "new", seenUnder: here } },
      { kind: "unresolved", reason: "incomplete", mark: seenElsewhere },
    ]);
  });

  test("calls a mark last seen under these rows missing or ambiguous only when they are complete", () => {
    const gone = revisionMark(createTestMarkCommit("gone", "gone-change"), here);
    const split = revisionMark(createTestMarkCommit("c1", "change"), here);
    const rows = createTestMarkRows(
      createTestMarkCommit("c2", "change"),
      createTestMarkCommit("c3", "change"),
    );

    expect(reconcileRevisionMarks([gone, split], rows, complete)).toEqual([
      { kind: "unresolved", mark: gone, reason: "missing" },
      { kind: "unresolved", mark: split, reason: "ambiguous" },
    ]);
    expect(
      reconcileRevisionMarks([gone, split], rows, { seenUnder: here, complete: false }),
    ).toEqual([
      { kind: "unresolved", mark: gone, reason: "incomplete" },
      { kind: "unresolved", mark: split, reason: "incomplete" },
    ]);
  });
});

describe("revision marks under an applied expression", () => {
  const expression = (text: string, maxCount?: number): HistoryExpressionInput => ({
    kind: "expression",
    expression: text,
    ...(maxCount === undefined ? {} : { maxCount }),
  });

  test("denies the logical fallback for expression input, whatever its limit", () => {
    expect(revisionMarkLogicalFallbackEligible(expression("all()"))).toBeFalse();
    expect(revisionMarkLogicalFallbackEligible(expression("all()", 100))).toBeFalse();
  });

  test("keys expression input on its text and limit, apart from the launch input", () => {
    expect(revisionMarkTraversalKey(expression("@-"))).toBe(
      revisionMarkTraversalKey(expression("@-")),
    );
    expect(revisionMarkTraversalKey(expression("@-"))).not.toBe(
      revisionMarkTraversalKey(expression("@")),
    );
    expect(revisionMarkTraversalKey(expression("@-", 5))).not.toBe(
      revisionMarkTraversalKey(expression("@-")),
    );
    expect(revisionMarkTraversalKey(expression("@-"))).not.toBe(
      revisionMarkTraversalKey(createTestHistoryInput()),
    );
  });

  test("leaves a mark incomplete, never re-targeted, when a symbolic expression resolves elsewhere", () => {
    const input = expression("@");
    const seenUnder = revisionMarkSeenUnder(revisionMarkTraversalKey(input), undefined);
    const evidence = { seenUnder, complete: revisionMarkLogicalFallbackEligible(input) };
    // `@` named the first revision, then a rewrite made it name the second, same logical change.
    const marked = revisionMark(createTestMarkCommit("first", "change"), seenUnder);
    const moved = createTestMarkRows(createTestMarkCommit("second", "change"));

    const first = reconcileRevisionMarks([marked], moved, evidence);
    expect(first).toEqual([{ kind: "unresolved", mark: marked, reason: "incomplete" }]);
    // Reading the same expression again and again proves nothing either.
    expect(
      reconcileRevisionMarks(
        first.map((entry) => entry.mark),
        moved,
        evidence,
      ),
    ).toEqual(first);
    // Its exact revision coming back is the only way a mark resolves.
    expect(
      reconcileRevisionMarks([marked], createTestMarkRows(createTestMarkCommit("first")), evidence),
    ).toMatchObject([{ kind: "resolved", revisionId: "first" }]);
  });
});
