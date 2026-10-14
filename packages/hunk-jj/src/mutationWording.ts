/**
 * Words the pieces every kind of history change names the same way.
 *
 * Kind modules share these so "abandon", "squash", "rebase" and "split" name a
 * revision and count things alike. The module is as pure as a kind module: it
 * imports only `hunkdiff/extension` types.
 */
import type {
  ExtensionVcsMutationBookmarkChange,
  ExtensionVcsMutationChange,
  ExtensionVcsMutationRevision,
  ExtensionVcsMutationRevisionChange,
} from "hunkdiff/extension";

/** jj's root revision has an all-zero commit id. */
const ROOT_COMMIT_ID_PATTERN = /^0+$/;

/** Names a revision the way the history view does: short change id, then the subject. */
export function describeRevision(revision: ExtensionVcsMutationRevision): string {
  const id = (revision.logicalId ?? revision.revisionId).slice(0, 8);
  const subject = revision.description.split("\n", 1)[0]?.trim();
  return subject ? `${id} "${subject}"` : `${id} (no description)`;
}

/** Counts with the right noun: "1 descendant", "3 descendants". */
export function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Names a bookmark with its remote when it has one. */
export function describeBookmark(bookmark: ExtensionVcsMutationBookmarkChange): string {
  return bookmark.remote ? `${bookmark.name}@${bookmark.remote}` : bookmark.name;
}

/**
 * Warns about a bookmark that ends up where Git cannot hold it: conflicted, or on the root revision.
 * Returns null for any other bookmark. Every kind that leaves bookmarks to jj uses this wording.
 */
export function describeUnexportableBookmark(
  bookmark: ExtensionVcsMutationBookmarkChange,
  tense: "will" | "did",
): string | null {
  if (bookmark.followsRevision) return null;
  const name = describeBookmark(bookmark);
  if (bookmark.isConflicted) {
    return tense === "will"
      ? `Bookmark ${name} will be conflicted. Git cannot hold it.`
      : `Bookmark ${name} is now conflicted. Git cannot hold it.`;
  }
  if (bookmark.after.some((target) => ROOT_COMMIT_ID_PATTERN.test(target.revisionId))) {
    return tense === "will"
      ? `Bookmark ${name} will point at the root revision. Git cannot hold it.`
      : `Bookmark ${name} now points at the root revision. Git cannot hold it.`;
  }
  return null;
}

/**
 * Finds the entries for descendants a command moved.
 *
 * `startRevisionIds` are the commit ids of every revision the command itself removes or rewrites;
 * the caller knows them, this helper guesses nothing. An entry belongs when, before the run, it
 * descended from one of them. Every rewritten descendant has an entry, so walking parent links
 * through the entries finds them all. Comparing an entry's own parents does not: a child of a
 * working copy jj only recorded also has a new parent id, and a deeper descendant keeps its
 * parents' change ids.
 */
export function findMovedDescendants(
  change: ExtensionVcsMutationChange,
  startRevisionIds: readonly string[],
): ExtensionVcsMutationRevisionChange[] {
  const reached = new Set(startRevisionIds);
  const moved = new Set<ExtensionVcsMutationRevisionChange>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const entry of change.revisions) {
      if (moved.has(entry)) continue;
      const descends = entry.before.some(
        (revision) =>
          !reached.has(revision.revisionId) &&
          revision.parents.some((parent) => reached.has(parent.revisionId)),
      );
      if (!descends) continue;
      moved.add(entry);
      for (const revision of entry.before) reached.add(revision.revisionId);
      grew = true;
    }
  }
  return change.revisions.filter((entry) => moved.has(entry));
}
