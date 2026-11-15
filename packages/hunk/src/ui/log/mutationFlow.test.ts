import { describe, expect, test } from "bun:test";
import type { ExtensionVcsHistoryCommit } from "../../extension-api/types";
import { toHistoryMutationRevisionRef, toHistoryMutationRevisionRefs } from "./mutationFlow";

/** Builds a history row with only the fields a reference reads. */
function createTestHistoryCommit(
  revisionId: string,
  logicalId?: string,
): ExtensionVcsHistoryCommit {
  return {
    revisionId,
    displayId: revisionId.slice(0, 8),
    parentRevisionIds: [],
    subject: "subject",
    authorName: "Ada",
    authoredAt: "2026-01-01T00:00:00+00:00",
    decorations: [],
    ...(logicalId === undefined ? {} : { logicalId }),
  };
}

describe("history mutation references", () => {
  test("names a row by its exact revision and its logical identity", () => {
    expect(toHistoryMutationRevisionRef(createTestHistoryCommit("a".repeat(40), "kkkk"))).toEqual({
      revisionId: "a".repeat(40),
      logicalId: "kkkk",
    });
    expect(toHistoryMutationRevisionRef(createTestHistoryCommit("b".repeat(40)))).toEqual({
      revisionId: "b".repeat(40),
      logicalId: undefined,
    });
  });

  test("keeps a list of rows in order", () => {
    const refs = toHistoryMutationRevisionRefs([
      createTestHistoryCommit("a".repeat(40), "kkkk"),
      createTestHistoryCommit("b".repeat(40), "llll"),
    ]);
    expect(refs.map((ref) => ref.logicalId)).toEqual(["kkkk", "llll"]);
  });
});
