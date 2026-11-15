/**
 * Prepares and applies history changes by running plain `jj` processes.
 *
 * A history command asks to abandon, squash, rebase or split. `prepare` reads
 * the facts, asks the kind for a plan, previews it with a dry run that jj
 * never makes current, and returns the kind's words for the confirm step.
 * `apply` checks that nothing moved since that preview, lets the host run the
 * command once, reads back what jj recorded and asks the kind for a verdict.
 *
 * This module owns every process and every read. A kind module owns the
 * arguments and the wording, and stays pure. The host owns the terminal, the
 * confirmation and the rule that one mutation runs at a time. Recovery rests
 * on jj's own operation log: nothing here keeps state outside the repository.
 */
import { createHash, randomUUID } from "node:crypto";
import { runAbortableCommand } from "@hunk/vcs/async-process";
import type {
  ExtensionVcsMutationBookmarkChange,
  ExtensionVcsMutationCapability,
  ExtensionVcsMutationChange,
  ExtensionVcsMutationFacts,
  ExtensionVcsMutationFileState,
  ExtensionVcsMutationOperation,
  ExtensionVcsMutationPreparation,
  ExtensionVcsMutationPrepared,
  ExtensionVcsMutationRequest,
  ExtensionVcsMutationResult,
  ExtensionVcsMutationRevision,
  ExtensionVcsMutationRevisionChange,
  ExtensionVcsMutationRevisionRef,
  ExtensionVcsMutationRevisionState,
} from "hunkdiff/extension";
import {
  isJjMutationRefusal,
  type JjDryRun,
  type JjMutationKind,
  type JjMutationPlan,
} from "./mutationKind";
import { JJ_MUTATION_KINDS, listJjMutationKinds } from "./mutationKinds";

/** The lowest jj the mutation tests have passed on. */
export const JJ_MUTATION_MINIMUM_VERSION = "0.46.0";

/** How far back the read-back looks for the operation the facts were read at. */
const OPERATION_READ_LIMIT = 200;
/** How long the read-back after a command may take. It runs on its own clock, so a stopped command is still read. */
const READ_BACK_TIMEOUT_MS = 30_000;
const COMMAND_WORD_PATTERN = /^[a-z][a-z-]*$/;
/** How many change ids one revset names, so a large rebase never outgrows the command line. */
const CHANGE_ID_CHUNK_SIZE = 300;
const COMMIT_ID_PATTERN = /^[0-9a-f]{40,64}$/;
const CHANGE_ID_PATTERN = /^[a-z]{8,64}$/;
const OPERATION_ID_PATTERN = /^[0-9a-f]{8,128}$/;
/** Any line jj prints for an operation it wrote and did not make current, snapshot or not. */
const UNCOMMITTED_LINE_PATTERN =
  /^(Snapshot operation|Operation) left uncommitted because --no-integrate-operation was requested: ([0-9a-f]+)/gm;
const GIT_IMPORT_WAITING_REASON =
  "Git has changes JJ has not read yet. Run `jj git import`, then try again.";
const STALE_WORKING_COPY_PATTERN = /working copy is stale/i;

/** One JSON object per revision, so descriptions and bookmark names survive any character. */
const REVISION_TEMPLATE =
  '"{\\"c\\":\\"" ++ commit_id ++ "\\",\\"g\\":\\"" ++ change_id ++ "\\",\\"p\\":[" ++ ' +
  'parents.map(|p| "[\\"" ++ p.commit_id() ++ "\\",\\"" ++ p.change_id() ++ "\\"]").join(",") ++ ' +
  '"],\\"d\\":" ++ description.escape_json() ++ ",\\"e\\":" ++ empty ++ ",\\"x\\":" ++ conflict ++ ' +
  '",\\"v\\":" ++ divergent ++ ",\\"w\\":" ++ current_working_copy ++ ",\\"i\\":" ++ immutable ++ ' +
  '",\\"r\\":" ++ root ++ ",\\"h\\":" ++ hidden ++ ",\\"b\\":[" ++ ' +
  'local_bookmarks.map(|b| b.name().escape_json()).join(",") ++ "],\\"rb\\":[" ++ ' +
  'remote_bookmarks.map(|b| "[" ++ b.name().escape_json() ++ "," ++ b.remote().escape_json() ++ "]").join(",") ++ ' +
  '"]}\\n"';

const OPERATION_TEMPLATE =
  '"{\\"o\\":\\"" ++ id ++ "\\",\\"s\\":" ++ snapshot ++ ",\\"d\\":" ++ description.escape_json() ++ ' +
  '",\\"a\\":" ++ attributes.escape_json() ++ ",\\"p\\":[" ++ ' +
  'parents.map(|p| "\\"" ++ p.id() ++ "\\"").join(",") ++ "]}\\n"';

const BOOKMARK_TEMPLATE =
  '"{\\"n\\":" ++ name.escape_json() ++ ",\\"r\\":" ++ if(remote, remote.escape_json(), "null") ++ ' +
  '",\\"x\\":" ++ conflict ++ ",\\"t\\":[" ++ ' +
  'added_targets.map(|c| "[\\"" ++ c.commit_id() ++ "\\",\\"" ++ c.change_id() ++ "\\"]").join(",") ++ ' +
  '"]}\\n"';

export interface JjMutationRunnerOptions {
  jjExecutable?: string;
  /** The environment for jj's reads. Absent: jj inherits Hunk's, so it reads the user's configuration. */
  env?: Record<string, string | undefined>;
}

