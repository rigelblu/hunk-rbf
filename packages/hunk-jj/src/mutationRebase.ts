/**
 * Plan and judge moving one revision onto, before or after a chosen destination.
 * The runner observes exact versions and owns JJ processes, dry runs and readback.
 * This pure kind recognizes the observed source end and placement, including a source
 * that stayed while surrounding revisions moved; another writer cannot complete our rebase.
 */
import type {
  ExtensionVcsMutationChange,
  ExtensionVcsMutationRevision,
  ExtensionVcsMutationRevisionRef,
  ExtensionVcsMutationVerdict,
} from "hunkdiff/extension";
import type { JjMutationKind } from "./mutationKind";
import {
  countOf,
  describeRevision,
  describeBookmark,
  describeUnexportableBookmark,
  findMovedDescendants,
} from "./mutationWording";

type RevisionEnd =
  | { kind: "stayed" | "moved"; revision: ExtensionVcsMutationRevision }
  | { kind: "left" | "unrecognized" };

/** Compare stable change identity when both references carry it, else the exact version. */
function sameRevision(a: ExtensionVcsMutationRevisionRef, b: ExtensionVcsMutationRevisionRef) {
  return a.logicalId && b.logicalId ? a.logicalId === b.logicalId : a.revisionId === b.revisionId;
}
/** Compare parents without mistaking a working-copy snapshot for a placement change. */
function parentKey(revision: ExtensionVcsMutationRevision) {
  return revision.parents
    .map((parent) => parent.logicalId ?? parent.revisionId)
    .sort()
    .join(" ");
}
/** Recognize the exact observed version's end without retargeting a divergent sibling. */
function revisionEnd(
  change: ExtensionVcsMutationChange,
  original: ExtensionVcsMutationRevision,
): RevisionEnd {
  const entry = change.revisions.find((entry) =>
    entry.before.some((revision) => revision.revisionId === original.revisionId),
  );
  if (!entry) return { kind: "stayed", revision: original };
  const retained = entry.after.find((revision) => revision.revisionId === original.revisionId);
  if (retained) return { kind: "stayed", revision: retained };
  const siblings = entry.before.filter((revision) => revision.revisionId !== original.revisionId);
  const remaining = entry.after.filter(
    (revision) =>
      !siblings.some((before) => before.revisionId === revision.revisionId) &&
      !siblings.some(
        (before) =>
          before.isWorkingCopy &&
          revision.isWorkingCopy &&
          before.description === revision.description &&
          parentKey(before) === parentKey(revision),
      ),
  );
  if (remaining.length === 1 && entry.after.length === entry.before.length)
    return { kind: "moved", revision: remaining[0]! };
  if (remaining.length === 0 && entry.after.length === entry.before.length - 1)
    return { kind: "left" };
  return { kind: "unrecognized" };
}
/** Refuse to infer placement when either retained endpoint cannot be recognized. */
function placed(
  source: RevisionEnd,
  destination: RevisionEnd,
  placement: "onto" | "after" | "before",
) {
  if (!("revision" in source) || !("revision" in destination)) return false;
  return placement === "before"
    ? destination.revision.parents.some((parent) => sameRevision(parent, source.revision))
    : source.revision.parents.some((parent) => sameRevision(parent, destination.revision));
}
/** Preserve both IDs when naming the revision the refreshed history should highlight. */
function refOf(revision: ExtensionVcsMutationRevision): ExtensionVcsMutationRevisionRef {
  return { revisionId: revision.revisionId, logicalId: revision.logicalId };
}
/** Word observed effects in deterministic subject/change order and reuse shared bookmark wording. */
function describeEffects(
  change: ExtensionVcsMutationChange,
  source: ExtensionVcsMutationRevision,
  destination: ExtensionVcsMutationRevision,
  placement: "onto" | "after" | "before",
  tense: "will" | "did",
) {
  const notes: string[] = [];
  const warnings: string[] = [];
  const starts =
    placement === "onto" ? [source.revisionId] : [source.revisionId, destination.revisionId];
  const descendants = findMovedDescendants(change, starts).filter(
    (entry) => !entry.before.some((r) => r.revisionId === source.revisionId),
  );
  const destinationEntry = change.revisions.find((entry) =>
    entry.before.some((r) => r.revisionId === destination.revisionId),
  );
  const count =
    descendants.length +
    (placement === "before" && destinationEntry && !descendants.includes(destinationEntry) ? 1 : 0);
  if (count)
    notes.push(
      `${countOf(count, "other revision")} ${tense === "will" ? "will be rebased" : "rebased"}.`,
    );
  const entries = [...change.revisions].sort((a, b) => {
    const ar = a.after[0] ?? a.before[0];
    const br = b.after[0] ?? b.before[0];
    return (
      (ar?.description.split("\n", 1)[0]?.trim() ?? "").localeCompare(
        br?.description.split("\n", 1)[0]?.trim() ?? "",
      ) || (a.logicalId ?? ar?.revisionId ?? "").localeCompare(b.logicalId ?? br?.revisionId ?? "")
    );
  });
  for (const entry of entries) {
    const revision = entry.after[0] ?? entry.before[0];
    if (!revision) continue;
    const endedVersions = entry.before.map((before) => ({
      before,
      end: revisionEnd(change, before),
    }));
    for (const { before, end } of endedVersions) {
      if (!("revision" in end)) continue;
      if (!before.hasConflict && end.revision.hasConflict)
        warnings.push(
          `${describeRevision(end.revision)} ${tense === "will" ? "will have" : "now has"} conflicts.`,
        );
      if (!before.isEmpty && end.revision.isEmpty)
        notes.push(
          `${describeRevision(end.revision)} ${tense === "will" ? "will become" : "became"} empty and ${tense === "will" ? "will stay" : "stays"} in history.`,
        );
    }
    if (endedVersions.some(({ end }) => end.kind === "unrecognized")) {
      // Several divergent versions can be rewritten together. Their flags remain observable
      // even when no exact before/after pairing is justified; never hide those consequences.
      const conflicted = entry.after.filter((after) => after.hasConflict).length;
      const empty = entry.after.filter((after) => after.isEmpty).length;
      if (conflicted)
        warnings.push(
          `${countOf(conflicted, "resulting version")} of ${describeRevision(revision)} ${tense === "will" ? "will have" : conflicted === 1 ? "has" : "have"} conflicts. Their individual prior versions cannot be matched.`,
        );
      if (empty)
        notes.push(
          `${countOf(empty, "resulting version")} of ${describeRevision(revision)} ${tense === "will" ? "will be" : empty === 1 ? "is" : "are"} empty and retained in history. Their individual prior versions cannot be matched.`,
        );
    }
    if (!entry.after.length && !entry.before.some((r) => r.revisionId === source.revisionId))
      warnings.push(
        `${describeRevision(revision)} ${tense === "will" ? "will leave" : "left"} history too.`,
      );
    if (entry.after.length > entry.before.length && entry.before.length)
      warnings.push(
        `${describeRevision(revision)} ${tense === "will" ? "will have" : "has"} additional visible versions.`,
      );
  }
  for (const bookmark of [...change.bookmarks].sort((a, b) =>
    describeBookmark(a).localeCompare(describeBookmark(b)),
  )) {
    if (bookmark.followsRevision) continue;
    notes.push(
      `Bookmark ${describeBookmark(bookmark)} ${tense === "will" ? "will move" : "moved"}.`,
    );
    const warning = describeUnexportableBookmark(bookmark, tense);
    if (warning) warnings.push(warning);
  }
  return { notes, warnings };
}

