import type { ExtensionVcsHistoryCommit } from "hunkdiff/extension";

export const NATIVE_HISTORY_LIMITS = {
  record: 1024 * 1024,
  line: 4096,
  after: 128,
  graph: 256 * 1024,
  pending: 2 * 1024 * 1024,
  count: 512,
  queue: 8 * 1024 * 1024,
} as const;
export const NATIVE_BODY_MARKERS = [1, 2, 3].map((n) => ({
  start: `\x02HUNK:B${n}\x1e`,
  end: `\x1eHUNK:E${n}\x03`,
}));

/** Count retained normalized strings, including separate semantic and graph copies. */
export function nativeCommitRetainedBytes(commit: ExtensionVcsHistoryCommit): number {
  let units =
    commit.revisionId.length +
    commit.displayId.length +
    (commit.logicalId?.length ?? 0) +
    commit.subject.length +
    (commit.body?.length ?? 0) +
    commit.authorName.length +
    (commit.authorEmail?.length ?? 0) +
    commit.authoredAt.length;
  for (const values of [
    commit.parentRevisionIds,
    commit.graphParentRevisionIds,
    commit.graphCutoffParentRevisionIds,
  ])
    for (const value of values ?? []) units += value.length;
  for (const decoration of commit.decorations)
    units += decoration.kind.length + decoration.label.length;
  for (const line of [...(commit.nativeGraph?.body ?? []), ...(commit.nativeGraph?.after ?? [])])
    units += line.length;
  return units * 2;
}

/** Reject graph text that cannot occupy one bounded printable physical terminal row. */
export function validateNativeGraphLine(line: string) {
  if (line.length > NATIVE_HISTORY_LIMITS.line)
    throw new Error("Jujutsu native graph line exceeds 4096 code units.");
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(line))
    throw new Error("Jujutsu native graph contains unsafe control characters.");
}

interface NativeEntry {
  record: string;
  body: string[];
  after: string[];
  graphUnits: number;
}

/**
 * Frame native JJ output at LF boundaries and retain complete entries until their graph tails end.
 * Queue pressure leaves the next record unread so readers can drain without exceeding budgets.
 */
export class NativeHistoryParser {
  private raw = Buffer.alloc(0);
  private entry: NativeEntry | undefined;
  private queue: ExtensionVcsHistoryCommit[] = [];
  private queueBytes = 0;
  private blocked = false;
  private ended = false;
  private parsedEnd = false;
  private ids = new Set<string>();
  constructor(private readonly decodeRecord: (record: string) => ExtensionVcsHistoryCommit) {}

  get count() {
    return this.queue.length;
  }
  get pressured() {
    return (
      this.blocked ||
      this.queue.length >= NATIVE_HISTORY_LIMITS.count ||
      this.queueBytes >= NATIVE_HISTORY_LIMITS.queue
    );
  }
  get exhausted() {
    return this.parsedEnd && this.queue.length === 0;
  }

  /** Transfer undecoded input into the bounded parser, preserving split UTF-8 sequences. */
  push(chunk: Uint8Array) {
    if (this.ended) throw new Error("Jujutsu returned output after EOF.");
    this.raw = Buffer.concat([this.raw, chunk]);
    this.drain();
    this.checkPending();
  }

  /** Finish the last physical line and entry, deferring finalization if readers must drain first. */
  finish() {
    this.ended = true;
    this.drain();
    this.checkPending();
  }

  /** Drain complete records and resume parsing the retained transport remainder. */
  read(limit: number) {
    const commits = this.queue.splice(0, limit);
    for (const commit of commits) this.queueBytes -= nativeCommitRetainedBytes(commit);
    this.blocked = false;
    this.drain();
    this.checkPending();
    return commits;
  }

  /** Count undecoded bytes plus two bytes per retained decoded UTF-16 unit. */
  private checkPending() {
    const bytes =
      this.raw.length + (this.entry ? 2 * (this.entry.record.length + this.entry.graphUnits) : 0);
    if (bytes > NATIVE_HISTORY_LIMITS.pending)
      throw new Error("Jujutsu history pending buffer exceeded 2 MiB budget.");
  }