/** Where and how one call runs jj. */
interface JjSession {
  jjExecutable: string;
  env?: Record<string, string | undefined>;
  cwd: string;
  signal?: AbortSignal;
}

/** One observed revision, plus whether jj still shows it. */
interface ObservedRevision extends ExtensionVcsMutationRevision {
  isHidden: boolean;
}

/** What the working copy holds that jj has not recorded. */
interface PendingRead {
  files: ExtensionVcsMutationFileState;
  isStale: boolean;
  /** A digest of the pending content, so a file saved again under the same name is not "the same". */
  fingerprint: string;
  /**
   * Git moved a ref jj has not read. The next jj command would import it, and that import can
   * hide or abandon revisions nobody chose, so no preview, check or run goes ahead with it waiting.
   */
  isImportWaiting: boolean;
}

/** Everything `apply` needs from a preparation that reached the confirm step. */
interface PreparedMutation {
  kind: JjMutationKind;
  plan: JjMutationPlan;
  prepared: ExtensionVcsMutationPrepared;
  /** The command's arguments, each revision already addressed and checked against the facts. */
  args: string[];
  /** Each address in `args` with the exact revision it must name. */
  addresses: ResolvedAddress[];
  /** The jj subcommand, which the command's own operation is recognised by. */
  commandWord: string;
  fingerprint: string;
}

/** One revision address handed to jj, and the exact revision it has to resolve to. */
interface ResolvedAddress {
  address: string;
  revisionId: string;
}

/** A refusal jj caused, carrying its own text for Details. */
class JjReadError extends Error {
  constructor(
    message: string,
    readonly providerText: string,
  ) {
    super(message);
  }
}

/** Runs jj and returns its output without judging the exit code. */
async function runJj(session: JjSession, args: readonly string[]) {
  // `ui.quiet` in the user's configuration would hide the lines the runner reads its operation ids from.
  const command = [
    session.jjExecutable,
    "--no-pager",
    "--color",
    "never",
    "--config",
    "ui.quiet=false",
    // A wrapped line would break the one-record-per-line reads.
    "--config",
    "ui.log-word-wrap=false",
    // A read or a dry run keeps no commit, so it must never start the user's signing helper.
    "--config",
    "signing.behavior=drop",
    ...args,
  ];
  return runAbortableCommand(command, {
    cwd: session.cwd,
    env: session.env,
    signal: session.signal,
  });
}

/** Joins jj's two streams the way a terminal would show them. */
function jjText(result: { stdout: string; stderr: string }): string {
  return [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
}

/** Runs a read that never touches the working copy, and fails with jj's text. */
async function readJj(session: JjSession, args: readonly string[]): Promise<string> {
  const result = await runJj(session, ["--ignore-working-copy", ...args]);
  if (result.exitCode !== 0) {
    throw new JjReadError("JJ could not read the repository.", jjText(result));
  }
  return result.stdout;
}

/** Parses one JSON object per line. Text that is not what the template wrote is a refusal, never a crash. */
function parseJsonLines<T>(text: string): T[] {
  try {
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
  } catch {
    throw new JjReadError("JJ's output was not what Hunk expects.", text.slice(0, 2000));
  }
}

/** Compares dotted versions numerically: "0.46.0" is not below "0.46.0". */
function isVersionBelow(version: string, minimum: string): boolean {
  const parse = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [left, right] = [parse(version), parse(minimum)];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0;
  }
  return false;
}

/** Reads the installed jj's version, for example "0.46.0". */
async function readJjVersion(session: JjSession): Promise<string> {
  const result = await runJj(session, ["--version"]);
  const version = /\b(\d+\.\d+\.\d+)/.exec(result.stdout)?.[1];
  if (result.exitCode !== 0 || !version) {
    throw new JjReadError("Hunk could not read the jj version.", jjText(result));
  }
  return version;
}

/** Reads the repository's current operation without recording the working copy. */
async function readCurrentOperation(session: JjSession): Promise<string> {
  const id = (await readJj(session, ["op", "log", "--no-graph", "-n", "1", "-T", "id"])).trim();
  if (!OPERATION_ID_PATTERN.test(id)) throw new JjReadError("JJ named no current operation.", id);
  return id;
}

interface RevisionRecord {
  c: string;
  g: string;
  p: [string, string][];
  d: string;
  e: boolean;
  x: boolean;
  v: boolean;
  w: boolean;
  i: boolean;
  r: boolean;
  h: boolean;
  b: string[];
  rb: [string, string][];
}

/** Reads the revisions a revset names, as they stood at one operation. */
async function readRevisions(
  session: JjSession,
  operationId: string,
  revset: string,
): Promise<ObservedRevision[]> {
  const output = await readJj(session, [
    "--at-op",
    operationId,
    "log",
    "--no-graph",
    "-r",
    revset,
    "-T",
    REVISION_TEMPLATE,
  ]);
  return parseJsonLines<RevisionRecord>(output).map((record) => ({
    revisionId: record.c,
    logicalId: record.g,
    parents: record.p.map(([revisionId, logicalId]) => ({ revisionId, logicalId })),
    description: record.d,
    isEmpty: record.e,
    hasConflict: record.x,
    isDivergent: record.v,
    isWorkingCopy: record.w,
    isImmutable: record.i,
    isRoot: record.r,
    isHidden: record.h,
    bookmarks: [
      ...record.b.map((name) => ({ name })),
      // A colocated repository mirrors every local bookmark to the `git` remote; that is not a remote of the user's.
      ...record.rb
        .filter(([, remote]) => remote !== "git")
        .map(([name, remote]) => ({ name, remote })),
    ],
  }));
}

