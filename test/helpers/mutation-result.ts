/** Supply complete successful readback at the provider boundary for host interaction tests. */
import type {
  ExtensionVcsMutationPrepared,
  ExtensionVcsMutationResult,
} from "../../packages/hunk/src/extension-api/types";

/** Record the exact captured sources and rewritten destination without running a mutation. */
export function createTestCleanSquashResult(
  prepared: ExtensionVcsMutationPrepared,
): Extract<ExtensionVcsMutationResult, { kind: "ran" }> {
  if (prepared.request.kind !== "squash") throw new Error("Expected squash");
  const request = prepared.request;
  const destination = prepared.facts.revisions.find(
    (r) => r.revisionId === request.destination.revisionId,
  );
  if (!destination) throw new Error("Missing destination facts");
  return {
    kind: "ran",
    process: {
      started: true,
      exitCode: 0,
      signal: null,
      wasInterrupted: false,
      terminal: "captured",
      terminalRestored: true,
      text: "",
    },
    change: {
      kind: "read",
      value: {
        operations: [
          { operationId: "exact-operation", description: "squash", isOwn: true, isSnapshot: false },
        ],
        revisions: [
          ...request.sources
            .filter((source) => source.revisionId !== destination.revisionId)
            .map((source) => {
              const before = prepared.facts.revisions.find(
                (r) => r.revisionId === source.revisionId,
              );
              if (!before) throw new Error("Missing source facts");
              return { logicalId: before.logicalId, before: [before], after: [] };
            }),
          {
            logicalId: destination.logicalId,
            before: [destination],
            after: [{ ...destination, revisionId: "rewritten-destination" }],
          },
        ],
        bookmarks: [],
      },
    },
    verdict: {
      outcome: "completed",
      headline: "Provider actual success",
      notes: [],
      warnings: [],
      named: [],
    },
    isWorkingCopyStale: false,
  };
}
