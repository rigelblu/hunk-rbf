/** Format observed mutation facts for the shared confirmation and saved result. */
import type {
  ExtensionVcsMutationChange,
  ExtensionVcsMutationPrepared,
  ExtensionVcsMutationResult,
  ExtensionVcsMutationRevision,
  ExtensionVcsMutationRevisionRef,
} from "../../extension-api/types";
import { sanitizeTerminalLine } from "../../lib/terminalText";

export const MUTATION_UNDO_NOTICE =
  "Hunk cannot undo this yet. The result names the jj command that reverses it, and when that command stays clean.";
export const MUTATION_OTHER_TOOLS_NOTICE =
  "Other tools can still change files or history after the last check.";
export const MUTATION_STALE_NOTICE =
  "The working copy is stale. Run jj workspace update-stale; it preserves unsaved edits in another visible version.";

/** Name one exact observed version without assuming logical identity is unique. */
function identity(ref: ExtensionVcsMutationRevisionRef, full: boolean) {
  const shorten = (id: string) => (full ? id : id.slice(0, 8));
  return `${ref.logicalId ? `${shorten(ref.logicalId)} · ` : ""}${shorten(ref.revisionId)}`;
}
/** Preserve multiline provider text while removing terminal controls from every line. */
export function mutationSafeLines(lines: readonly string[]): string[] {
  return lines.flatMap((line) => line.split(/\r?\n/).map(sanitizeTerminalLine));
}
/** Include the revision properties that determine whether the action is acceptable. */
function revisionLines(label: string, revision: ExtensionVcsMutationRevision, full: boolean) {
  return [
    `${label}: ${identity(revision, full)} · ${revision.description.split("\n")[0] || "(no description)"}`,
    ...(full ? ["Full description:", revision.description || "(no description)"] : []),
    `Parents: ${revision.parents.map((parent) => identity(parent, full)).join(", ") || "none"}`,
    `Bookmarks: ${revision.bookmarks.map((bookmark) => (bookmark.remote ? `${bookmark.name}@${bookmark.remote}` : bookmark.name)).join(", ") || "none"}`,
    `Empty: ${revision.isEmpty ? "yes" : "no"} · Conflict: ${revision.hasConflict ? "yes" : "no"} · Divergent: ${revision.isDivergent ? "yes" : "no"} · Working copy: ${revision.isWorkingCopy ? "yes" : "no"}`,
  ];
}
/** Project actual changed revisions and bookmark moves, excluding bookmarks that only follow. */
function changeLines(change: ExtensionVcsMutationChange, full: boolean, omitOwnOperations = false) {
  return [
    ...change.revisions.flatMap((entry) => [
      `Change ${entry.logicalId ?? entry.before[0]?.revisionId ?? entry.after[0]?.revisionId ?? "unknown"}:`,
      ...entry.before.map(
        (revision) =>
          `Before ${identity(revision, full)} · parents ${revision.parents.map((parent) => identity(parent, full)).join(", ") || "none"} · empty ${revision.isEmpty} · conflict ${revision.hasConflict}`,
      ),
      ...entry.after.map(
        (revision) =>
          `After ${identity(revision, full)} · parents ${revision.parents.map((parent) => identity(parent, full)).join(", ") || "none"} · empty ${revision.isEmpty} · conflict ${revision.hasConflict}`,
      ),
      ...(entry.after.length ? [] : ["Left history"]),
    ]),
    ...change.bookmarks
      .filter((bookmark) => !bookmark.followsRevision)
      .map(
        (bookmark) =>
          `Bookmark ${bookmark.name}${bookmark.remote ? `@${bookmark.remote}` : ""}: ${bookmark.before.map((ref) => identity(ref, full)).join(", ") || "none"} → ${bookmark.after.map((ref) => identity(ref, full)).join(", ") || "none"}${bookmark.isConflicted ? " (conflicted)" : ""}`,
      ),
    ...(full
      ? change.operations
          .filter((operation) => !omitOwnOperations || !operation.isOwn || operation.isSnapshot)
          .map(
            (operation) =>
              `Operation ${operation.operationId}: ${operation.description}${operation.isSnapshot ? " (snapshot)" : ""}${operation.isOwn ? " (this action)" : " (another writer)"}`,
          )
      : []),
  ];
}
/** Compare semantic preview effects without treating different rewritten commit ids as differences. */
export function mutationEffectKey(change: ExtensionVcsMutationChange) {
  const ref = (r: ExtensionVcsMutationRevisionRef) => r.logicalId ?? r.revisionId;
  return JSON.stringify({
    revisions: change.revisions
      .map((entry) => ({
        id: entry.logicalId ?? entry.before[0]?.revisionId ?? entry.after[0]?.revisionId,
        before: entry.before.map((r) => ({
          parents: r.parents.map(ref).sort(),
          empty: r.isEmpty,
          conflict: r.hasConflict,
        })),
        after: entry.after.map((r) => ({
          parents: r.parents.map(ref).sort(),
          empty: r.isEmpty,
          conflict: r.hasConflict,
        })),
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    bookmarks: change.bookmarks
      .filter((b) => !b.followsRevision)
      .map((b) => ({
        name: b.name,
        remote: b.remote,
        before: b.before.map(ref).sort(),
        after: b.after.map(ref).sort(),
        conflict: b.isConflicted,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
}
/** Build confirmation body in the shared mutation contract's reading order. */
export function mutationConfirmationLines(prepared: ExtensionVcsMutationPrepared, full = false) {
  const lines = [prepared.projection.headline];
  for (const named of prepared.projection.named) {
    const revision = prepared.facts.revisions.find(
      (revision) => revision.revisionId === named.revision.revisionId,
    );
    if (revision) lines.push(...revisionLines(named.label, revision, full));
    else lines.push(`${named.label}: ${identity(named.revision, full)}`);
  }
  lines.push(...prepared.projection.warnings.map((warning) => `Warning: ${warning}`));
  const files = prepared.facts.files;
  lines.push(
    files.kind === "clean"
      ? "No pending changes detected."
      : files.kind === "unknown"
        ? `Pending changes could not be read: ${files.reason}`
        : "Pending changes:",
  );
  if (files.kind === "pending") lines.push(...files.paths);
  if (prepared.preview) lines.push(...changeLines(prepared.preview, full));
  lines.push(...prepared.projection.notes);
  if (prepared.description !== undefined)
    lines.push(
      prepared.request.kind === "squash"
        ? "Preview description only; the editor chooses the final description."
        : "Composed description:",
      prepared.description || "(no description)",
    );
  if (prepared.request.kind === "rebase")
    lines.push(
      `Abandon the moved revision if this empties it: ${prepared.request.skipEmptied ? "on" : "off"}`,
    );
  lines.push(MUTATION_UNDO_NOTICE, MUTATION_OTHER_TOOLS_NOTICE);
  if (prepared.isInteractive)
    lines.push("JJ opens your editor when a combined description is needed.");
  if (full)
    lines.push(
      `Observed operation: ${prepared.facts.operationId}`,
      ...(prepared.previewText ? ["Provider preview:", prepared.previewText] : []),
    );
  return mutationSafeLines(lines);
}
/** Summarize only a fully observed clean Squash; the controller separately settles refresh and cleanup. */
export function cleanSquashResultNotice(
  result: ExtensionVcsMutationResult | null,
  prepared: ExtensionVcsMutationPrepared | null,
): string | null {
  if (
    !prepared ||
    prepared.request.kind !== "squash" ||
    result?.kind !== "ran" ||
    result.verdict.outcome !== "completed" ||
    result.change.kind !== "read" ||
    result.isWorkingCopyStale ||
    !result.process.started ||
    result.process.exitCode !== 0 ||
    result.process.signal ||
    result.process.wasInterrupted ||
    !result.process.terminalRestored ||
    result.verdict.warnings.length ||
    result.verdict.notes.some((note) => !/^\d+ other revisions? rebased\.$/.test(note)) ||
    prepared.projection.warnings.length
  )
    return null;
  const change = result.change.value;
  if (
    !change.operations.some((op) => op.isOwn && !op.isSnapshot) ||
    change.operations.some((op) => !op.isOwn && !op.isSnapshot) ||
    change.revisions.some((entry) => entry.after.some((r) => r.hasConflict || r.isDivergent)) ||
    change.bookmarks.some((bookmark) => bookmark.isConflicted) ||
    (prepared.preview && mutationEffectKey(prepared.preview) !== mutationEffectKey(change))
  )
    return null;
  const request = prepared.request;
  const sources = request.sources.filter(
    (source) => source.revisionId !== request.destination.revisionId,
  );
  if (
    !sources.length ||
    new Set(sources.map((source) => source.revisionId)).size !== sources.length ||
    sources.some((source) => {
      const entries = change.revisions.filter((entry) =>
        entry.before.some((r) => r.revisionId === source.revisionId),
      );
      return (
        entries.length !== 1 ||
        entries[0]!.after.length > 1 ||
        entries[0]!.after.some((r) => !r.isEmpty || r.revisionId === source.revisionId)
      );
    })
  )
    return null;
  const destinations = change.revisions.filter((entry) =>
    entry.before.some((r) => r.revisionId === request.destination.revisionId),
  );
  if (destinations.length !== 1 || destinations[0]!.after.length !== 1) return null;
  const destination = destinations[0]!.after[0]!;
  if (destination.revisionId === request.destination.revisionId) return null;
  const id = destination.logicalId ?? destination.revisionId;
  if (!id || /[^a-zA-Z0-9-]/.test(id)) return null;
  return `${sources.length} ${sources.length === 1 ? "revision was" : "revisions were"} squashed.`;
}
/** Build a result from actual readback, keeping failures and unknown effects inspectable. */
export function mutationResultLines(
  result: ExtensionVcsMutationResult | null,
  prepared: ExtensionVcsMutationPrepared | null,
  full = false,
  options: { compact?: boolean } = {},
) {
  if (!result) return [];
  if (result.kind === "not-run")
    return mutationSafeLines([
      result.reason === "start-failed"
        ? "The command could not be started. Nothing ran."
        : "The command did not run.",
      ...(result.reason === "start-failed"
        ? [result.text]
        : result.reason === "changed"
          ? [result.detail]
          : [result.reason]),
    ]);
  const lines = [result.verdict.headline];
  const squashFull = full && prepared?.request.kind === "squash";
  if (squashFull && prepared.request.kind === "squash")
    lines.push(
      ...prepared.request.sources.map((source) => `Source: ${identity(source, true)}`),
      `Destination before: ${identity(prepared.request.destination, true)}`,
    );
  lines.push(
    ...(options.compact
      ? []
      : result.verdict.named.map((named) => `${named.label}: ${identity(named.revision, full)}`)),
    ...result.verdict.warnings.map((warning) => `Warning: ${warning}`),
    ...result.verdict.notes,
  );
  if (result.change.kind === "unread")
    lines.push(`The result could not be read back: ${result.change.reason}`);
  else {
    if (!options.compact) lines.push(...changeLines(result.change.value, full, squashFull));
    if (
      prepared?.preview &&
      mutationEffectKey(prepared.preview) !== mutationEffectKey(result.change.value)
    )
      lines.push("The actual changes differ from the preview. Read the actual result above.");
    if (
      result.change.value.operations.some((operation) => !operation.isOwn && !operation.isSnapshot)
    )
      lines.push("Another writer recorded changes while this action ran.");
    const own = result.change.value.operations.filter(
      (operation) => operation.isOwn && !operation.isSnapshot,
    );
    for (const operation of own) {
      lines.push(
        ...(squashFull
          ? ["Revert this recorded operation:"]
          : [`Recorded as operation ${operation.operationId}.`]),
        squashFull
          ? `jj op revert ${operation.operationId}`
          : `To reverse this operation, run: jj op revert ${operation.operationId}`,
        squashFull
          ? "Later repository changes may cause conflicts or divergence. Inspect the result carefully."
          : "That stays clean only while nothing since has rewritten a revision this operation moved.",
      );
    }
  }
  if (result.isWorkingCopyStale) lines.push(MUTATION_STALE_NOTICE);
  if (
    full ||
    (!options.compact &&
      (result.verdict.outcome === "failed" || result.verdict.outcome === "unexpected"))
  )
    lines.push("Provider output:", result.process.text || "(no output)");
  return mutationSafeLines(lines);
}