/** Drops the runner's own bookkeeping before a revision leaves this module. */
function toPublicRevision({
  isHidden: _isHidden,
  ...revision
}: ObservedRevision): ExtensionVcsMutationRevision {
  return revision;
}

/** Reads one revision by its exact id. Null when jj does not know the id. */
async function readRevisionById(
  session: JjSession,
  operationId: string,
  revisionId: string,
): Promise<ObservedRevision | null> {
  if (!COMMIT_ID_PATTERN.test(revisionId)) return null;
  try {
    return (await readRevisions(session, operationId, `commit_id(${revisionId})`))[0] ?? null;
  } catch (error) {
    if (error instanceof JjReadError) return null;
    throw error;
  }
}

/**
 * Reads the working-copy file changes jj has not recorded.
 *
 * `jj --no-integrate-operation status` writes a snapshot jj never makes
 * current. The pending paths are the difference between `@` at the given
 * operation and `@` at that snapshot. Plain `status` output is not used: it
 * also lists files `@` already recorded.
 */
async function readPendingFiles(session: JjSession, operationId: string): Promise<PendingRead> {
  const read = (
    files: ExtensionVcsMutationFileState,
    extra: Partial<PendingRead> = {},
  ): PendingRead => ({ files, isStale: false, fingerprint: "", isImportWaiting: false, ...extra });

  const status = await runJj(session, ["--no-integrate-operation", "status"]);
  const text = jjText(status);
  if (status.exitCode !== 0) {
    return read(
      { kind: "unknown", reason: text },
      { isStale: STALE_WORKING_COPY_PATTERN.test(text) },
    );
  }
  const lines = [...status.stderr.matchAll(UNCOMMITTED_LINE_PATTERN)];
  const snapshots = lines.filter((line) => line[1] === "Snapshot operation");
  // `status` rewrites nothing itself, so any other operation it wrote is an import of Git refs.
  const isImportWaiting = lines.length > snapshots.length;
  const snapshotId = snapshots[0]?.[2];
  if (!snapshotId || snapshots.length > 1) {
    // A line about an operation or a snapshot that is not the one known line must never read as "clean".
    // A warning that merely mentions a snapshot, such as a file too large to record, is not such a line.
    const mentionsUncommitted = /left uncommitted|--no-integrate-operation/i.test(status.stderr);
    if (snapshots.length > 1 || (lines.length === 0 && mentionsUncommitted)) {
      return read({
        kind: "unknown",
        reason: `JJ's output was not what Hunk expects:\n${status.stderr.trim()}`,
      });
    }
    return read({ kind: "clean" }, { isImportWaiting });
  }

  try {
    const workingCopy = (
      await readJj(session, [
        "--at-op",
        operationId,
        "log",
        "--no-graph",
        "-r",
        "@",
        "-T",
        "commit_id",
      ])
    ).trim();
    if (!COMMIT_ID_PATTERN.test(workingCopy)) {
      throw new JjReadError("JJ's output was not what Hunk expects.", workingCopy);
    }
    const difference = [
      "--at-op",
      snapshotId,
      "diff",
      "--from",
      `commit_id(${workingCopy})`,
      "--to",
      "@",
    ];
    const summary = await readJj(session, [...difference, "--summary"]);
    const paths = summary
      .split("\n")
      .filter((line) => line.length > 2)
      .map((line) => line.slice(2));
    if (paths.length === 0) return read({ kind: "clean" }, { isImportWaiting });
    // The digest is derived from content only, so the same file saved again with other text differs.
    const content = await readJj(session, [...difference, "--git"]);
    return read(
      { kind: "pending", paths },
      { fingerprint: createHash("sha256").update(content).digest("hex"), isImportWaiting },
    );
  } catch (error) {
    if (!(error instanceof JjReadError)) throw error;
    return read({ kind: "unknown", reason: error.providerText });
  }
}

/** Says whether two reads hold the same pending files with the same content. */
function samePending(left: PendingRead, right: PendingRead): boolean {
  if (left.files.kind === "unknown" || right.files.kind === "unknown") return false;
  if (left.files.kind !== right.files.kind) return false;
  return left.fingerprint === right.fingerprint;
}

/**
 * Reads the operations recorded after one operation up to another, oldest first.
 *
 * The operation log can fork and merge when two writers start from the same
 * operation, so the answer is every ancestor of `to` that is not an ancestor
 * of `from`. The walk follows parent links from `to` and stops each branch at
 * an ancestor of `from`, so the length of the whole log does not matter: two
 * adjacent operations in a log of thousands are one step apart. The bound is
 * on the distance between the two.
 *
 * jj records the full command line on every operation a command writes, so
 * the run's token reaches its snapshot and its own operation, but also an
 * import of Git refs or of Git's HEAD and a merge of the log. An operation is
 * the run's own only when the runner recognises it: a snapshot, or the
 * command itself, whose description begins with the subcommand word.
 */
