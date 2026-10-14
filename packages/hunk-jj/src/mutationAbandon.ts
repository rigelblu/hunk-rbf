/**
 * Plans, words and judges abandoning one revision.
 *
 * The command is `jj abandon --retain-bookmarks <revision>`: descendants are
 * rebased onto the parent and bookmarks move there too. Abandon takes one
 * source for now; the request carries a list so a later slice can widen it.
 */
import type {
  ExtensionVcsMutationChange,
  ExtensionVcsMutationProjection,
  ExtensionVcsMutationRevision,
  ExtensionVcsMutationRevisionChange,
  ExtensionVcsMutationVerdict,
} from "hunkdiff/extension";
import type { JjMutationKind } from "./mutationKind";
import {
  countOf,
  describeBookmark,
  describeRevision,
  describeUnexportableBookmark,
  findMovedDescendants,
} from "./mutationWording";

/** jj's own text when the revset names nothing it can abandon. */
const JJ_NOTHING_TO_ABANDON = "No revisions to abandon.";

/** Finds the change entry that holds the exact source version the facts observed. */
function findSourceChange(
  change: ExtensionVcsMutationChange,
  source: ExtensionVcsMutationRevision,
): ExtensionVcsMutationRevisionChange | undefined {
  return change.revisions.find((entry) =>
    entry.before.some((revision) => revision.revisionId === source.revisionId),
  );
}

/** Says whether the exact source version left and every other version of its change stayed. */
function sourceLeft(
  sourceChange: ExtensionVcsMutationRevisionChange | undefined,
  source: ExtensionVcsMutationRevision,
): sourceChange is ExtensionVcsMutationRevisionChange {
  return (
    sourceChange !== undefined &&
    !sourceChange.after.some((revision) => revision.revisionId === source.revisionId) &&
    sourceChange.after.length === sourceChange.before.length - 1
  );
}

/** Splits the other entries into descendants the abandon moved, new conflicts and a created working copy. */
function describeOthers(
  change: ExtensionVcsMutationChange,
  source: ExtensionVcsMutationRevision,
  sourceChange: ExtensionVcsMutationRevisionChange | undefined,
) {
  // Only what descended from the source was moved by the abandon. A working copy jj recorded on
  // the way, and its children, were not.
  const rebased = findMovedDescendants(change, [source.revisionId]).filter(
    (entry) => entry !== sourceChange && entry.after.length > 0,
  );
  const newlyConflicted = rebased.filter(
    (entry) =>
      entry.after.some((revision) => revision.hasConflict) &&
      !entry.before.some((revision) => revision.hasConflict),
  );
  const createdWorkingCopy = change.revisions.some(
    (entry) => entry.before.length === 0 && entry.after.some((revision) => revision.isWorkingCopy),
  );
  return { rebased, newlyConflicted, createdWorkingCopy };
}

/** Words the bookmark changes from where each bookmark ends up, and warns about targets Git cannot hold. */
function describeBookmarks(
  change: ExtensionVcsMutationChange,
  source: ExtensionVcsMutationRevision,
  tense: "will" | "did",
) {
  const notes: string[] = [];
  const warnings: string[] = [];
  const parents = new Set(source.parents.map((parent) => parent.revisionId));
  for (const bookmark of change.bookmarks) {
    if (bookmark.followsRevision) continue;
    const name = describeBookmark(bookmark);
    const unexportable = describeUnexportableBookmark(bookmark, tense);
    if (unexportable) {
      warnings.push(unexportable);
    } else if (bookmark.after.length === 0) {
      notes.push(
        tense === "will" ? `Bookmark ${name} will be removed.` : `Bookmark ${name} was removed.`,
      );
    } else if (bookmark.after.every((target) => parents.has(target.revisionId))) {
      notes.push(
        tense === "will"
          ? `Bookmark ${name} moves to the parent.`
          : `Bookmark ${name} moved to the parent.`,
      );
    } else {
      notes.push(tense === "will" ? `Bookmark ${name} moves.` : `Bookmark ${name} moved.`);
    }
  }
  return { notes, warnings };
}

