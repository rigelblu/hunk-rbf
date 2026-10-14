/**
 * Plans, words and judges squashing one revision into a chosen destination.
 *
 * The command is `jj squash --from <source> --into <destination> --message=<description>`:
 * the whole source moves into the destination, the emptied source is removed, and its
 * descendants are rebased. Hunk composes the description and passes it, so no editor opens.
 * Bookmarks are left to jj, which keeps a removed source's bookmarks on the source's parents.
 * Squash takes one source for now; the request carries a list so a later slice can widen it.
 */
import type {
  ExtensionVcsMutationBookmarkChange,
  ExtensionVcsMutationChange,
  ExtensionVcsMutationNamedRevision,
  ExtensionVcsMutationProjection,
  ExtensionVcsMutationRevision,
  ExtensionVcsMutationRevisionChange,
  ExtensionVcsMutationRevisionRef,
  ExtensionVcsMutationVerdict,
} from "hunkdiff/extension";
import { describeRevision, countOf } from "./mutationWording";
import type { JjMutationKind } from "./mutationKind";

/** jj's own text when a squash would change nothing. */
const JJ_NOTHING_CHANGED = "Nothing changed.";
const ROOT_COMMIT_ID_PATTERN = /^0+$/;

/**
 * Composes the description the destination keeps after a squash, the way Jujutsu combines two
 * descriptions when it is given no message.
 *
 * A side that has text but no final newline gets one first, as Jujutsu stores it. When one side
 * is the empty string the result is the other side. Otherwise the result is the destination's
 * description, one more newline, then the source's, so one blank line separates them. Newlines
 * at the very start and very end of that joined text are dropped, and what is left ends with
 * one newline; when nothing is left the result is empty. So next to a side that has text, a
 * side made only of newlines contributes nothing. Spaces and blank lines inside the text are
 * kept.
 *
 * One deliberate difference: Jujutsu also deletes lines that start with `JJ:`, because its
 * editor template adds such lines. No editor runs here, so a line like that is the user's own
 * text and stays.
 */
export function composeSquashDescription(destination: string, source: string): string {
  if (destination === "") return withFinalNewline(source);
  if (source === "") return withFinalNewline(destination);
  const joined = `${withFinalNewline(destination)}\n${withFinalNewline(source)}`;
  return withFinalNewline(joined.replace(/^\n+|\n+$/g, ""));
}

/** Ends a non-empty description with the final newline Jujutsu adds when one is missing. */
function withFinalNewline(description: string): string {
  return description === "" || description.endsWith("\n") ? description : `${description}\n`;
}

/**
 * Returns the lines jj stored after the composed description, or null when the stored text is
 * not the composed text with lines added. Jujutsu appends configured commit trailers, such as
 * `Signed-off-by`, to a message it is given; measured on 0.46.0. An empty string means the two
 * are the same.
 */
function linesAddedByJj(stored: string, composed: string): string | null {
  if (stored === composed) return "";
  const kept = composed.replace(/\n+$/, "");
  if (!stored.startsWith(kept)) return null;
  const added = stored.slice(kept.length);
  return kept === "" || added.startsWith("\n") ? added.trim() : null;
}

/** Refers to an observed revision by both of its ids. */
function refOf(revision: ExtensionVcsMutationRevision): ExtensionVcsMutationRevisionRef {
  return { revisionId: revision.revisionId, logicalId: revision.logicalId };
}

/** Labels the two revisions the confirm step and the result call out. */
function nameRevisions(
  source: ExtensionVcsMutationRevision,
  destination: ExtensionVcsMutationRevision,
): ExtensionVcsMutationNamedRevision[] {
  return [
    { label: "Source", revision: refOf(source) },
    { label: "Destination", revision: refOf(destination) },
  ];
}

/** Finds the change entry that holds the exact version the facts observed. */
function findChangeOf(
  change: ExtensionVcsMutationChange,
  revision: ExtensionVcsMutationRevision,
): ExtensionVcsMutationRevisionChange | undefined {
  return change.revisions.find((entry) =>
    entry.before.some((before) => before.revisionId === revision.revisionId),
  );
}

/** Lists the versions an entry has after that it did not have before. */
function newVersionsOf(entry: ExtensionVcsMutationRevisionChange): ExtensionVcsMutationRevision[] {
  return entry.after.filter(
    (after) => !entry.before.some((before) => before.revisionId === after.revisionId),
  );
}

