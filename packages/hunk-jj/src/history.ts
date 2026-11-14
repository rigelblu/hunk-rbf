import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  HunkExtensionUserError,
  type ExtensionVcsHistoryCommit,
  type ExtensionVcsHistoryDecoration,
  type ExtensionVcsHistoryInput,
  type ExtensionVcsHistoryRangeReviewAction,
  type ExtensionVcsHistoryRangeSelection,
  type ExtensionVcsHistoryReviewOptions,
  type ExtensionVcsHistorySource,
  type ExtensionVcsHistoryScope,
} from "hunkdiff/extension";
import { runAbortableCommand } from "@hunk/vcs/async-process";
import { normalizePathForOS } from "@hunk/vcs/path";

const HISTORY_FIELDS_PER_COMMIT = 15;
const REF_SEPARATOR = "\x1f";
const FULL_COMMIT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DISPLAY_ID_PATTERN = /^[a-z0-9]{4,64}$/;
const ROOT_COMMIT_ID_PATTERN = /^0+$/;

/** Emits stable machine fields without consulting a user's log template. */
const JJ_HISTORY_TEMPLATE =
  [
    "commit_id",
    "change_id.short(8)",
    "change_id",
    'parents.map(|p| p.commit_id()).join(" ")',
    "author.name()",
    "author.email()",
    'author.timestamp().format("%Y-%m-%dT%H:%M:%S%:z")',
    "description",
    'if(current_working_copy, "1", "0")',
    'local_bookmarks.map(|r| r.name()).join("\\x1f")',
    'remote_bookmarks.map(|r| r.name() ++ "@" ++ r.remote()).join("\\x1f")',
    'local_tags.map(|r| r.name()).join("\\x1f")',
    'remote_tags.map(|r| r.name() ++ "@" ++ r.remote()).join("\\x1f")',
    'if(empty, "true", "false")',
    'working_copies.map(|w| w.name().escape_json()).join("\\x1f")',
  ].join(' ++ "\\0" ++ ') + ' ++ "\\0"';

export interface JjHistoryOptions {
  cwd: string;
  jjExecutable?: string;
  signal?: AbortSignal;
}

/** Return one safely quoted Jujutsu string literal for a generated revset. */
function quoteRevsetString(value: string) {
  return JSON.stringify(value);
}

/** Reject a positional revset that the CLI could reinterpret as an option. */
function requireHistoryRevision(value: string) {
  if (!value || value.startsWith("-")) {
    throw new HunkExtensionUserError(`Refused Jujutsu history revision \`${value}\`.`, {
      suggestions: ["Pass a revision or revset such as `@`, `main`, or `main..@`."],
    });
  }
  return value;
}

/** Build the provider-owned revset while preserving honest Jujutsu semantics. */
export function buildJjHistoryRevset(
  input: ExtensionVcsHistoryInput,
  scope?: ExtensionVcsHistoryScope,
) {
  const start = input.revision
    ? `(${requireHistoryRevision(input.revision)})`
    : input.all
      ? "visible_heads()"
      : "@";
  const traversal = input.firstParent ? `first_ancestors(${start})` : `ancestors(${start})`;
  const selection =
    scope?.kind === "bounded"
      ? input.firstParent
        ? `((first_ancestors(visible_heads()) ~ ancestors(${scope.boundaryRevisionId})) | ${scope.boundaryRevisionId})`
        : `((${scope.boundaryRevisionId}..visible_heads()) | ${scope.boundaryRevisionId})`
      : scope?.kind === "fallback"
        ? `${input.firstParent ? "first_ancestors" : "ancestors"}(visible_heads())`
        : traversal;
  const filters = [`(${selection} ~ root())`];
  if (input.author !== undefined) {
    filters.push(`author(substring:${quoteRevsetString(input.author)})`);
  }
  if (input.grep !== undefined) {
    filters.push(`description(substring:${quoteRevsetString(input.grep)})`);
  }
  if (input.since !== undefined) {
    filters.push(`author_date(after:${quoteRevsetString(input.since)})`);
  }
  if (input.until !== undefined) {
    filters.push(`author_date(before:${quoteRevsetString(input.until)})`);
  }
  return filters.join(" & ");
}

/** Build one deterministic, non-mutating `jj log` invocation. */
export function buildJjHistoryArgs(input: ExtensionVcsHistoryInput, prepared?: PreparedJjHistory) {
  const args = [
    "--ignore-working-copy",
    ...(prepared ? ["--at-op", prepared.operationId] : []),
    "--no-pager",
    "--color",
    "never",
    "log",
    "--no-graph",
    "--revisions",
    buildJjHistoryRevset(input, prepared?.scope),
    "--template",
    prepared?.template ?? JJ_HISTORY_TEMPLATE,
  ];
  if (input.maxCount !== undefined) args.push("--limit", String(input.maxCount));
  if (input.pathspecs?.length) args.push("--", ...input.pathspecs);
  return args;
}