async function readOperations(
  session: JjSession,
  fromOperationId: string,
  toOperationId: string,
  token: string,
  commandWord: string,
): Promise<ExtensionVcsMutationOperation[]> {
  interface OperationRecord {
    o: string;
    s: boolean;
    d: string;
    a: string;
    p: string[];
  }
  const list = async (operationId: string, limit: number, template: string) =>
    readJj(session, [
      "--at-op",
      operationId,
      "op",
      "log",
      "--no-graph",
      "-n",
      String(limit),
      "-T",
      template,
    ]);
  const reached = new Map(
    parseJsonLines<OperationRecord>(
      await list(toOperationId, OPERATION_READ_LIMIT, OPERATION_TEMPLATE),
    ).map((record) => [record.o, record] as const),
  );
  const head = reached.values().next().value;
  if (!head) throw new JjReadError("JJ listed no operations.", toOperationId);
  if (head.o === fromOperationId) return [];
  const known = new Set(
    (await list(fromOperationId, OPERATION_READ_LIMIT * 2, 'id ++ "\\n"'))
      .split("\n")
      .filter(Boolean),
  );

  const recorded: OperationRecord[] = [];
  const seen = new Set<string>();
  const queue = [head.o];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (seen.has(id) || known.has(id)) continue;
    seen.add(id);
    const record = reached.get(id);
    // The walk left what was read before it met an ancestor of `from`: the two are too far apart.
    if (!record) {
      throw new JjReadError(
        `More than ${OPERATION_READ_LIMIT} operations were recorded since the preview. Refresh history, then try again.`,
        fromOperationId,
      );
    }
    recorded.push(record);
    queue.push(...record.p);
  }
  // jj lists newest first, in an order that respects ancestry; keep it, oldest first.
  const order = [...reached.keys()];
  return recorded
    .sort((left, right) => order.indexOf(right.o) - order.indexOf(left.o))
    .map((record) => {
      const carriesToken = record.a.includes(`hunk.attempt=${token}`) && record.p.length <= 1;
      return {
        operationId: record.o,
        description: record.d,
        isSnapshot: record.s,
        isOwn: carriesToken && (record.s || record.d.startsWith(`${commandWord} `)),
      };
    });
}

interface BookmarkRecord {
  n: string;
  r: string | null;
  x: boolean;
  t: [string, string][];
}

/** Reads every bookmark's targets at one operation, keyed by name and remote. */
async function readBookmarks(
  session: JjSession,
  operationId: string,
): Promise<Map<string, BookmarkRecord>> {
  const output = await readJj(session, [
    "--at-op",
    operationId,
    "bookmark",
    "list",
    "--all-remotes",
    "-T",
    BOOKMARK_TEMPLATE,
  ]);
  const bookmarks = new Map<string, BookmarkRecord>();
  for (const record of parseJsonLines<BookmarkRecord>(output)) {
    if (record.r === "git") continue;
    bookmarks.set(JSON.stringify([record.n, record.r]), record);
  }
  return bookmarks;
}

/** Lists the bookmarks whose targets differ between two operations. */
function diffBookmarks(
  before: Map<string, BookmarkRecord>,
  after: Map<string, BookmarkRecord>,
): ExtensionVcsMutationBookmarkChange[] {
  const changes: ExtensionVcsMutationBookmarkChange[] = [];
  const toRefs = (record: BookmarkRecord | undefined) =>
    (record?.t ?? []).map(([revisionId, logicalId]) => ({ revisionId, logicalId }));
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const [beforeRecord, afterRecord] = [before.get(key), after.get(key)];
    const [beforeRefs, afterRefs] = [toRefs(beforeRecord), toRefs(afterRecord)];
    const commits = (refs: ExtensionVcsMutationRevisionRef[]) =>
      JSON.stringify(refs.map((ref) => ref.revisionId).sort());
    if (commits(beforeRefs) === commits(afterRefs)) continue;
    const changeIds = (refs: ExtensionVcsMutationRevisionRef[]) =>
      JSON.stringify(refs.map((ref) => ref.logicalId).sort());
    const record = (afterRecord ?? beforeRecord)!;
    changes.push({
      name: record.n,
      ...(record.r === null ? {} : { remote: record.r }),
      before: beforeRefs,
      after: afterRefs,
      isConflicted: afterRecord?.x ?? false,
      // It followed its revision through a rewrite when it still points at the same change ids.
      followsRevision:
        beforeRefs.length > 0 &&
        afterRefs.length > 0 &&
        changeIds(beforeRefs) === changeIds(afterRefs),
    });
  }
  return changes.sort((left, right) =>
    `${left.name}@${left.remote ?? ""}`.localeCompare(`${right.name}@${right.remote ?? ""}`),
  );
}

/**
 * Builds what changed between two operations.
 *
 * It compares the visible revisions on each side, per change id, and does not
 * read jj's printed list. A change id whose visible commit ids are the same on
 * both sides has no entry, so "no entry" means the revision stayed as it was.
 */
async function readChange(
  session: JjSession,
  fromOperationId: string,
  toOperationId: string,
  token: string,
  commandWord: string,
): Promise<ExtensionVcsMutationChange> {
  const operations = await readOperations(
    session,
    fromOperationId,
    toOperationId,
    token,
    commandWord,
  );
  if (operations.length === 0) return { operations, revisions: [], bookmarks: [] };

  const [left, arrived] = await Promise.all([
    readRevisions(session, fromOperationId, `all() ~ at_operation(${toOperationId}, all())`),
    readRevisions(session, toOperationId, `all() ~ at_operation(${fromOperationId}, all())`),
  ]);
  const changeIds = [
    ...new Set([...left, ...arrived].map((revision) => revision.logicalId)),
  ].filter((id): id is string => id !== undefined && CHANGE_ID_PATTERN.test(id));

  const revisions: ExtensionVcsMutationRevisionChange[] = [];
  if (changeIds.length > 0) {
    // Every visible version on each side, so a divergent change shows the version that stayed too.
    const before: ObservedRevision[] = [];
    const after: ObservedRevision[] = [];
    for (let start = 0; start < changeIds.length; start += CHANGE_ID_CHUNK_SIZE) {
      const revset = changeIds
        .slice(start, start + CHANGE_ID_CHUNK_SIZE)
        .map((id) => `change_id(${id})`)
        .join("|");
      const [beforeChunk, afterChunk] = await Promise.all([
        readRevisions(session, fromOperationId, revset),
        readRevisions(session, toOperationId, revset),
      ]);
      before.push(...beforeChunk);
      after.push(...afterChunk);
    }
    for (const logicalId of changeIds) {
      revisions.push({
        logicalId,
        before: before.filter((revision) => revision.logicalId === logicalId).map(toPublicRevision),
        after: after.filter((revision) => revision.logicalId === logicalId).map(toPublicRevision),
      });
    }
  }

  const [bookmarksBefore, bookmarksAfter] = await Promise.all([
    readBookmarks(session, fromOperationId),
    readBookmarks(session, toOperationId),
  ]);
  return { operations, revisions, bookmarks: diffBookmarks(bookmarksBefore, bookmarksAfter) };
}