/**
 * True when the exact source version is gone and no new version took its place: the entry holds
 * one version fewer than before. That also holds when the source shares its change id with the
 * destination, where the entry goes from both versions to the rewritten destination.
 */
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

/**
 * True when the exact destination version was replaced: it is gone, a new version exists, and
 * the entry kept its count, less the source when both share one change id.
 */
function destinationReplaced(
  destinationChange: ExtensionVcsMutationRevisionChange | undefined,
  destination: ExtensionVcsMutationRevision,
  sourceChange: ExtensionVcsMutationRevisionChange,
): destinationChange is ExtensionVcsMutationRevisionChange {
  if (!destinationChange) return false;
  const expected = destinationChange.before.length - (destinationChange === sourceChange ? 1 : 0);
  return (
    !destinationChange.after.some((revision) => revision.revisionId === destination.revisionId) &&
    newVersionsOf(destinationChange).length > 0 &&
    destinationChange.after.length === expected
  );
}

/**
 * Finds the destination as rewritten: the one new version of its change, or among several the
 * one that carries the composed description, with or without trailers jj added. An entry lists a divergent change's versions in
 * log order, so position never identifies the destination. Returns undefined when the exact
 * destination version stayed, or when no single new version can be told apart.
 */
function findRewrittenDestination(
  destinationChange: ExtensionVcsMutationRevisionChange,
  destination: ExtensionVcsMutationRevision,
  description: string,
): ExtensionVcsMutationRevision | undefined {
  if (destinationChange.after.some((revision) => revision.revisionId === destination.revisionId))
    return undefined;
  const created = newVersionsOf(destinationChange);
  if (created.length === 1) return created[0];
  const described = created.filter(
    (revision) => linesAddedByJj(revision.description, description) !== null,
  );
  return described.length === 1 ? described[0] : undefined;
}

/** Joins a revision's parent ids, so two versions on the same parents compare equal. */
function parentKeyOf(revision: ExtensionVcsMutationRevision): string {
  return revision.parents.map((parent) => parent.revisionId).join(" ");
}

/** True when the versions after do not sit on the same sets of parents as the versions before. */
function wasRebased(entry: ExtensionVcsMutationRevisionChange): boolean {
  const before = entry.before.map(parentKeyOf).sort().join("\n");
  const after = entry.after.map(parentKeyOf).sort().join("\n");
  return before !== after;
}

/** True when an entry has a conflicted version after and had none before. */
function isNewlyConflicted(entry: ExtensionVcsMutationRevisionChange): boolean {
  return (
    entry.after.some((revision) => revision.hasConflict) &&
    !entry.before.some((revision) => revision.hasConflict)
  );
}

/**
 * Describes the entries that are neither the source nor the destination. A working copy jj only
 * recorded keeps its parents, so it is not counted as rebased.
 */
function describeOthers(
  change: ExtensionVcsMutationChange,
  sourceChange: ExtensionVcsMutationRevisionChange,
  destinationChange: ExtensionVcsMutationRevisionChange,
) {
  const others = change.revisions.filter(
    (entry) => entry !== sourceChange && entry !== destinationChange,
  );
  const kept = others.filter((entry) => entry.before.length > 0 && entry.after.length > 0);
  const rebased = kept.filter(wasRebased);
  const createdWorkingCopy = others.some(
    (entry) => entry.before.length === 0 && entry.after.some((revision) => revision.isWorkingCopy),
  );
  return { rebased, newlyConflicted: kept.filter(isNewlyConflicted), createdWorkingCopy };
}

/** Names a bookmark with its remote when it has one. */
function describeBookmark(bookmark: ExtensionVcsMutationBookmarkChange): string {
  return bookmark.remote ? `${bookmark.name}@${bookmark.remote}` : bookmark.name;
}

/**
 * Words every bookmark move in the change, and warns about targets Git cannot hold. In a squash
 * the bookmarks that move are the removed source's. The two warnings carry the same wording as
 * abandon's, because the user meets the same repository state from either command.
 */