/** One immutable operation and boundary shared by selection and cutoff classification. */
interface PreparedJjHistory {
  operationId: string;
  scope?: ExtensionVcsHistoryScope;
  template: string;
  fieldsPerCommit: number;
}

/** Resolve configured mainline once and keep all subsequent queries on that repository operation. */
async function prepareJjHistory(
  input: ExtensionVcsHistoryInput,
  options: JjHistoryOptions,
): Promise<PreparedJjHistory> {
  options.signal?.throwIfAborted();
  const operationId = (
    await runJjHistoryQuery(
      ["op", "log", "--no-graph", "--limit", "1", "--template", 'id ++ "\\n"'],
      options,
    )
  ).trim();
  if (!/^[0-9a-f]{128}$/.test(operationId))
    throw new Error("Jujutsu returned an invalid operation identity.");
  const plan: PreparedJjHistory = {
    operationId,
    template: JJ_HISTORY_TEMPLATE,
    fieldsPerCommit: HISTORY_FIELDS_PER_COMMIT,
  };
  if (input.revision || input.all) return plan;
  const output = await runJjHistoryQuery(
    [
      "--at-op",
      operationId,
      "log",
      "--no-graph",
      "--revisions",
      "present(trunk())",
      "--limit",
      "2",
      "--template",
      'commit_id ++ "\\n"',
    ],
    options,
  );
  const boundaries = output.trim() ? output.trim().split("\n") : [];
  if (boundaries.some((id) => !FULL_COMMIT_ID_PATTERN.test(id)))
    throw new Error("Jujutsu returned an invalid mainline identity.");
  if (boundaries.length !== 1 || ROOT_COMMIT_ID_PATTERN.test(boundaries[0]!)) {
    plan.scope = Object.freeze({
      kind: "fallback",
      reason: boundaries.length > 1 ? "ambiguous" : "unavailable",
    });
    return plan;
  }
  const boundaryRevisionId = boundaries[0]!;
  plan.scope = Object.freeze({ kind: "bounded", boundaryRevisionId });
  const excluded = `ancestors(${boundaryRevisionId}) ~ (${boundaryRevisionId} | root())`;
  plan.template += ` ++ parents.filter(|p| p.contained_in(${JSON.stringify(excluded)})).map(|p| p.commit_id()).join(" ") ++ "\\0"`;
  plan.fieldsPerCommit += 1;
  return plan;
}

/** Fingerprint selected fields and scope, including boundary moves hidden by display filters. */
export async function getJjHistoryWatchSignature(
  input: ExtensionVcsHistoryInput,
  options: JjHistoryOptions,
) {
  const prepared = await prepareJjHistory(input, options);
  const { cwd, jjExecutable = "jj", signal } = options;
  const result = await runAbortableCommand([jjExecutable, ...buildJjHistoryArgs(input, prepared)], {
    cwd,
    signal,
  });
  if (result.exitCode !== 0)
    throw new Error(result.stderr.trim() || "Jujutsu could not read history.");
  return prepared.scope ? `${JSON.stringify(prepared.scope)}\n${result.stdout}` : result.stdout;
}

/** Split a Jujutsu description into the medium-format subject and body fields. */
function splitDescription(description: string) {
  const normalized = description.endsWith("\n") ? description.slice(0, -1) : description;
  const boundary = normalized.indexOf("\n");
  if (boundary < 0) {
    return { subject: normalized || "(no description set)" };
  }
  const subject = normalized.slice(0, boundary) || "(no description set)";
  const body = normalized.slice(boundary + 1).replace(/^\n/, "");
  return { subject, ...(body ? { body } : {}) };
}

/** Convert one ref-list field into typed, provider-neutral decorations. */
function appendDecorations(
  target: ExtensionVcsHistoryDecoration[],
  field: string,
  kind: ExtensionVcsHistoryDecoration["kind"],
) {
  for (const label of field.split(REF_SEPARATOR)) {
    if (label) target.push({ kind, label });
  }
}

/** Decode JSON strings before sorting names; legal workspace names can contain the list separator. */
function decodeWorkspaceNames(field: string) {
  const names = field
    ? field.split(REF_SEPARATOR).map((encoded) => {
        let name: unknown;
        try {
          name = JSON.parse(encoded);
        } catch {
          throw new Error("Jujutsu returned an invalid workspace name.");
        }
        if (typeof name !== "string")
          throw new Error("Jujutsu returned an invalid workspace name.");
        return name;
      })
    : [];
  return [...new Set(names.filter(Boolean))].sort();
}