/**
 * Turns a kind's arguments into jj's, choosing how each revision is addressed.
 *
 * The change id addresses the current version, so pending working-copy edits
 * go with it. A divergent change has several versions and jj refuses its
 * change id, so only then the commit id is used. Neither is ever passed as a
 * bare name: a bookmark or tag spelled like an id would win. Each address is
 * then resolved once and must name exactly the revision the facts observed.
 */
async function resolveArguments(
  session: JjSession,
  plan: JjMutationPlan,
  facts: ExtensionVcsMutationFacts,
): Promise<{ args: string[]; addresses: ResolvedAddress[]; commandWord: string }> {
  // The runner adds global flags itself and recognises the command's operation by this first word.
  const commandWord = plan.args[0];
  if (typeof commandWord !== "string" || !COMMAND_WORD_PATTERN.test(commandWord)) {
    throw new JjReadError(
      "This history change is not set up correctly.",
      "A plan's first argument must be the jj subcommand.",
    );
  }
  const args: string[] = [];
  const addresses: ResolvedAddress[] = [];
  for (const argument of plan.args) {
    if (typeof argument === "string") {
      args.push(argument);
      continue;
    }
    const observed = facts.revisions.find(
      (revision) => revision.revisionId === argument.revision.revisionId,
    );
    if (!observed) throw new Error("A mutation kind named a revision the facts do not hold.");
    const useChangeId =
      observed.logicalId !== undefined &&
      CHANGE_ID_PATTERN.test(observed.logicalId) &&
      !observed.isDivergent;
    const address = useChangeId
      ? `change_id(${observed.logicalId})`
      : `commit_id(${observed.revisionId})`;
    args.push(address);
    addresses.push({ address, revisionId: observed.revisionId });
  }
  await verifyAddresses(session, facts.operationId, addresses);
  return { args, addresses, commandWord };
}

/** Refuses unless every address names exactly the revision it was built for, at one operation. */
async function verifyAddresses(
  session: JjSession,
  operationId: string,
  addresses: readonly ResolvedAddress[],
): Promise<void> {
  for (const { address, revisionId } of addresses) {
    const resolved = await readRevisions(session, operationId, address);
    if (resolved.length !== 1 || resolved[0]!.revisionId !== revisionId) {
      throw new JjReadError(
        "JJ does not resolve a chosen revision to the one history showed. Refresh history, then try again.",
        `${address} names ${resolved.map((revision) => revision.revisionId).join(", ") || "nothing"}`,
      );
    }
  }
}

/** Runs the plan with `--no-integrate-operation` and reads what it would change. */
async function runDryRun(
  session: JjSession,
  facts: ExtensionVcsMutationFacts,
  args: readonly string[],
  commandWord: string,
): Promise<JjDryRun> {
  const token = randomUUID();
  const result = await runJj(session, [
    "--no-integrate-operation",
    // The dry run's commits are never kept, so the signing helper is never started for them.
    "--config",
    "signing.behavior=drop",
    "--config",
    `hunk.attempt=${token}`,
    ...args,
  ]);
  const text = jjText(result);
  if (result.exitCode !== 0) return { kind: "failed", exitCode: result.exitCode, text };
  // A snapshot line alone names no mutation. Two other lines mean jj also imported Git refs, and
  // the two read alike, so the runner refuses to pick one.
  const others = [...result.stderr.matchAll(UNCOMMITTED_LINE_PATTERN)].filter(
    (line) => line[1] === "Operation",
  );
  if (others.length === 0) return { kind: "no-operation", text };
  if (others.length > 1) {
    throw new JjReadError("Git changed while Hunk was reading the repository. Try again.", text);
  }
  const change = await readChange(session, facts.operationId, others[0]![2]!, token, commandWord);
  // What a preview shows must be this command's work alone: an optional snapshot, then one operation.
  const [last, ...earlier] = [...change.operations].reverse();
  const isOnlyTheCommand =
    last !== undefined &&
    last.isOwn &&
    !last.isSnapshot &&
    earlier.length <= 1 &&
    earlier.every((operation) => operation.isOwn && operation.isSnapshot);
  if (!isOnlyTheCommand) {
    throw new JjReadError("The repository changed while Hunk was reading it. Try again.", text);
  }
  return { kind: "change", change, text };
}

/** Words one refusal the runner itself decides. */
function refuse(
  reason: string,
  extra: Partial<Extract<ExtensionVcsMutationPreparation, { kind: "refused" }>> = {},
): { preparation: ExtensionVcsMutationPreparation } {
  return { preparation: { kind: "refused", reason, ...extra } };
}