function describeBookmarks(change: ExtensionVcsMutationChange, tense: "will" | "did") {
  const notes: string[] = [];
  const warnings: string[] = [];
  for (const bookmark of change.bookmarks) {
    if (bookmark.followsRevision) continue;
    const name = describeBookmark(bookmark);
    if (bookmark.isConflicted) {
      warnings.push(
        tense === "will"
          ? `Bookmark ${name} will be conflicted. Git cannot hold it.`
          : `Bookmark ${name} is now conflicted. Git cannot hold it.`,
      );
    } else if (bookmark.after.some((target) => ROOT_COMMIT_ID_PATTERN.test(target.revisionId))) {
      warnings.push(
        tense === "will"
          ? `Bookmark ${name} will point at the root revision. Git cannot hold it.`
          : `Bookmark ${name} now points at the root revision. Git cannot hold it.`,
      );
    } else {
      notes.push(
        tense === "will"
          ? `Bookmark ${name} moves to the source's parent.`
          : `Bookmark ${name} moved to the source's parent.`,
      );
    }
  }
  // Said once, and also when every move is a warning, so the user knows who moves the bookmarks.
  if (notes.length + warnings.length > 0)
    notes.push("JJ leaves the source's bookmarks on the source's parents. Hunk moves none.");
  return { notes, warnings };
}