/** Offer one-source captured Rebase through the shared provider registry. */
export const rebaseKind: JjMutationKind<"rebase"> = {
  kind: "rebase",
  revisions: (request) => [request.sources[0], request.destination],
  plan({ request, facts }) {
    if (request.sources.length !== 1) return { refused: "Rebase takes one revision for now." };
    const [source, destination] = facts.revisions;
    if (!source || !destination)
      return { refused: "Hunk could not read both revisions for this rebase." };
    if (source.revisionId === destination.revisionId)
      return { refused: "Choose a destination other than the source revision." };
    return {
      args: [
        "rebase",
        "-r",
        { revision: request.sources[0] },
        request.placement === "onto" ? "-o" : request.placement === "after" ? "-A" : "-B",
        { revision: request.destination },
        ...(request.skipEmptied ? ["--skip-emptied"] : []),
      ],
      preview: "dry-run",
      interactive: false,
    };
  },
  project({ request, facts, dryRun }) {
    const [source, destination] = facts.revisions;
    if (!source || !destination || !dryRun)
      return { refused: "Hunk could not read this rebase preview." };
    if (dryRun.kind === "failed")
      return {
        refused: "JJ refused this rebase. Read its message under Details.",
        providerText: dryRun.text,
      };
    if (dryRun.kind === "no-operation")
      return {
        refused:
          dryRun.text.trim() === "Nothing changed."
            ? "The revision is already in that position. Nothing would change."
            : "Hunk could not recognize the rebase preview.",
        providerText: dryRun.text,
      };
    const sourceEnd = revisionEnd(dryRun.change, source);
    const destinationEnd = revisionEnd(dryRun.change, destination);
    if (
      sourceEnd.kind === "unrecognized" ||
      (sourceEnd.kind !== "left" && !placed(sourceEnd, destinationEnd, request.placement))
    )
      return {
        refused: "Hunk could not recognize the source and destination in this rebase preview.",
        providerText: dryRun.text,
      };
    const effects = describeEffects(dryRun.change, source, destination, request.placement, "will");
    if (sourceEnd.kind === "left")
      effects.warnings.unshift(`${describeRevision(source)} will leave history in this rebase.`);
    if (source.isDivergent)
      effects.notes.push(
        "Only this version is moved. Another version of the change stays unless the preview says otherwise.",
      );
    if (facts.files.kind === "pending" && source.isWorkingCopy)
      effects.warnings.push(
        `This is the working-copy revision. Its unrecorded changes to ${countOf(facts.files.paths.length, "file")} move with it.`,
      );
    return {
      headline: `Move ${describeRevision(source)} ${request.placement} ${describeRevision(destination)}`,
      ...effects,
      named: [
        { label: "Source", revision: refOf(source) },
        { label: "Destination", revision: refOf(destination) },
      ],
    };
  },
  judge({ request, facts, process, change, preview }) {
    const [source, destination] = facts.revisions;
    const verdict = (
      outcome: ExtensionVcsMutationVerdict["outcome"],
      headline: string,
    ): ExtensionVcsMutationVerdict => ({
      outcome,
      headline,
      notes: [],
      warnings: [],
      named:
        source && destination
          ? [
              { label: "Source", revision: refOf(source) },
              { label: "Destination", revision: refOf(destination) },
            ]
          : [],
    });
    if (!source || !destination || !change)
      return verdict("unexpected", "Hunk could not read back the result of this rebase.");
    if (!process.started || process.exitCode !== 0 || process.signal !== null)
      return verdict(
        "failed",
        "JJ reported a failure while rebasing. Read the actual result and provider message.",
      );
    if (!change.operations.some((operation) => operation.isOwn && !operation.isSnapshot)) {
      const noOp = verdict("no-op", "No operation was recognized as this rebase.");
      const changed = change.revisions.some((entry) =>
        entry.before.some(
          (r) => r.revisionId === source.revisionId || r.revisionId === destination.revisionId,
        ),
      );
      if (changed)
        noOp.warnings.push(
          "The source or destination changed under an operation Hunk does not recognize as its own rebase.",
        );
      else noOp.headline = "The revision is already in that position. Nothing changed.";
      return noOp;
    }
    const sourceEnd = revisionEnd(change, source);
    const destinationEnd = revisionEnd(change, destination);
    if (sourceEnd.kind === "unrecognized")
      return verdict(
        "unexpected",
        "JJ ran, but Hunk could not recognize where the source revision ended.",
      );
    if (sourceEnd.kind === "left" && (!preview || revisionEnd(preview, source).kind !== "left"))
      return verdict("unexpected", "The source left history, which was not shown in the preview.");
    if (sourceEnd.kind !== "left" && !placed(sourceEnd, destinationEnd, request.placement))
      return verdict(
        "unexpected",
        "JJ ran, but the source is not in the position that was confirmed.",
      );
    const completed = verdict(
      "completed",
      sourceEnd.kind === "left"
        ? `${describeRevision(source)} left history as previewed.`
        : `Moved ${describeRevision(source)} ${request.placement} ${describeRevision(destination)}`,
    );
    const effects = describeEffects(change, source, destination, request.placement, "did");
    completed.notes.push(...effects.notes);
    completed.warnings.push(...effects.warnings);
    if ("revision" in sourceEnd) completed.selectAfter = refOf(sourceEnd.revision);
    else if ("revision" in destinationEnd)
      completed.selectAfter =
        request.placement === "before"
          ? destinationEnd.revision.parents[0]
          : refOf(destinationEnd.revision);
    return completed;
  },
};