/** Parse fixed NUL-delimited Jujutsu template records. */
export function parseJjHistory(
  text: string,
  firstParent = false,
  omitGraphParents = false,
  fieldsPerCommit = HISTORY_FIELDS_PER_COMMIT,
): ExtensionVcsHistoryCommit[] {
  if (!text) return [];
  const fields = text.split("\0");
  if (fields.length % fieldsPerCommit === 1 && fields.at(-1) === "") fields.pop();
  if (fields.length % fieldsPerCommit !== 0) {
    throw new Error("Jujutsu returned a truncated history record.");
  }

  const commits: ExtensionVcsHistoryCommit[] = [];
  for (let offset = 0; offset < fields.length; offset += fieldsPerCommit) {
    const revisionId = fields[offset]!;
    const displayId = fields[offset + 1]!;
    const logicalId = fields[offset + 2]!;
    const parents = fields[offset + 3]!;
    const authorName = fields[offset + 4]!;
    const authorEmail = fields[offset + 5]!;
    const authoredAt = fields[offset + 6]!;
    const description = fields[offset + 7]!;
    const currentWorkingCopy = fields[offset + 8]!;
    const localBookmarks = fields[offset + 9]!;
    const remoteBookmarks = fields[offset + 10]!;
    const localTags = fields[offset + 11]!;
    const remoteTags = fields[offset + 12]!;
    const emptyField = fields[offset + 13]!;
    const workspaceNames = fields[offset + 14]!;

    if (
      !FULL_COMMIT_ID_PATTERN.test(revisionId) ||
      !DISPLAY_ID_PATTERN.test(displayId) ||
      !logicalId ||
      !authoredAt ||
      (emptyField !== "true" && emptyField !== "false")
    ) {
      throw new Error("Jujutsu returned an invalid history record.");
    }
    const allParents = parents
      ? parents.split(" ").filter((parent) => parent && !ROOT_COMMIT_ID_PATTERN.test(parent))
      : [];
    if (allParents.some((parent) => !FULL_COMMIT_ID_PATTERN.test(parent))) {
      throw new Error("Jujutsu returned an invalid history parent commit id.");
    }

    const permittedParents = firstParent ? allParents.slice(0, 1) : allParents;
    const cutoffParents =
      fieldsPerCommit > HISTORY_FIELDS_PER_COMMIT
        ? fields[offset + HISTORY_FIELDS_PER_COMMIT]!.split(" ").filter(Boolean)
        : [];
    if (
      cutoffParents.some(
        (parent) => !FULL_COMMIT_ID_PATTERN.test(parent) || !allParents.includes(parent),
      ) ||
      new Set(cutoffParents).size !== cutoffParents.length
    ) {
      throw new Error("Jujutsu returned an invalid history cutoff parent id.");
    }
    const graphCutoffParentRevisionIds = cutoffParents.filter((parent) =>
      permittedParents.includes(parent),
    );
    const decorations: ExtensionVcsHistoryDecoration[] = [];
    if (currentWorkingCopy === "1") decorations.push({ kind: "head", label: "@" });
    // JJ suppresses this field in singleton repositories; no inventory query is needed.
    for (const name of decodeWorkspaceNames(workspaceNames)) {
      decorations.push({ kind: "ref", label: `@${name}`, workspaceName: name });
    }
    appendDecorations(decorations, localBookmarks, "local-branch");
    appendDecorations(decorations, remoteBookmarks, "remote-branch");
    appendDecorations(decorations, localTags, "tag");
    appendDecorations(decorations, remoteTags, "tag");

    commits.push({
      revisionId,
      displayId,
      parentRevisionIds: permittedParents,
      ...(graphCutoffParentRevisionIds.length ? { graphCutoffParentRevisionIds } : {}),
      ...(omitGraphParents ? { graphParentRevisionIds: [] } : {}),
      ...splitDescription(description),
      authorName: authorName || "Unknown author",
      ...(authorEmail ? { authorEmail } : {}),
      authoredAt,
      decorations,
      logicalId,
      isEmpty: emptyField === "true",
    });
  }
  return commits;
}