export const squashKind: JjMutationKind<"squash"> = {
  kind: "squash",
  // One source for now, so `facts.revisions` is the source and then the destination.
  revisions: (request) => [request.sources[0], request.destination],
  plan({ request, facts }) {
    if (request.sources.length > 1) return { refused: "Squash takes one revision for now." };
    const [source, destination] = facts.revisions;
    if (!source || !destination) return { refused: "Hunk could not read these revisions." };
    if (source.revisionId === destination.revisionId)
      return { refused: "A revision cannot be squashed into itself." };
    // Immutability, the root included, is decided by jj's dry run, so the refusal carries jj's own reason and hint.
    const description = composeSquashDescription(destination.description, source.description);
    return {
      args: [
        "squash",
        "--from",
        { revision: request.sources[0] },
        "--into",
        { revision: request.destination },
        // An explicit message, even an empty one, keeps Jujutsu from opening an editor. One
        // argument, so a description that starts with a hyphen is never read as a flag.
        `--message=${description}`,
      ],
      preview: "dry-run",
      interactive: false,
      description,
    };
  },
  project({ facts, plan, dryRun }) {
    const [source, destination] = facts.revisions;
    if (!source || !destination || !dryRun)
      return { refused: "Hunk could not read JJ's preview of this squash." };
    if (dryRun.kind === "failed") return { refused: "JJ will not squash this revision." };

    const named = nameRevisions(source, destination);
    if (dryRun.kind === "no-operation") {
      // A reworded jj line must never read as "nothing will change", so only jj's exact text is
      // a no-op. jj prints it alone only when source and destination are one revision, which
      // `plan` refuses first, so this branch is a guard.
      if (dryRun.text.trim() !== JJ_NOTHING_CHANGED)
        return { refused: "Hunk could not read JJ's preview of this squash." };
      return {
        headline: `Nothing to squash: JJ would change nothing for ${describeRevision(source)}.`,
        notes: [],
        warnings: [],
        named,
      };
    }

    const sourceChange = findChangeOf(dryRun.change, source);
    const destinationChange = findChangeOf(dryRun.change, destination);
    if (
      !sourceLeft(sourceChange, source) ||
      !destinationReplaced(destinationChange, destination, sourceChange)
    )
      return { refused: "JJ's preview is not a squash of this revision into this destination." };
    const rewritten = findRewrittenDestination(
      destinationChange,
      destination,
      plan.description ?? "",
    );
    if (!rewritten)
      return {
        refused: "Hunk cannot tell which version of the destination JJ's preview rewrites.",
      };
    // The confirm step shows the composed description, so the preview must store that text. Lines
    // jj adds after it are shown as a note, so what the user reads is still what gets stored.
    const addedLines = linesAddedByJj(rewritten.description, plan.description ?? "");
    if (addedLines === null)
      return { refused: "JJ's preview stores a different description than the one composed." };

    const { rebased, newlyConflicted, createdWorkingCopy } = describeOthers(
      dryRun.change,
      sourceChange,
      destinationChange,
    );
    const bookmarks = describeBookmarks(dryRun.change, "will");
    const hasPendingFiles = source.isWorkingCopy && facts.files.kind === "pending";
    const projection: ExtensionVcsMutationProjection = {
      headline: `Squash ${describeRevision(source)} into ${describeRevision(destination)}`,
      notes: ["The source revision is removed."],
      warnings: [],
      named,
    };
    // `isEmpty` is what jj has recorded, so a working copy with pending files is not empty here.
    if (source.isEmpty && !hasPendingFiles)
      projection.notes.push("The source has no changes. Only its description moves.");
    if (rebased.length > 0)
      projection.notes.push(`${countOf(rebased.length, "other revision")} will be rebased.`);
    if (source.isDivergent)
      projection.notes.push("Only this version is squashed. Another version of the change stays.");
    if (createdWorkingCopy) projection.notes.push("JJ creates a new empty working-copy revision.");
    projection.notes.push(...bookmarks.notes);
    if (addedLines)
      projection.notes.push(`JJ adds your configured trailers to the description: ${addedLines}`);
    if (hasPendingFiles && facts.files.kind === "pending") {
      projection.warnings.push(
        `This is the working-copy revision. Its unrecorded changes to ${countOf(facts.files.paths.length, "file")} move into the destination.`,
      );
    }
    if (rewritten.hasConflict && !destination.hasConflict)
      projection.warnings.push("JJ will create conflicts in the destination.");
    if (newlyConflicted.length > 0)
      projection.warnings.push(
        `JJ will create conflicts in ${countOf(newlyConflicted.length, "other revision")}.`,
      );
    projection.warnings.push(...bookmarks.warnings);
    return projection;
  },
  judge({ facts, plan, process, change }) {
    const [source, destination] = facts.revisions;
    const named = source && destination ? nameRevisions(source, destination) : [];
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

    if (!change || !source || !destination)
      return verdict("unexpected", "Hunk could not read back the result of this squash.");
    const ranOwnOperation = change.operations.some(
      (operation) => operation.isOwn && !operation.isSnapshot,
    );
    if (process.exitCode !== 0)
      return verdict(
        "failed",
        ranOwnOperation
          ? `JJ reported a failure after it changed the repository while squashing ${describeRevision(source)}.`
          : `JJ did not squash ${describeRevision(source)}.`,
      );
    if (!ranOwnOperation) return verdict("no-op", "Nothing changed.");

    // The source must be gone by the exact version the facts observed. A change with no entry
    // for it is not a squash, whatever else it holds.
    const sourceChange = findChangeOf(change, source);
    const destinationChange = findChangeOf(change, destination);
    if (
      !sourceLeft(sourceChange, source) ||
      !destinationReplaced(destinationChange, destination, sourceChange)
    )
      return verdict("unexpected", "JJ ran, but the result is not the squash that was confirmed.");

    const { rebased, newlyConflicted } = describeOthers(change, sourceChange, destinationChange);
    const bookmarks = describeBookmarks(change, "did");
    const completed = verdict(
      "completed",
      `Squashed ${describeRevision(source)} into ${describeRevision(destination)}`,
    );
    if (rebased.length > 0)
      completed.notes.push(`${countOf(rebased.length, "other revision")} rebased.`);
    completed.notes.push(...bookmarks.notes);
    const description = plan.description ?? "";
    const rewritten = findRewrittenDestination(destinationChange, destination, description);
    if (!rewritten)
      completed.warnings.push(
        "Hunk cannot tell which version of the destination JJ rewrote. Check it in the history.",
      );
    else if (linesAddedByJj(rewritten.description, description) === null)
      completed.warnings.push(
        "The destination's description is not the one shown at confirmation. Read it in the history.",
      );
    if (
      rewritten
        ? rewritten.hasConflict && !destination.hasConflict
        : isNewlyConflicted(destinationChange)
    )
      completed.warnings.push("JJ created conflicts in the destination.");
    if (newlyConflicted.length > 0)
      completed.warnings.push(
        `JJ created conflicts in ${countOf(newlyConflicted.length, "other revision")}.`,
      );
    completed.warnings.push(...bookmarks.warnings);
    // Select the destination as rewritten: its old revision id no longer names a visible
    // revision. When it cannot be told apart, the highlight stays where it was.
    if (rewritten) completed.selectAfter = refOf(rewritten);
    return completed;
  },
};
