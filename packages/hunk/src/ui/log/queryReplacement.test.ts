import { describe, expect, test } from "bun:test";
import { planHistoryPage } from "../../core/history/lanePlanner";
import type { HistoryCommit } from "../../core/history/types";
import {
  chooseHistoryQueryFocus,
  historyQueryFailureReason,
  historyQueryPageLimit,
  HISTORY_QUERY_REASON_UNITS,
  withoutGraphLinks,
} from "./queryReplacement";

function createTestCommit(revisionId: string, parents: string[] = []): HistoryCommit {
  return {
    revisionId,
    displayId: revisionId,
    parentRevisionIds: parents,
    subject: revisionId,
    authorName: "Ada",
    authoredAt: "2026-01-01T00:00:00Z",
    decorations: [],
  };
}

describe("historyQueryFailureReason", () => {
  test("keeps line breaks, trims, and removes terminal controls", () => {
    expect(historyQueryFailureReason(new Error("  first\nsecond\u001b[31m\u0007  "))).toBe(
      "first\nsecond",
    );
    expect(historyQueryFailureReason("plain")).toBe("plain");
    expect(historyQueryFailureReason(new Error("   "))).toBe("History could not be read.");
  });

  test("turns each tab into one space", () => {
    expect(historyQueryFailureReason("a\tb\t\tc")).toBe("a b  c");
  });

  test("caps at 4,096 UTF-16 units with the ellipsis inside the cap", () => {
    const exact = "x".repeat(HISTORY_QUERY_REASON_UNITS);
    expect(historyQueryFailureReason(exact)).toBe(exact);
    const capped = historyQueryFailureReason("x".repeat(HISTORY_QUERY_REASON_UNITS + 1));
    expect(capped).toHaveLength(HISTORY_QUERY_REASON_UNITS);
    expect(capped.endsWith("…")).toBeTrue();
    expect(capped.slice(0, -1)).toBe("x".repeat(HISTORY_QUERY_REASON_UNITS - 1));
  });

  test("never ends on half of a surrogate pair", () => {
    const text = `${"x".repeat(HISTORY_QUERY_REASON_UNITS - 2)}😀tail`;
    const capped = historyQueryFailureReason(text);
    expect(capped.length).toBeLessThanOrEqual(HISTORY_QUERY_REASON_UNITS);
    expect(capped).toBe(`${"x".repeat(HISTORY_QUERY_REASON_UNITS - 2)}…`);
  });
});

describe("historyQueryPageLimit", () => {
  test("reads at most one page, narrowed by the launch limit, and at least one commit", () => {
    expect(historyQueryPageLimit(undefined)).toBe(256);
    expect(historyQueryPageLimit(1000)).toBe(256);
    expect(historyQueryPageLimit(100)).toBe(100);
    expect(historyQueryPageLimit(0)).toBe(1);
  });
});

describe("withoutGraphLinks", () => {
  test("empties graph parents but keeps real parents, and plans no link between rows", () => {
    const commits = [createTestCommit("c", ["b"]), createTestCommit("b", ["a"])];
    const stripped = withoutGraphLinks([
      { ...commits[0]!, graphParentRevisionIds: ["b"] },
      commits[1]!,
    ]);
    expect(stripped.map((commit) => commit.parentRevisionIds)).toEqual([["b"], ["a"]]);
    expect(stripped.map((commit) => commit.graphParentRevisionIds)).toEqual([[], []]);
    const linked = planHistoryPage(commits).rows;
    const unlinked = planHistoryPage(stripped).rows;
    expect(unlinked).not.toEqual(linked);
    expect(linked[0]!.lanesAfter).toEqual(["b"]);
    expect(unlinked.map((row) => row.lanesAfter)).toEqual([[], []]);
    expect(unlinked.map((row) => row.parentLanes)).toEqual([[], []]);
  });
});

describe("chooseHistoryQueryFocus", () => {
  const rows = planHistoryPage([createTestCommit("a"), createTestCommit("b")]).rows;

  test("keeps focus on the exact revision when the first page holds it", () => {
    expect(chooseHistoryQueryFocus(rows, "b")).toEqual({ outcome: "kept", selected: 1 });
  });

  test("selects the newest row when the focused revision is not loaded", () => {
    expect(chooseHistoryQueryFocus(rows, "gone")).toEqual({ outcome: "newest", selected: 0 });
  });

  test("selects the first row quietly when nothing was focused, and clears on an empty page", () => {
    expect(chooseHistoryQueryFocus(rows, undefined)).toEqual({ outcome: "first", selected: 0 });
    expect(chooseHistoryQueryFocus([], "a")).toEqual({ outcome: "empty", selected: 0 });
  });
});