/** Reads facts, plans and previews one request. Records nothing jj makes current. */
async function prepareMutation(
  session: JjSession,
  request: ExtensionVcsMutationRequest,
): Promise<{ preparation: ExtensionVcsMutationPreparation; mutation?: PreparedMutation }> {
  // The registry maps each kind name to its own handler; the request's `kind` picked this one.
  const kind = JJ_MUTATION_KINDS[request.kind] as JjMutationKind | undefined;
  if (!kind) return refuse("This JJ provider cannot do that yet.");

  let facts: ExtensionVcsMutationFacts | undefined;
  try {
    const providerVersion = await readJjVersion(session);
    if (isVersionBelow(providerVersion, JJ_MUTATION_MINIMUM_VERSION)) {
      return refuse(
        `Hunk changes history with jj ${JJ_MUTATION_MINIMUM_VERSION} or newer. This is jj ${providerVersion}.`,
      );
    }

    const operationId = await readCurrentOperation(session);
    const pending = await readPendingFiles(session, operationId);
    if (pending.isStale) {
      return refuse(
        "The working copy is behind the repository. Run `jj workspace update-stale`, then try again.",
        {
          providerText: pending.files.kind === "unknown" ? pending.files.reason : undefined,
          isWorkingCopyStale: true,
        },
      );
    }
    if (pending.files.kind === "unknown") {
      return refuse("Hunk could not read which files have unrecorded changes.", {
        providerText: pending.files.reason,
      });
    }
    if (pending.isImportWaiting) return refuse(GIT_IMPORT_WAITING_REASON);

    const revisions: ExtensionVcsMutationRevision[] = [];
    for (const ref of kind.revisions(request)) {
      const observed = await readRevisionById(session, operationId, ref.revisionId);
      if (!observed || observed.isHidden) {
        return refuse(
          "A chosen revision changed after history was loaded. Refresh history, then try again.",
        );
      }
      revisions.push(toPublicRevision(observed));
    }
    facts = { providerVersion, operationId, revisions, files: pending.files };

    // jj's snapshot gives a pending working copy a new commit id, and a divergent change has no usable change id.
    if (
      pending.files.kind === "pending" &&
      revisions.some((revision) => revision.isDivergent && revision.isWorkingCopy)
    ) {
      return refuse(
        "This working-copy revision is divergent and has unrecorded file changes. Record them with a jj command, or resolve the divergence, then try again.",
        { facts },
      );
    }

    const plan = kind.plan({ request, facts });
    if (isJjMutationRefusal(plan)) {
      return refuse(plan.refused, { providerText: plan.providerText, facts });
    }

    const { args, addresses, commandWord } = await resolveArguments(session, plan, facts);
    const previewArgs = plan.previewArgs
      ? (await resolveArguments(session, { ...plan, args: plan.previewArgs }, facts)).args
      : args;
    const dryRun =
      plan.preview === "dry-run" ? await runDryRun(session, facts, previewArgs, commandWord) : null;
    // The dry run recorded files the pending read called clean: a file was saved in between, or
    // jj reworded the line the read depends on. Either way the confirmation would not name them.
    if (
      dryRun?.kind === "change" &&
      pending.files.kind === "clean" &&
      dryRun.change.operations.some((operation) => operation.isSnapshot && operation.isOwn)
    ) {
      return refuse("JJ recorded file changes that Hunk had not seen. Try again.", {
        providerText: dryRun.text,
        facts,
      });
    }
    const projection = kind.project({ request, facts, plan, dryRun });
    if (isJjMutationRefusal(projection)) {
      return refuse(projection.refused, {
        providerText:
          projection.providerText ?? (dryRun?.kind === "failed" ? dryRun.text : undefined),
        facts,
      });
    }

    const prepared: ExtensionVcsMutationPrepared = {
      handleId: randomUUID(),
      request,
      facts,
      ...(dryRun?.kind === "change" ? { preview: dryRun.change } : {}),
      ...(dryRun ? { previewText: dryRun.text } : {}),
      projection,
      ...(plan.description === undefined ? {} : { description: plan.description }),
      isInteractive: plan.interactive,
    };
    return {
      preparation: { kind: "ready", prepared },
      mutation: {
        kind,
        plan,
        prepared,
        args,
        addresses,
        commandWord,
        fingerprint: pending.fingerprint,
      },
    };
  } catch (error) {
    if (session.signal?.aborted) return { preparation: { kind: "cancelled" } };
    if (error instanceof JjReadError) {
      return refuse(error.message, { providerText: error.providerText, facts });
    }
    throw error;
  }
}

/** Names a revision by what survives a rewrite, for comparing two previews. */
function stableId(ref: ExtensionVcsMutationRevisionRef): string {
  return ref.logicalId ?? ref.revisionId;
}

/**
 * Reduces a preparation to what the user confirmed.
 *
 * A dry run gives rewritten and created revisions a new commit id on every
 * run, so those are compared by change id, parents and marks. The revisions
 * the request names are compared by commit id: a source that moved, even by a
 * snapshot alone, may hold edits that were never shown.
 */