  /** Decode only complete physical lines, rejecting malformed UTF-8 without exposing raw data. */
  private decode(bytes: Uint8Array) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("Jujutsu returned invalid UTF-8 history output.");
    }
  }

  /** Process complete physical rows until the ready queue reaches its count or byte bound. */
  private drain() {
    while (!this.pressured) {
      const lf = this.raw.indexOf(10);
      if (lf < 0 && !this.ended) break;
      if (this.raw.length === 0) {
        if (this.ended && this.finalize()) this.parsedEnd = true;
        break;
      }
      const length = lf < 0 ? this.raw.length : lf;
      const line = this.decode(this.raw.subarray(0, length));
      if (!this.line(line)) break;
      this.raw = this.raw.subarray(length + (lf < 0 ? 0 : 1));
      this.checkPending();
    }
  }

  /** Attach validated graph rows to the current entry without retaining oversized fragments. */
  private graph(line: string, after: boolean) {
    validateNativeGraphLine(line);
    const entry = this.entry!;
    if (after && entry.after.length >= NATIVE_HISTORY_LIMITS.after)
      throw new Error("Jujutsu native graph after rows exceeded 128 rows limit.");
    if ((entry.graphUnits + line.length) * 2 > NATIVE_HISTORY_LIMITS.graph)
      throw new Error("Jujutsu native graph total text exceeded 256 KiB budget.");
    entry.graphUnits += line.length;
    (after ? entry.after : entry.body).push(line);
  }

  /** Require exactly one distinguished body marker and no hidden payload or suffix. */
  private body(line: string, number: number) {
    const marker = NATIVE_BODY_MARKERS[number - 1]!;
    const start = line.indexOf(marker.start);
    const end = line.indexOf(marker.end, start + marker.start.length);
    if (start < 0 || end < 0 || end + marker.end.length !== line.length)
      throw new Error(`Jujutsu returned a malformed B${number} body record.`);
    const prefix = line.slice(0, start);
    validateNativeGraphLine(prefix);
    const payload = line.slice(start + marker.start.length, end);
    if (number !== 1 && payload !== "")
      throw new Error("Jujutsu returned unexpected body record payload.");
    return { prefix, payload };
  }

  /** Frame metadata separately from printable graph prefixes and graph-only continuation rows. */
  private line(line: string): boolean {
    if (line.includes(NATIVE_BODY_MARKERS[0]!.start)) {
      if (!this.finalize()) return false;
      const { prefix, payload } = this.body(line, 1);
      if (Buffer.byteLength(payload, "utf8") > NATIVE_HISTORY_LIMITS.record)
        throw new Error("Jujutsu history machine record exceeded 1 MiB budget.");
      this.entry = { record: payload, body: [], after: [], graphUnits: 0 };
      this.graph(prefix, false);
    } else if (!this.entry) {
      if (line !== "")
        throw new Error("Jujutsu returned unexpected output before the first commit record.");
    } else if (this.entry.body.length < 3) {
      this.graph(this.body(line, this.entry.body.length + 1).prefix, false);
    } else {
      this.graph(line, true);
    }
    return true;
  }

  /** Enqueue one normalized entry only when its entire graph tail and queue budget are valid. */
  private finalize(): boolean {
    if (!this.entry) return true;
    if (this.entry.body.length !== 3)
      throw new Error("Jujutsu returned a truncated history record.");
    const commit = this.decodeRecord(this.entry.record);
    commit.nativeGraph = {
      body: this.entry.body as [string, string, string],
      after: this.entry.after,
    };
    const bytes = nativeCommitRetainedBytes(commit);
    if (bytes > NATIVE_HISTORY_LIMITS.queue)
      throw new Error("Jujutsu history entry exceeded queue byte budget.");
    if (
      this.queue.length >= NATIVE_HISTORY_LIMITS.count ||
      this.queueBytes + bytes > NATIVE_HISTORY_LIMITS.queue
    ) {
      this.blocked = true;
      return false;
    }
    if (this.ids.has(commit.revisionId))
      throw new Error("Jujutsu returned duplicate history revision.");
    this.ids.add(commit.revisionId);
    this.queue.push(commit);
    this.queueBytes += bytes;
    this.entry = undefined;
    return true;
  }
}
