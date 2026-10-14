import type { ExtensionVcsHistoryScope } from "../../extension-api/types";
import type { HistoryAcceptedInput } from "../run/commandInputs";
import type { HistoryCommit, HistoryGraphRow } from "./types";

/** Retain the last known immutable identity and description of one marked revision. */
export interface RevisionMark {
  readonly revisionId: string;
  readonly logicalId?: string;
  readonly subject: string;
  /**
   * Names the history rows in which this exact revision id was last present: the traversal
   * input plus the scope the provider applied (`revisionMarkSeenUnder`). Rows read under any
   * other name say nothing about where the revision went.
   */
  readonly seenUnder: string;
}

/** Describes the replacement rows a refresh reconciles marks against. */
export interface RevisionMarkEvidence {
  /** Names the replacement rows the same way a mark records where it was last seen. */
  readonly seenUnder: string;
  /** Whether the rows are a finished, unlimited, unfiltered read of that traversal. */
  readonly complete: boolean;
}

/** Keep unresolved intent visible without substituting a highlighted revision. */
export type RevisionMarkResolution =
  | { readonly kind: "resolved"; readonly mark: RevisionMark; readonly revisionId: string }
  | {
      readonly kind: "unresolved";
      readonly mark: RevisionMark;
      readonly reason: "missing" | "ambiguous" | "incomplete";
    };

export type RevisionMarkStatus = "ready" | "checking" | "refresh-failed";

/** Describe exact internal operation targets; blocked results never contain partial IDs. */
export type HistoryOperationTargets =
  | {
      readonly kind: "ready";
      readonly source: "marks" | "highlight";
      readonly generation: number;
      readonly revisionIds: readonly string[];
    }
  | {
      readonly kind: "blocked";
      readonly reason: "checking" | "refresh-failed" | "unresolved";
      readonly unresolved: readonly RevisionMark[];
    }
  | { readonly kind: "empty" };

/** Copy provider identity into immutable local mark intent, recording the rows it was seen in. */
export function revisionMark(
  commit: Pick<HistoryCommit, "revisionId" | "logicalId" | "subject">,
  seenUnder: string,
): RevisionMark {
  return Object.freeze({
    revisionId: commit.revisionId,
    ...(commit.logicalId ? { logicalId: commit.logicalId } : {}),
    subject: commit.subject,
    seenUnder,
  });
}

/**
 * Require complete, unlimited, unfiltered traversal evidence before logical fallback. The rows
 * must hold every visible revision in scope for an absent exact id to mean "rewritten": under a
 * revision expression or `--first-parent` the marked revision can sit unchanged outside the rows.
 * Only the input kinds listed here can be eligible: an unlisted kind is denied, and the `never`
 * binding fails typecheck until a new kind states its own rule.
 */
export function revisionMarkLogicalFallbackEligible(input: HistoryAcceptedInput): boolean {
  switch (input.kind) {
    // A symbolic expression such as `@` can resolve elsewhere between reads, so no read of it
    // proves a revision gone.
    case "expression":
      return false;
    case "history":
      return (
        input.revision === undefined &&
        !input.firstParent &&
        input.maxCount === undefined &&
        input.author === undefined &&
        input.grep === undefined &&
        input.since === undefined &&
        input.until === undefined &&
        !input.pathspecs?.length
      );
    default: {
      const unlistedInput: never = input;
      void unlistedInput;
      return false;
    }
  }
}

/**
 * Name the traversal domain without treating an eligible stream as the whole repository. Every
 * input kind lists the fields that select its revisions. An unlisted kind keys on its whole
 * input, so two different inputs never compare equal, and the `never` binding fails typecheck
 * until a new kind lists its fields.
 */
export function revisionMarkTraversalKey(input: HistoryAcceptedInput): string {
  switch (input.kind) {
    case "expression":
      return JSON.stringify([input.kind, input.expression, input.maxCount]);
    case "history":
      return JSON.stringify([
        input.kind,
        input.revision,
        Boolean(input.all),
        Boolean(input.firstParent),
        input.maxCount,
        input.author,
        input.grep,
        input.since,
        input.until,
        input.pathspecs ?? [],
      ]);
    default: {
      const unlistedInput: never = input;
      return JSON.stringify([(unlistedInput as { kind?: unknown }).kind, unlistedInput]);
    }
  }
}

/**
 * Name the rows one history source produces: its traversal key plus the scope the provider
 * applied. Two names are equal only for the same traversal with the same bound, the same
 * fallback reason, or no scope on both. A moved bound hides or reveals revisions without
 * rewriting them, so it must never compare equal. An unlisted scope kind keys on its whole
 * value, and the `never` binding fails typecheck until a new kind lists its fields.
 */