export const abandonKind: JjMutationKind<"abandon"> = {
  kind: "abandon",
  revisions: (request) => request.sources,
  plan({ request, facts }) {
    if (request.sources.length > 1) return { refused: "Abandon takes one revision for now." };
    const source = facts.revisions[0];
    if (!source) return { refused: "Hunk could not read this revision." };
    if (source.isRoot) return { refused: "The root revision cannot be abandoned." };
    // Immutability is decided by jj's dry run, so the refusal carries jj's own reason and hint.
    return {
      args: ["abandon", "--retain-bookmarks", { revision: request.sources[0] }],
      preview: "dry-run",
      interactive: false,
    };
  },
  project({ facts, dryRun }) {
    const source = facts.revisions[0];
    if (!source || !dryRun) return { refused: "Hunk could not read JJ's preview of this abandon." };
    if (dryRun.kind === "failed") return { refused: "JJ will not abandon this revision." };

    const named = [
      { label: "Source", revision: { revisionId: source.revisionId, logicalId: source.logicalId } },
    ];
    if (dryRun.kind === "no-operation") {
      // A reworded jj line must never read as "nothing will change", so only jj's known text is a no-op.
      if (!dryRun.text.includes(JJ_NOTHING_TO_ABANDON))
        return { refused: "Hunk could not read JJ's preview of this abandon." };
      return {
        headline: `Nothing to abandon: JJ no longer sees ${describeRevision(source)}.`,
        notes: [],
        warnings: [],
        named,
      };
    }

    const sourceChange = findSourceChange(dryRun.change, source);
    // The same rule `judge` applies afterwards, so a preview that is confirmed can also complete.
    if (!sourceLeft(sourceChange, source)) {
      return { refused: "JJ's preview does not abandon this revision." };
    }

    const { rebased, newlyConflicted, createdWorkingCopy } = describeOthers(
      dryRun.change,
      source,
      sourceChange,
    );
    const bookmarks = describeBookmarks(dryRun.change, source, "will");
    const projection: ExtensionVcsMutationProjection = {
      headline: `Abandon ${describeRevision(source)}`,
      notes: [],
      warnings: [],
      named,
    };
    if (rebased.length > 0)
      projection.notes.push(
        `${countOf(rebased.length, "descendant")} will be rebased onto its parent.`,
      );
    if (sourceChange.after.length > 0)
      projection.notes.push("Only this version is abandoned. Another version of the change stays.");
    if (createdWorkingCopy)
      projection.notes.push("JJ creates a new empty working-copy revision on its parent.");
    projection.notes.push(...bookmarks.notes);
    if (source.isWorkingCopy && facts.files.kind === "pending") {
      projection.warnings.push(
        `This is the working-copy revision. Abandoning it takes its unrecorded changes to ${countOf(facts.files.paths.length, "file")} out of your files.`,
      );
    }
    if (newlyConflicted.length > 0)
      projection.warnings.push(
        `JJ will create conflicts in ${countOf(newlyConflicted.length, "descendant")}.`,
      );
    projection.warnings.push(...bookmarks.warnings);
    return projection;
  },
  judge({ facts, process, change }) {
    const source = facts.revisions[0];
    const named = source
      ? [
          {
            label: "Source",
            revision: { revisionId: source.revisionId, logicalId: source.logicalId },
          },
        ]
      : [];
    const verdict = (
      outcome: ExtensionVcsMutationVerdict["outcome"],
      headline: string,
    ): ExtensionVcsMutationVerdict => ({
      outcome,
      headline,
      notes: [],
      warnings: [],
      named,
    });

    if (!change || !source)
      return verdict("unexpected", "Hunk could not read back the result of this abandon.");
    const ranOwnOperation = change.operations.some(
      (operation) => operation.isOwn && !operation.isSnapshot,
    );
    if (process.exitCode !== 0) {
      // The exit code decides the outcome, but the headline must not deny what the read-back shows.
      const leftAnyway = ranOwnOperation && sourceLeft(findSourceChange(change, source), source);
      return verdict(
        "failed",
        leftAnyway
          ? `JJ reported an error, and ${describeRevision(source)} was abandoned.`
          : `JJ did not abandon ${describeRevision(source)}.`,
      );
    }
    const sourceChange = findSourceChange(change, source);
    // The headline speaks for the command only: another writer's operations can be in the same read-back.
    if (!ranOwnOperation) {
      const nothing = verdict("no-op", "JJ had nothing to abandon.");
      if (sourceLeft(sourceChange, source)) {
        // The user must not read "nothing happened" beside a revision that is gone.
        nothing.warnings.push("Another operation removed this revision while the command ran.");
        const parent = source.parents[0];
        if (parent) nothing.selectAfter = parent;
      }
      return nothing;
    }

    // The source is judged by the exact version the facts observed, so a divergent change's other version may stay.
    if (!sourceLeft(sourceChange, source))
      return verdict("unexpected", "JJ ran, but the result is not the abandon that was confirmed.");

    const { rebased, newlyConflicted } = describeOthers(change, source, sourceChange);
    const bookmarks = describeBookmarks(change, source, "did");
    const completed = verdict("completed", `Abandoned ${describeRevision(source)}`);
    if (rebased.length > 0)
      completed.notes.push(`${countOf(rebased.length, "descendant")} rebased onto its parent.`);
    completed.notes.push(...bookmarks.notes);
    if (newlyConflicted.length > 0)
      completed.warnings.push(
        `JJ created conflicts in ${countOf(newlyConflicted.length, "descendant")}.`,
      );
    completed.warnings.push(...bookmarks.warnings);
    // Select the first parent, so the highlight lands beside what was removed.
    const parent = source.parents[0];
    if (parent) completed.selectAfter = parent;
    return completed;
  },
};