function confirmedShape(mutation: PreparedMutation): string {
  const { prepared } = mutation;
  const revisionShape = (revision: ExtensionVcsMutationRevision) => ({
    parents: revision.parents.map(stableId),
    isEmpty: revision.isEmpty,
    hasConflict: revision.hasConflict,
    isWorkingCopy: revision.isWorkingCopy,
  });
  const revisions = (prepared.preview?.revisions ?? []).map((entry) =>
    entry.before.length > 0
      ? {
          logicalId: entry.logicalId,
          before: entry.before.map((revision) => revision.revisionId).sort(),
          after: entry.after.map(revisionShape),
        }
      : // A created revision has a new change id on every run, so its content stands in for its id.
        {
          created: entry.after.map((revision) => ({
            ...revisionShape(revision),
            description: revision.description,
          })),
        },
  );
  const bookmarks = (prepared.preview?.bookmarks ?? []).map((bookmark) => ({
    name: bookmark.name,
    remote: bookmark.remote,
    after: bookmark.after.map(stableId).sort(),
    isConflicted: bookmark.isConflicted,
    followsRevision: bookmark.followsRevision,
  }));
  return JSON.stringify({
    named: prepared.facts.revisions.map((revision) => revision.revisionId),
    hasPreview: prepared.preview !== undefined,
    revisions: revisions.map((entry) => JSON.stringify(entry)).sort(),
    bookmarks,
    files:
      prepared.facts.files.kind === "pending"
        ? [...prepared.facts.files.paths].sort()
        : prepared.facts.files.kind,
    // The same paths with other content are not what was confirmed.
    fingerprint: mutation.fingerprint,
    projection: prepared.projection,
    description: prepared.description ?? null,
    isInteractive: prepared.isInteractive,
  });
}

/** Where a confirmed revision stands now, and the version to follow when jj only recorded its files. */
interface RevisionStanding {
  state: ExtensionVcsMutationRevisionState;
  recordedAs?: ExtensionVcsMutationRevisionRef;
}

/** Says where a revision the user confirmed stands now. */
async function classifyRevision(
  session: JjSession,
  operationId: string,
  confirmed: ExtensionVcsMutationRevision,
): Promise<RevisionStanding> {
  const now = await readRevisionById(session, operationId, confirmed.revisionId);
  if (!now) return { state: "gone" };
  if (!now.isHidden) return { state: "current" };
  if (!confirmed.logicalId || !CHANGE_ID_PATTERN.test(confirmed.logicalId)) {
    return { state: "hidden" };
  }
  const versions = await readRevisions(session, operationId, `change_id(${confirmed.logicalId})`);
  if (versions.length === 0) return { state: "hidden" };
  const parents = (revision: ExtensionVcsMutationRevision) =>
    JSON.stringify(revision.parents.map((parent) => parent.revisionId));
  const only = versions.length === 1 ? versions[0]! : undefined;
  const onlyRecordedFiles =
    only !== undefined &&
    confirmed.isWorkingCopy &&
    only.isWorkingCopy &&
    only.description === confirmed.description &&
    parents(only) === parents(confirmed);
  return onlyRecordedFiles
    ? {
        state: "snapshot-only",
        recordedAs: { revisionId: only.revisionId, logicalId: only.logicalId },
      }
    : { state: "rewritten" };
}

/** Points a request at the current version of each revision jj only recorded files for. */
function followRecordedRevisions(
  request: ExtensionVcsMutationRequest,
  recorded: ReadonlyMap<string, ExtensionVcsMutationRevisionRef>,
): ExtensionVcsMutationRequest {
  const follow = (ref: ExtensionVcsMutationRevisionRef) => recorded.get(ref.revisionId) ?? ref;
  const followAll = (
    refs: readonly [ExtensionVcsMutationRevisionRef, ...ExtensionVcsMutationRevisionRef[]],
  ): [ExtensionVcsMutationRevisionRef, ...ExtensionVcsMutationRevisionRef[]] => {
    const [first, ...rest] = refs;
    return [follow(first), ...rest.map(follow)];
  };
  switch (request.kind) {
    case "abandon":
      return { ...request, sources: followAll(request.sources) };
    case "squash":
    case "rebase":
      return {
        ...request,
        sources: followAll(request.sources),
        destination: follow(request.destination),
      };
    case "split":
      return { ...request, source: follow(request.source) };
  }
}

/** Joins the signals that may stop a read, ignoring the ones that are absent. */
function anySignal(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return present.length > 1 ? AbortSignal.any(present) : present[0];
}