/** Load a bounded newest-first commit list for direct review metadata. */
export async function loadJjReviewCommits(revset: string, options: JjHistoryOptions, limit = 8) {
  const output = await runJjHistoryQuery(
    [
      "log",
      "--no-graph",
      "-r",
      requireHistoryRevision(revset),
      "--limit",
      String(limit),
      "-T",
      JJ_HISTORY_TEMPLATE,
    ],
    options,
  );
  return parseJjHistory(output);
}

/** Count commits in one provider-owned revset without loading their descriptions. */
export async function countJjReviewCommits(revset: string, options: JjHistoryOptions) {
  const output = await runJjHistoryQuery(
    ["log", "-r", requireHistoryRevision(revset), "--count"],
    options,
  );
  const count = Number.parseInt(output.trim(), 10);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Jujutsu returned an invalid review commit count.");
  }
  return count;
}

/** Run one cancellable JJ query used while preparing a history range. */
async function runJjHistoryQuery(
  args: string[],
  { cwd, jjExecutable = "jj", signal }: JjHistoryOptions,
) {
  let result: Awaited<ReturnType<typeof runAbortableCommand>>;
  try {
    result = await runAbortableCommand(
      [jjExecutable, "--ignore-working-copy", "--no-pager", "--color", "never", ...args],
      { cwd, signal },
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new HunkExtensionUserError(`Could not run ${jjExecutable}.`, {
      suggestions: ["Install Jujutsu or configure Hunk to use another VCS backend."],
    });
  }
  if (result.exitCode !== 0) {
    throw new HunkExtensionUserError(
      result.stderr.trim().split("\n")[0] || "Jujutsu could not read this repository.",
      { suggestions: ["Check the revision and repository, then try again."] },
    );
  }
  return result.stdout;
}

/** Plan an inclusive ancestry range without exposing JJ revsets to Hunk core. */
export async function planJjHistoryRangeReview(
  selection: ExtensionVcsHistoryRangeSelection,
  options: JjHistoryOptions,
  reviewOptions?: ExtensionVcsHistoryReviewOptions,
): Promise<ExtensionVcsHistoryRangeReviewAction> {
  const newest = selection.newestCommit.revisionId;
  const oldest = selection.oldestCommit.revisionId;
  if (!FULL_COMMIT_ID_PATTERN.test(newest) || !FULL_COMMIT_ID_PATTERN.test(oldest)) {
    throw new Error("Jujutsu history range endpoints must be full immutable commit ids.");
  }
  const ancestor = (
    await runJjHistoryQuery(
      ["log", "--no-graph", "-r", `${oldest} & ancestors(${newest})`, "-T", "self.commit_id()"],
      options,
    )
  ).trim();
  if (ancestor !== oldest) {
    throw new HunkExtensionUserError("The selected commits are not on one Jujutsu ancestry path.", {
      suggestions: ["Choose a contiguous range whose oldest commit is an ancestor of the newest."],
    });
  }
  const parent = reviewOptions?.parentRevisionId ?? selection.oldestCommit.parentRevisionIds[0];
  if (parent && !selection.oldestCommit.parentRevisionIds.includes(parent)) {
    throw new Error("The selected revision is not a parent of the oldest Jujutsu commit.");
  }
  const fromRevisionId =
    parent ??
    (
      await runJjHistoryQuery(
        ["log", "--no-graph", "-r", "root()", "-T", "self.commit_id()"],
        options,
      )
    ).trim();
  if (!FULL_COMMIT_ID_PATTERN.test(fromRevisionId)) {
    throw new Error("Jujutsu returned an invalid root comparison identity.");
  }
  return { kind: "revision-range", fromRevisionId, toRevisionId: newest };
}

/** Run a small synchronous JJ query used only to establish the repository root. */
function resolveHistoryRepoRoot({ cwd, jjExecutable = "jj" }: JjHistoryOptions) {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync(
      [jjExecutable, "--ignore-working-copy", "--no-pager", "--color", "never", "root"],
      { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
  } catch {
    throw new HunkExtensionUserError(`Could not run ${jjExecutable}.`, {
      suggestions: ["Install Jujutsu or configure Hunk to use another VCS backend."],
    });
  }
  if (result.exitCode !== 0) {
    const message = result.stderr?.toString().trim().split("\n")[0];
    throw new HunkExtensionUserError(message || "Jujutsu could not read this repository.", {
      suggestions: ["Run `hunk log --vcs jj` from a Jujutsu workspace."],
    });
  }
  const repoRoot = result.stdout?.toString().trim();
  if (!repoRoot) throw new Error("Jujutsu returned an empty repository root.");
  return normalizePathForOS(repoRoot);
}

/** Return whether traversal filters can omit direct parents from the emitted commit stream. */
export function jjHistoryUsesBoundaryTopology(input: ExtensionVcsHistoryInput) {
  return Boolean(
    input.author !== undefined ||
    input.grep !== undefined ||
    input.since !== undefined ||
    input.until !== undefined ||
    input.pathspecs?.length,
  );
}

/** Open a bounded, cancellable cursor over one long-lived `jj log` process. */
export async function openJjHistory(
  input: ExtensionVcsHistoryInput,
  options: JjHistoryOptions,
): Promise<ExtensionVcsHistorySource & { repoRoot: string }> {
  const { cwd, jjExecutable = "jj", signal } = options;
  signal?.throwIfAborted();
  const repoRoot = resolveHistoryRepoRoot({ cwd, jjExecutable });
  const prepared = await prepareJjHistory(input, { ...options, cwd: repoRoot });
  signal?.throwIfAborted();
  if (input.maxCount === 0) {
    return {
      repoRoot,
      ...(prepared.scope ? { scope: prepared.scope } : {}),
      async read() {
        return { commits: [], done: true };
      },
      close() {},
    };
  }

  const omitGraphParents = jjHistoryUsesBoundaryTopology(input);
  const child = spawn(jjExecutable, buildJjHistoryArgs(input, prepared), {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const decoder = new StringDecoder("utf8");
  const queue: ExtensionVcsHistoryCommit[] = [];
  const fields: string[] = [];
  const waiters = new Set<() => void>();
  let buffered = "";
  let stderr = "";
  let completed = false;
  let closed = false;
  let reading = false;
  let failure: unknown;

  const wake = () => {
    for (const waiter of waiters) waiter();
    waiters.clear();
  };
  const stop = () => {
    if (closed) return;
    closed = true;
    if (!completed) child.kill();
    wake();
  };
  const consume = (text: string) => {
    buffered += text;
    for (;;) {
      const delimiter = buffered.indexOf("\0");
      if (delimiter < 0) break;
      fields.push(buffered.slice(0, delimiter));
      buffered = buffered.slice(delimiter + 1);
      if (fields.length === prepared.fieldsPerCommit) {
        queue.push(
          ...parseJjHistory(
            `${fields.join("\0")}\0`,
            input.firstParent,
            omitGraphParents,
            prepared.fieldsPerCommit,
          ),
        );
        fields.length = 0;
      }
    }
    wake();
  };

  child.stdout!.on("data", (chunk: Buffer) => {
    try {
      consume(decoder.write(chunk));
      if (queue.length >= 512) child.stdout!.pause();
    } catch (error) {
      failure = error;
      completed = true;
      child.kill();
      wake();
    }
  });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.once("error", () => {
    failure = new HunkExtensionUserError(`Could not run ${jjExecutable}.`, {
      suggestions: ["Install Jujutsu or configure Hunk to use another VCS backend."],
    });
    completed = true;
    wake();
  });
  child.once("close", (code) => {
    if (!failure) {
      try {
        consume(decoder.end());
      } catch (error) {
        failure = error;
      }
    }
    if (!failure && (fields.length > 0 || buffered.length > 0)) {
      failure = new Error("Jujutsu returned a truncated history record.");
    } else if (!failure && code !== 0 && !closed) {
      failure = new HunkExtensionUserError(
        stderr.trim().split("\n")[0] || "Jujutsu could not read this history.",
        { suggestions: ["Check the revset, filters, and filesets, then try again."] },
      );
    }
    completed = true;
    wake();
  });

  const waitForData = (signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        stop();
        reject(signal.reason ?? new Error("History read aborted."));
        return;
      }
      const ready = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        waiters.delete(ready);
        stop();
        reject(signal?.reason ?? new Error("History read aborted."));
      };
      waiters.add(ready);
      signal?.addEventListener("abort", abort, { once: true });
    });

  return {
    repoRoot,
    ...(prepared.scope ? { scope: prepared.scope } : {}),
    async read({ limit, signal }) {
      if (reading) throw new Error("Concurrent Jujutsu history reads are not supported.");
      if (signal?.aborted) {
        stop();
        throw signal.reason ?? new Error("History read aborted.");
      }
      reading = true;
      try {
        const target = Math.min(Math.max(1, limit), 256);
        while (queue.length < target && !completed && !closed) await waitForData(signal);
        if (signal?.aborted) throw signal.reason ?? new Error("History read aborted.");
        if (failure) throw failure;
        const commits = queue.splice(0, target);
        if (!completed && !closed && queue.length < 256) child.stdout!.resume();
        return { commits, done: (completed || closed) && queue.length === 0 };
      } finally {
        reading = false;
      }
    },
    close: stop,
  };
}