export function revisionMarkSeenUnder(
  traversalKey: string,
  scope: ExtensionVcsHistoryScope | undefined,
): string {
  if (!scope) return JSON.stringify([traversalKey, null]);
  switch (scope.kind) {
    case "bounded":
      return JSON.stringify([traversalKey, scope.kind, scope.boundaryRevisionId]);
    case "fallback":
      return JSON.stringify([traversalKey, scope.kind, scope.reason]);
    default: {
      const unlistedKind: never = scope;
      return JSON.stringify([traversalKey, "unlisted", unlistedKind]);
    }
  }
}

/**
 * Resolve every intent exact-first, reserving exact targets before unique logical candidates.
 *
 * A mark whose exact revision id is in the rows is resolved, and now records these rows as where
 * it was last seen. A mark whose id is absent may follow its logical id, or be called missing or
 * ambiguous, only when the rows are complete and carry the name the mark last recorded.
 * Otherwise the rows prove nothing about it: it is `incomplete` and keeps its record, so it
 * stays `incomplete` across any number of refreshes until its exact id is seen again.
 */
export function reconcileRevisionMarks(
  marks: readonly RevisionMark[],
  rows: readonly HistoryGraphRow[],
  evidence: RevisionMarkEvidence,
): readonly RevisionMarkResolution[] {
  const provesAbsence = (mark: RevisionMark) =>
    evidence.complete && mark.seenUnder === evidence.seenUnder;
  const exact = new Map(rows.map((row) => [row.commit.revisionId, row.commit]));
  const logical = new Map<string, HistoryCommit[]>();
  for (const row of rows) {
    if (!row.commit.logicalId) continue;
    const entries = logical.get(row.commit.logicalId) ?? [];
    entries.push(row.commit);
    logical.set(row.commit.logicalId, entries);
  }
  const reserved = new Set(
    marks.filter((mark) => exact.has(mark.revisionId)).map((mark) => mark.revisionId),
  );
  const candidates = marks.map((mark) =>
    !exact.has(mark.revisionId) && provesAbsence(mark) && mark.logicalId
      ? (logical.get(mark.logicalId) ?? [])
      : [],
  );
  const claims = new Map<string, number>();
  for (const entries of candidates) {
    if (entries.length === 1)
      claims.set(entries[0]!.revisionId, (claims.get(entries[0]!.revisionId) ?? 0) + 1);
  }
  return Object.freeze(
    marks.map((mark, index): RevisionMarkResolution => {
      const immutable = exact.get(mark.revisionId);
      if (immutable)
        return Object.freeze({
          kind: "resolved",
          mark: revisionMark(immutable, evidence.seenUnder),
          revisionId: immutable.revisionId,
        });
      if (!provesAbsence(mark))
        return Object.freeze({ kind: "unresolved", mark, reason: "incomplete" });
      const entries = candidates[index]!;
      const candidate = entries[0];
      if (entries.length !== 1 || !candidate)
        return Object.freeze({
          kind: "unresolved",
          mark,
          reason: entries.length > 1 ? "ambiguous" : "missing",
        });
      if (reserved.has(candidate.revisionId) || claims.get(candidate.revisionId)! > 1)
        return Object.freeze({ kind: "unresolved", mark, reason: "ambiguous" });
      return Object.freeze({
        kind: "resolved",
        mark: revisionMark(candidate, evidence.seenUnder),
        revisionId: candidate.revisionId,
      });
    }),
  );
}

/** Derive immutable provider-ordered targets, preserving blocked intent without fallback. */
export function historyOperationTargets({
  marks,
  status,
  rows,
  selected,
  generation,
  allowHighlightedFallback = true,
}: {
  marks: readonly RevisionMarkResolution[];
  status: RevisionMarkStatus;
  rows: readonly HistoryGraphRow[];
  selected: number;
  generation: number;
  /** False inside explicit operation source selection, where an empty set stays empty. */
  allowHighlightedFallback?: boolean;
}): HistoryOperationTargets {
  if (marks.length > 0) {
    const unresolved = Object.freeze(
      marks.filter((entry) => entry.kind === "unresolved").map((entry) => entry.mark),
    );
    if (status !== "ready") return Object.freeze({ kind: "blocked", reason: status, unresolved });
    const ids = new Set(
      marks.filter((entry) => entry.kind === "resolved").map((entry) => entry.revisionId),
    );
    const revisionIds = rows
      .filter((row) => ids.has(row.commit.revisionId))
      .map((row) => row.commit.revisionId);
    if (unresolved.length > 0 || revisionIds.length !== marks.length)
      return Object.freeze({ kind: "blocked", reason: "unresolved", unresolved });
    return Object.freeze({
      kind: "ready",
      source: "marks",
      generation,
      revisionIds: Object.freeze(revisionIds),
    });
  }
  if (!allowHighlightedFallback) return Object.freeze({ kind: "empty" });
  const focus = rows[selected];
  return focus
    ? Object.freeze({
        kind: "ready",
        source: "highlight",
        generation,
        revisionIds: Object.freeze([focus.commit.revisionId]),
      })
    : Object.freeze({ kind: "empty" });
}