/** Creates the JJ provider's mutation capability. */
export function createJjMutationCapability({
  jjExecutable = "jj",
  env,
}: Readonly<JjMutationRunnerOptions> = {}): ExtensionVcsMutationCapability {
  /** Preparations that reached the confirm step and were not applied or disposed yet. */
  const handles = new Map<string, PreparedMutation>();
  const openSession = (cwd: string, signal: AbortSignal | undefined): JjSession => ({
    jjExecutable,
    env,
    cwd,
    signal,
  });

  return {
    async availability(context) {
      try {
        const providerVersion = await readJjVersion(openSession(context.cwd, context.signal));
        if (isVersionBelow(providerVersion, JJ_MUTATION_MINIMUM_VERSION)) {
          return {
            kind: "unsupported",
            reason: `Hunk changes history with jj ${JJ_MUTATION_MINIMUM_VERSION} or newer. This is jj ${providerVersion}.`,
          };
        }
        return { kind: "supported", kinds: listJjMutationKinds(), providerVersion };
      } catch (error) {
        if (context.signal?.aborted) context.signal.throwIfAborted();
        return {
          kind: "unsupported",
          reason: error instanceof Error ? error.message : "Hunk could not run jj.",
        };
      }
    },

    async prepare(request, context) {
      const { preparation, mutation } = await prepareMutation(
        openSession(context.cwd, context.signal),
        request,
      );
      if (mutation) handles.set(mutation.prepared.handleId, mutation);
      return preparation;
    },

    async apply(handleId, execution, context): Promise<ExtensionVcsMutationResult> {
      const confirmed = handles.get(handleId);
      // A handle is valid for one apply, whatever that apply returns.
      if (!confirmed) return { kind: "not-run", reason: "stale-handle" };
      handles.delete(handleId);
      if (execution.signal.aborted) return { kind: "not-run", reason: "cancelled" };

      // The user's cancel and the host's bound both stop the final check.
      const checking = openSession(context.cwd, anySignal(execution.signal, context.signal));
      let running = confirmed;

      // The final check. Nothing moved: the same operation, and the same pending files with the
      // same content. A file saved after the preview moves no operation, so the files are read again.
      try {
        const operationId = await readCurrentOperation(checking);
        const pending = await readPendingFiles(checking, operationId);
        // An import that is waiting can never be "the same": the run would act on a state nobody previewed.
        if (pending.isImportWaiting) {
          return {
            kind: "not-run",
            reason: "changed",
            detail: GIT_IMPORT_WAITING_REASON,
            revisions: [],
            refreshed: { kind: "refused", reason: GIT_IMPORT_WAITING_REASON },
          };
        }
        const nothingMoved =
          operationId === confirmed.prepared.facts.operationId &&
          samePending(pending, {
            files: confirmed.prepared.facts.files,
            isStale: false,
            fingerprint: confirmed.fingerprint,
            isImportWaiting: false,
          });
        // Each address must still name the confirmed revision at the operation this check read.
        if (nothingMoved) await verifyAddresses(checking, operationId, confirmed.addresses);
        if (!nothingMoved) {
          const standings = await Promise.all(
            confirmed.prepared.facts.revisions.map(async (revision) => ({
              revision,
              standing: await classifyRevision(checking, operationId, revision),
            })),
          );
          // A working copy jj only recorded files for is followed to its current version, so the
          // user is shown what the mutation does now. It never runs without that new confirmation.
          const recorded = new Map<string, ExtensionVcsMutationRevisionRef>();
          for (const { revision, standing } of standings) {
            if (standing.recordedAs) recorded.set(revision.revisionId, standing.recordedAs);
          }
          // Something moved: prepare again once and run only when the user would confirm the same thing.
          const { preparation, mutation } = await prepareMutation(
            checking,
            followRecordedRevisions(confirmed.prepared.request, recorded),
          );
          const isSame =
            mutation !== undefined &&
            confirmedShape(mutation) === confirmedShape(confirmed) &&
            // The operation moving again during this one re-preview is "different". It never loops.
            (await readCurrentOperation(checking)) === mutation.prepared.facts.operationId;
          if (!isSame) {
            if (mutation) handles.set(mutation.prepared.handleId, mutation);
            return {
              kind: "not-run",
              reason: "changed",
              detail: "History or your files changed after this preview was shown.",
              revisions: standings.map(({ revision, standing }) => ({
                revision: { revisionId: revision.revisionId, logicalId: revision.logicalId },
                state: standing.state,
              })),
              refreshed: preparation,
            };
          }
          running = mutation;
        }
      } catch (error) {
        if (execution.signal.aborted) return { kind: "not-run", reason: "cancelled" };
        const reason = context.signal?.aborted
          ? "Reading the repository took too long."
          : error instanceof JjReadError
            ? error.message
            : undefined;
        if (reason === undefined) throw error;
        return {
          kind: "not-run",
          reason: "changed",
          detail: reason,
          revisions: [],
          refreshed: {
            kind: "refused",
            reason,
            ...(error instanceof JjReadError ? { providerText: error.providerText } : {}),
          },
        };
      }
      if (execution.signal.aborted) return { kind: "not-run", reason: "cancelled" };

      const { kind, plan, prepared, args, commandWord } = running;
      const token = randomUUID();
      const terminal = plan.interactive ? "handed-over" : "captured";
      const process = await execution.run({
        executable: jjExecutable,
        args: [
          // A handed-over command keeps the user's pager and colors; a captured one must stay plain text.
          ...(terminal === "captured" ? ["--no-pager", "--color", "never"] : []),
          // jj accepts an unknown config key silently and records the command line on each operation it writes.
          "--config",
          `hunk.attempt=${token}`,
          ...args,
        ],
        cwd: context.cwd,
        terminal,
      });
      if (!process.started) return { kind: "not-run", reason: "start-failed", text: process.text };

      // The read-back and the stale check run on their own clock: a command that was interrupted, or
      // stopped at the host's bound, may still have written, and the result must say what it wrote.
      const readingBack = openSession(context.cwd, AbortSignal.timeout(READ_BACK_TIMEOUT_MS));
      let change: Extract<ExtensionVcsMutationResult, { kind: "ran" }>["change"];
      let headOperationId = prepared.facts.operationId;
      try {
        headOperationId = await readCurrentOperation(readingBack);
        change = {
          kind: "read",
          value: await readChange(
            readingBack,
            prepared.facts.operationId,
            headOperationId,
            token,
            commandWord,
          ),
        };
      } catch (error) {
        change = {
          kind: "unread",
          reason: error instanceof JjReadError ? error.message : String(error),
        };
      }
      const verdict = kind.judge({
        request: prepared.request,
        facts: prepared.facts,
        plan,
        process,
        preview: prepared.preview ?? null,
        change: change.kind === "read" ? change.value : null,
      });
      // Two rewriting commands that collide both exit 0, so only a second working-copy read shows a stale one.
      const after = await readPendingFiles(readingBack, headOperationId).catch(() => null);
      return { kind: "ran", process, change, verdict, isWorkingCopyStale: after?.isStale ?? false };
    },

    dispose(handleId) {
      handles.delete(handleId);
    },
  };
}
