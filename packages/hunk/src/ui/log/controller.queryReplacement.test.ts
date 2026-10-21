import { describe, expect, test } from "bun:test";
import { createTestExtensionSession } from "../../../../../test/helpers/extension-session";
import { persistedViewPreferencesFromOptions } from "../../core/run/config";
import type { HistoryCommandInput } from "../../core/run/commandInputs";
import type { VcsHistorySource } from "../../core/vcs/types";
import type { ExtensionVcsHistoryCommit } from "../../extension-api/types";
import type { HistoryQueryTarget } from "../../core/history/queryReplacement";
import type { HistoryRuntime } from "../history/types";
import { revisionMarkSeenUnder, revisionMarkTraversalKey } from "../../core/history/revisionMarks";
import { LogController } from "./controller";

interface TestEntry {
  revisionId: string;
  logicalId?: string;
  decorations?: ExtensionVcsHistoryCommit["decorations"];
  parents?: string[];
  graphParents?: string[];
  /** Real parents the boundary cut: each adds a row to the entry, making it taller. */
  cutoffs?: string[];
}

interface TestQuery {
  entries: TestEntry[];
  scope?: VcsHistorySource["scope"];
  /** Rejects the open (or the first read) with this error. */
  openError?: Error;
  readError?: Error;
  /** Holds the open until released, to stage races. */
  gate?: Promise<void>;
  /** Holds every read until released. */
  readGate?: Promise<void>;
  /** Most commits one read returns, however large the requested limit. */
  pageSize?: number;
  /** Serve every entry even when the row limit would cut them, to exercise paging. */
  ignoreMax?: boolean;
}

const LAUNCH_ENTRIES: TestEntry[] = ["l1", "l2", "l3"].map((revisionId) => ({
  revisionId,
  logicalId: `change-${revisionId}`,
  parents: [],
}));

function toCommit(entry: TestEntry): ExtensionVcsHistoryCommit {
  return {
    revisionId: entry.revisionId,
    displayId: entry.revisionId,
    parentRevisionIds: entry.parents ?? [],
    ...(entry.graphParents ? { graphParentRevisionIds: entry.graphParents } : {}),
    subject: entry.revisionId,
    ...(entry.cutoffs
      ? {
          parentRevisionIds: entry.cutoffs,
          graphParentRevisionIds: [],
          graphCutoffParentRevisionIds: entry.cutoffs,
        }
      : {}),
    ...(entry.logicalId ? { logicalId: entry.logicalId } : {}),
    authorName: "Ada",
    authoredAt: "2026-01-01T00:00:00Z",
    decorations: entry.decorations ?? [],
  };
}

/** Build a history runtime whose provider answers each query from a table and records every call. */
function createTestQueryRuntime({
  maxCount,
  queries = {},
  editable = true,
}: {
  maxCount?: number;
  queries?: Record<string, TestQuery>;
  editable?: boolean;
} = {}) {
  const log = {
    opened: [] as string[],
    reads: [] as Array<{ query: string; limit: number }>,
    targets: [] as HistoryQueryTarget[],
    readSignals: [] as Array<{ query: string; signal?: AbortSignal }>,
    closed: [] as string[],
    accepted: [] as string[],
    watched: [] as string[],
  };
  const table: Record<string, TestQuery> = {
    launch: {
      entries: LAUNCH_ENTRIES,
      scope: { kind: "bounded", boundaryRevisionId: "bound" },
    },
    ...queries,
  };
  let acceptedKey = "launch";
  const keyOf = (target: HistoryQueryTarget) =>
    target.kind === "launch" ? "launch" : target.expression;
  const makeSource = (key: string, serial: number): VcsHistorySource => {
    const query = table[key] ?? { entries: [] };
    // The provider applies the row limit, as the real ones do.
    const entries =
      maxCount === undefined || query.ignoreMax ? query.entries : query.entries.slice(0, maxCount);
    let cursor = 0;
    const label = `${key}#${serial}`;
    return {
      ...(query.scope ? { scope: query.scope } : {}),
      ...(key === "launch" ? { expression: "launch-text" } : { expression: key }),
      async read({ limit, signal }) {
        log.reads.push({ query: key, limit });
        log.readSignals.push({ query: key, signal });
        await query.readGate;
        if (query.readError) throw query.readError;
        const taken = entries.slice(cursor, cursor + Math.min(limit, query.pageSize ?? limit));
        cursor += taken.length;
        return { commits: taken.map(toCommit), done: cursor >= entries.length };
      },
      async close() {
        log.closed.push(label);
      },
    };
  };
  let serial = 0;
  const open = async (key: string) => {
    log.opened.push(key);
    const query = table[key] ?? { entries: [] };
    await query.gate;
    if (query.openError) throw query.openError;
    return makeSource(key, ++serial);
  };
  const input: HistoryCommandInput = {
    kind: "history",
    ...(maxCount === undefined ? {} : { maxCount }),
    color: "never",
    format: "compact",
    ascii: false,
    static: false,
    extensionsEnabled: false,
    extensionPaths: [],
  };
  let source = makeSource("launch", ++serial);
  const runtime: HistoryRuntime = {
    input,
    source,
    extensionSession: createTestExtensionSession(),
    providerId: "test",
    providerName: "Test",
    repoRoot: "/repo",
    notices: [],
    customThemes: [],
    keybindings: {},
    initialViewPreferences: persistedViewPreferencesFromOptions({}),
    promptSaveViewPreferences: true,
    async planReview(commit) {
      return { kind: "revision-show", revisionId: commit.revisionId };
    },
    // Refresh and watch follow whichever query was accepted last.
    reopenSource: async () => open(acceptedKey),
    async acceptSource(next) {
      source = next;
    },
    historyWatchSignature: async () => {
      log.watched.push(acceptedKey);
      return acceptedKey;
    },
    ...(editable && {
      queryReplacement: {
        open: (target: HistoryQueryTarget) => {
          log.targets.push(target);
          return open(keyOf(target));
        },
        async accept(target: HistoryQueryTarget, next: VcsHistorySource) {
          acceptedKey = keyOf(target);
          log.accepted.push(acceptedKey);
          const previous = source;
          source = next;
          await previous.close();
        },
      },
    }),
    async close() {
      await source.close();
    },
  };
  return { runtime, log, table, acceptedKey: () => acceptedKey };
}

const subjects = (controller: LogController) =>
  controller.getSnapshot().rows.map((row) => row.commit.revisionId);

async function loadedController(options: Parameters<typeof createTestQueryRuntime>[0] = {}) {
  const fixture = createTestQueryRuntime(options);
  const controller = new LogController(fixture.runtime);
  await controller.loadMore();
  while (!controller.getSnapshot().historyDone) await controller.loadMore();
  return { ...fixture, controller };
}

describe("LogController.replaceQuery", () => {
  test("applies an expression: rows, source, accepted input, query state and watch move together", async () => {
    const { controller, log } = await loadedController({
      queries: {
        "@-": { entries: [{ revisionId: "p1" }, { revisionId: "p2" }] },
      },
    });
    expect(controller.getSnapshot().query).toEqual({
      editable: true,
      mode: "launch",
      expression: "launch-text",
      generation: 0,
    });

    const result = await controller.replaceQuery({ kind: "apply", expression: "  @-  " });

    expect(result).toEqual({ status: "applied", mode: "custom", expression: "@-" });
    expect(subjects(controller)).toEqual(["p1", "p2"]);
    expect(controller.getSnapshot()).toMatchObject({
      historyDone: true,
      scope: undefined,
      markStatus: "ready",
      query: { editable: true, mode: "custom", expression: "@-", generation: 1 },
    });
    expect(log.opened).toEqual(["@-"]);
    expect(log.accepted).toEqual(["@-"]);
    // The launch source closed once, when the replacement was accepted.
    expect(log.closed).toEqual(["launch#1"]);
    await controller.close();
  });

  test("keeps the launch row limit separate and reads one page narrowed by it", async () => {
    const { controller, log } = await loadedController({
      maxCount: 2,
      queries: { all: { entries: ["a", "b", "c"].map((revisionId) => ({ revisionId })) } },
    });
    expect(controller.getSnapshot().query?.limit).toBe(2);
    await controller.replaceQuery({ kind: "apply", expression: "all" });
    expect(log.reads.filter((read) => read.query === "all")[0]?.limit).toBe(2);
    expect(controller.getSnapshot().query?.limit).toBe(2);
    await controller.close();
  });

  test("keeps focus on the exact revision when the first page holds it", async () => {
    const { controller } = await loadedController({
      queries: {
        q: { entries: [{ revisionId: "n1" }, { revisionId: "l2" }, { revisionId: "n3" }] },
      },
    });
    await controller.select(1, 10);
    expect(controller.getSnapshot().selected).toBe(1);
    await controller.replaceQuery({ kind: "apply", expression: "q" });
    expect(controller.getSnapshot().selected).toBe(1);
    expect(controller.getSnapshot().rows[1]?.commit.revisionId).toBe("l2");
    expect(controller.getSnapshot().notice).toBe("");
    await controller.close();
  });

  test("selects the newest row with a timed notice when the focused revision is not loaded", async () => {
    const { controller } = await loadedController({
      queries: { q: { entries: [{ revisionId: "n1" }, { revisionId: "n2" }] } },
    });
    await controller.select(2, 10);
    await controller.replaceQuery({ kind: "apply", expression: "q" });
    expect(controller.getSnapshot().selected).toBe(0);
    expect(controller.getSnapshot().notice).toBe("Selected newest; previous not loaded.");
    await controller.close();
  });

  test("does not follow a rewritten revision by its logical id", async () => {
    const { controller } = await loadedController({
      queries: {
        q: { entries: [{ revisionId: "n1" }, { revisionId: "rewritten", logicalId: "change-l2" }] },
      },
    });
    await controller.select(1, 10);
    await controller.replaceQuery({ kind: "apply", expression: "q" });
    expect(controller.getSnapshot().selected).toBe(0);
    expect(controller.getSnapshot().notice).toBe("Selected newest; previous not loaded.");
    await controller.close();
  });

  test("clears focus for an empty result", async () => {
    const { controller } = await loadedController({ queries: { none: { entries: [] } } });
    await controller.select(1, 10);
    const result = await controller.replaceQuery({ kind: "apply", expression: "none" });
    expect(result.status).toBe("applied");
    expect(controller.getSnapshot()).toMatchObject({
      rows: [],
      selected: 0,
      historyDone: true,
      notice: "",
    });
    expect(controller.getSelection()).toBeUndefined();
    await controller.close();
  });

  test("drops a range selection and a visual anchor", async () => {
    const { controller } = await loadedController({
      queries: { q: { entries: [{ revisionId: "l1" }, { revisionId: "l2" }] } },
    });
    controller.beginVisualSelection();
    await controller.select(1, 10, { extend: true });
    expect(controller.getSnapshot().selectionAnchor).toBe(0);
    await controller.replaceQuery({ kind: "apply", expression: "q" });
    expect(controller.getSnapshot()).toMatchObject({
      selectionAnchor: null,
      visualSelectionActive: false,
    });
    await controller.close();
  });

  test("rejects a blank draft without opening anything", async () => {
    const { controller, log } = await loadedController();
    expect(await controller.replaceQuery({ kind: "apply", expression: " \t " })).toEqual({
      status: "failed",
      reason: "Enter a revset, or choose Reset.",
    });
    expect(log.opened).toEqual([]);
    await controller.close();
  });

  test("reports an editor-less provider as failed and not editable", async () => {
    const { controller, log } = await loadedController({ editable: false });
    expect(controller.getSnapshot().query?.editable).toBe(false);
    expect(await controller.replaceQuery({ kind: "apply", expression: "@" })).toEqual({
      status: "failed",
      reason: "This VCS provider does not support custom revsets.",
    });
    expect(log.opened).toEqual([]);
    await controller.close();
  });
});

describe("LogController.replaceQuery failure and races", () => {
  test("changes nothing when the open fails, and returns the capped provider text", async () => {
    const reason = `Function \`x\` doesn't exist\nCaused by:  --> 1:1\n${"y".repeat(5000)}`;
    const { controller, log } = await loadedController({
      queries: { bad: { entries: [], openError: new Error(reason) } },
    });
    controller.toggleMark();
    const before = controller.getSnapshot();
    const result = await controller.replaceQuery({ kind: "apply", expression: "bad" });
    expect(result.status).toBe("failed");
    const text = (result as { reason: string }).reason;
    expect(text.startsWith("Function `x` doesn't exist\nCaused by:  --> 1:1\n")).toBeTrue();
    expect(text).toHaveLength(4096);
    expect(text.endsWith("…")).toBeTrue();
    const after = controller.getSnapshot();
    expect(after).toEqual(before);
    expect(log.accepted).toEqual([]);
    expect(log.closed).toEqual([]);
    await controller.close();
  });

  test("changes nothing when the first read fails, and closes the candidate once", async () => {
    const { controller, log } = await loadedController({
      queries: { bad: { entries: [], readError: new Error("Revision `nope` doesn't exist") } },
    });
    const before = controller.getSnapshot();
    expect(await controller.replaceQuery({ kind: "apply", expression: "bad" })).toEqual({
      status: "failed",
      reason: "Revision `nope` doesn't exist",
    });
    expect(controller.getSnapshot()).toEqual(before);
    expect(log.accepted).toEqual([]);
    expect(log.closed).toEqual(["bad#2"]);
    await controller.close();
  });

  test("keeps working after a failure: the accepted source still pages and refreshes", async () => {
    const { controller, log } = await loadedController({
      queries: { bad: { entries: [], openError: new Error("nope") } },
    });
    await controller.replaceQuery({ kind: "apply", expression: "bad" });
    expect(await controller.refresh()).toBeTrue();
    expect(subjects(controller)).toEqual(["l1", "l2", "l3"]);
    expect(log.opened).toEqual(["bad", "launch"]);
    await controller.close();
  });

  test("an aborted candidate closes its cursor and leaves the accepted view alone", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { controller, log } = await loadedController({
      queries: { slow: { entries: [{ revisionId: "s1" }], gate } },
    });
    const before = controller.getSnapshot();
    const abort = new AbortController();
    const pending = controller.replaceQuery({ kind: "apply", expression: "slow" }, abort.signal);
    abort.abort();
    release();
    expect(await pending).toEqual({ status: "aborted" });
    expect(controller.getSnapshot()).toEqual(before);
    expect(log.accepted).toEqual([]);
    expect(log.closed).toEqual(["slow#2"]);
    await controller.close();
  });

  test("a newer request wins: the older candidate never publishes and closes itself", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { controller, log } = await loadedController({
      queries: {
        old: { entries: [{ revisionId: "o1" }], gate },
        fresh: { entries: [{ revisionId: "f1" }] },
      },
    });
    const older = controller.replaceQuery({ kind: "apply", expression: "old" });
    const newer = await controller.replaceQuery({ kind: "apply", expression: "fresh" });
    expect(newer.status).toBe("applied");
    release();
    expect(await older).toEqual({ status: "obsolete" });
    expect(subjects(controller)).toEqual(["f1"]);
    expect(log.accepted).toEqual(["fresh"]);
    expect(log.closed).toContain("old#3");
    expect(controller.getSnapshot().query?.expression).toBe("fresh");
    await controller.close();
  });

  test("quit wins: a candidate still opening closes its cursor and nothing is accepted", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { controller, log } = await loadedController({
      queries: { slow: { entries: [{ revisionId: "s1" }], gate } },
    });
    const pending = controller.replaceQuery({ kind: "apply", expression: "slow" });
    const closing = controller.close();
    release();
    expect(await pending).toEqual({ status: "obsolete" });
    await closing;
    expect(log.accepted).toEqual([]);
    expect(log.closed.filter((entry) => entry.startsWith("slow"))).toEqual(["slow#2"]);
  });

  test("a replacement racing a navigation does not leave the navigation moving the new rows", async () => {
    const { controller } = await loadedController({
      queries: { q: { entries: [{ revisionId: "n1" }, { revisionId: "n2" }] } },
    });
    const moving = controller.select(2, 10);
    await controller.replaceQuery({ kind: "apply", expression: "q" });
    await moving;
    expect(controller.isNavigating()).toBeFalse();
    expect(subjects(controller)).toEqual(["n1", "n2"]);
    expect(controller.getSnapshot().selected).toBeLessThanOrEqual(1);
    await controller.close();
  });
});

describe("LogController.replaceQuery marks, refresh and guards", () => {
  test("keeps marks whose exact id is in the first page and leaves the rest unresolved", async () => {
    const { controller } = await loadedController({
      queries: {
        q: { entries: [{ revisionId: "l2" }, { revisionId: "other", logicalId: "change-l3" }] },
      },
    });
    controller.toggleMark(0);
    controller.toggleMark(1);
    controller.toggleMark(2);
    await controller.replaceQuery({ kind: "apply", expression: "q" });
    const marks = controller.getSnapshot().marks;
    expect(marks.map((entry) => [entry.kind, entry.mark.revisionId])).toEqual([
      ["unresolved", "l1"],
      ["resolved", "l2"],
      // `other` carries l3's logical id, yet a changed query never re-targets a mark to it.
      ["unresolved", "l3"],
    ]);
    expect(marks.filter((entry) => entry.kind === "unresolved")).toEqual([
      expect.objectContaining({ reason: "incomplete" }),
      expect.objectContaining({ reason: "incomplete" }),
    ]);
    expect(controller.getSnapshot().markStatus).toBe("ready");
    expect(controller.getOperationTargets().kind).toBe("blocked");
    await controller.close();
  });

  test("refresh under a custom revset reopens the accepted query and keeps unresolved marks incomplete", async () => {
    const { controller, log, table } = await loadedController({
      queries: { "@": { entries: [{ revisionId: "w1", logicalId: "wc" }] } },
    });
    await controller.replaceQuery({ kind: "apply", expression: "@" });
    controller.toggleMark(0);
    // `@` now resolves to another revision of the same logical change.
    table["@"] = { entries: [{ revisionId: "w2", logicalId: "wc" }] };
    expect(await controller.refresh()).toBeTrue();
    expect(log.opened.at(-1)).toBe("@");
    expect(subjects(controller)).toEqual(["w2"]);
    expect(controller.getSnapshot().marks).toEqual([
      expect.objectContaining({ kind: "unresolved", reason: "incomplete" }),
    ]);
    expect(controller.getSnapshot().query?.mode).toBe("custom");
    await controller.close();
  });

  test("a refresh that started before an Apply is dropped, not applied over it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { controller, table } = await loadedController({
      queries: { q: { entries: [{ revisionId: "n1" }] } },
    });
    table.launch = { ...table.launch!, entries: [{ revisionId: "stale" }], gate };
    const refreshing = controller.refresh();
    await controller.replaceQuery({ kind: "apply", expression: "q" });
    release();
    expect(await refreshing).toBeFalse();
    expect(subjects(controller)).toEqual(["n1"]);
    await controller.close();
  });

  test("blocks range selection and visual mode while an expression is accepted, and Reset lifts it", async () => {
    const { controller } = await loadedController({
      queries: {
        q: { entries: [{ revisionId: "n1" }, { revisionId: "n2" }, { revisionId: "n3" }] },
      },
    });
    const notice =
      "Multi-commit selection is unavailable when history traversal can hide or interleave commits.";
    await controller.replaceQuery({ kind: "apply", expression: "q" });
    await controller.select(1, 10, { extend: true });
    expect(controller.getSnapshot().notice).toBe(notice);
    expect(controller.getSnapshot().selectionAnchor).toBeNull();
    controller.beginVisualSelection();
    expect(controller.getSnapshot().visualSelectionActive).toBeFalse();

    expect(await controller.replaceQuery({ kind: "reset" })).toMatchObject({
      status: "applied",
      mode: "launch",
    });
    await controller.select(1, 10, { extend: true });
    expect(controller.getSnapshot().selectionAnchor).toBe(0);
    await controller.close();
  });

  test("draws no graph link under an expression, whatever graph parents the provider sent", async () => {
    const { controller } = await loadedController({
      queries: {
        q: {
          entries: [
            { revisionId: "n1", parents: ["n2"], graphParents: ["n2"] },
            { revisionId: "n2", parents: [] },
          ],
        },
      },
    });
    await controller.replaceQuery({ kind: "apply", expression: "q" });
    const rows = controller.getSnapshot().rows;
    expect(rows.map((row) => row.lanesAfter)).toEqual([[], []]);
    // Real parent ids still drive single-revision review.
    expect(rows[0]!.commit.parentRevisionIds).toEqual(["n2"]);
    await controller.close();
  });

  test("Reset restores the launch input, its scope and its watch", async () => {
    const { controller, log, acceptedKey } = await loadedController({
      queries: { q: { entries: [{ revisionId: "n1" }] } },
    });
    await controller.replaceQuery({ kind: "apply", expression: "q" });
    expect(controller.getSnapshot().scope).toBeUndefined();
    expect(acceptedKey()).toBe("q");
    const result = await controller.replaceQuery({ kind: "reset" });
    expect(result).toEqual({ status: "applied", mode: "launch", expression: "launch-text" });
    expect(subjects(controller)).toEqual(["l1", "l2", "l3"]);
    expect(controller.getSnapshot().scope).toEqual({
      kind: "bounded",
      boundaryRevisionId: "bound",
    });
    expect(controller.getSnapshot().query).toMatchObject({ mode: "launch", generation: 2 });
    expect(acceptedKey()).toBe("launch");
    expect(await controller.refresh()).toBeTrue();
    expect(log.opened.at(-1)).toBe("launch");
    await controller.close();
  });

  test("Reset that fails leaves the custom view in place", async () => {
    const { controller, table } = await loadedController({
      queries: { q: { entries: [{ revisionId: "n1" }] } },
    });
    await controller.replaceQuery({ kind: "apply", expression: "q" });
    table.launch = { ...table.launch!, openError: new Error("Could not run jj.") };
    expect(await controller.replaceQuery({ kind: "reset" })).toEqual({
      status: "failed",
      reason: "Could not run jj.",
    });
    expect(subjects(controller)).toEqual(["n1"]);
    expect(controller.getSnapshot().query?.mode).toBe("custom");
    await controller.close();
  });
});

describe("LogController.replaceQuery marks across Reset", () => {
  const markedEntries = (...entries: TestEntry[]) => entries;
  const resolution = (controller: LogController) =>
    controller
      .getSnapshot()
      .marks.map((entry) => [
        entry.kind,
        entry.mark.revisionId,
        entry.kind === "unresolved" ? entry.reason : undefined,
        entry.kind === "resolved" ? entry.revisionId : undefined,
      ]);

  test("a mark made under a custom revset is incomplete after Reset, though launch holds its change id", async () => {
    const { controller } = await loadedController({
      queries: { q: { entries: [{ revisionId: "c1", logicalId: "change-l2" }] } },
    });
    await controller.replaceQuery({ kind: "apply", expression: "q" });
    controller.toggleMark(0);
    await controller.replaceQuery({ kind: "reset" });
    expect(resolution(controller)).toEqual([["unresolved", "c1", "incomplete", undefined]]);
    await controller.close();
  });

  test("a mark at launch, carried through an Apply that includes it and a rewrite, is incomplete after Reset", async () => {
    const { controller, table } = await loadedController({
      queries: { q: { entries: [{ revisionId: "l2", logicalId: "change-l2" }] } },
    });
    controller.toggleMark(1);
    await controller.replaceQuery({ kind: "apply", expression: "q" });
    expect(resolution(controller)).toEqual([["resolved", "l2", undefined, "l2"]]);
    table.launch!.entries = markedEntries(
      { revisionId: "l1" },
      { revisionId: "l2b", logicalId: "change-l2" },
      { revisionId: "l3" },
    );
    await controller.replaceQuery({ kind: "reset" });
    expect(resolution(controller)).toEqual([["unresolved", "l2", "incomplete", undefined]]);
    await controller.close();
  });

  test("a mark at launch that an Apply excludes follows its rewritten change on a complete Reset", async () => {
    const { controller, table } = await loadedController({
      queries: { q: { entries: [{ revisionId: "n1" }] } },
    });
    controller.toggleMark(1);
    await controller.replaceQuery({ kind: "apply", expression: "q" });
    expect(resolution(controller)).toEqual([["unresolved", "l2", "incomplete", undefined]]);
    table.launch!.entries = markedEntries(
      { revisionId: "l1" },
      { revisionId: "l2b", logicalId: "change-l2" },
      { revisionId: "l3" },
    );
    await controller.replaceQuery({ kind: "reset" });
    expect(resolution(controller)).toEqual([["resolved", "l2b", undefined, "l2b"]]);
    await controller.close();
  });

  test("the same mark is missing on a complete Reset when its change is gone", async () => {
    const { controller, table } = await loadedController({
      queries: { q: { entries: [{ revisionId: "n1" }] } },
    });
    controller.toggleMark(1);
    await controller.replaceQuery({ kind: "apply", expression: "q" });
    table.launch!.entries = markedEntries({ revisionId: "l1" }, { revisionId: "l3" });
    await controller.replaceQuery({ kind: "reset" });
    expect(resolution(controller)).toEqual([["unresolved", "l2", "missing", undefined]]);
    await controller.close();
  });

  test("a Reset with no Apply ever follows a rewritten change", async () => {
    const { controller, table } = await loadedController();
    controller.toggleMark(1);
    table.launch!.entries = markedEntries(
      { revisionId: "l1" },
      { revisionId: "l2b", logicalId: "change-l2" },
      { revisionId: "l3" },
    );
    await controller.replaceQuery({ kind: "reset" });
    expect(resolution(controller)).toEqual([["resolved", "l2b", undefined, "l2b"]]);
    await controller.close();
  });

  test("a launch row limit keeps every Reset incomplete", async () => {
    const { controller, table } = await loadedController({
      maxCount: 2,
      queries: { q: { entries: [{ revisionId: "n1" }] } },
    });
    controller.toggleMark(1);
    await controller.replaceQuery({ kind: "apply", expression: "q" });
    table.launch!.entries = markedEntries(
      { revisionId: "l1" },
      { revisionId: "l2b", logicalId: "change-l2" },
    );
    await controller.replaceQuery({ kind: "reset" });
    expect(resolution(controller)).toEqual([["unresolved", "l2", "incomplete", undefined]]);
    await controller.close();
  });

  test("returning to an earlier expression never proves a mark gone or follows it", async () => {
    const { controller, table } = await loadedController({
      queries: {
        a: { entries: [{ revisionId: "a1", logicalId: "change-a" }] },
        b: { entries: [{ revisionId: "b1" }] },
      },
    });
    await controller.replaceQuery({ kind: "apply", expression: "a" });
    controller.toggleMark(0);
    expect(resolution(controller)).toEqual([["resolved", "a1", undefined, "a1"]]);
    await controller.replaceQuery({ kind: "apply", expression: "b" });
    table.a!.entries = [{ revisionId: "a2", logicalId: "change-a" }];
    await controller.replaceQuery({ kind: "apply", expression: "a" });
    expect(resolution(controller)).toEqual([["unresolved", "a1", "incomplete", undefined]]);
    await controller.close();
  });

  test("an Apply restamps a kept mark with the new traversal's name, never the old one", async () => {
    const { controller } = await loadedController({
      queries: { q: { entries: [{ revisionId: "l2" }] } },
    });
    controller.toggleMark(1);
    const launchName = controller.getSnapshot().marks[0]!.mark.seenUnder;
    await controller.replaceQuery({ kind: "apply", expression: "q" });
    const stamped = controller.getSnapshot().marks[0]!.mark.seenUnder;
    expect(stamped).toBe(
      revisionMarkSeenUnder(
        revisionMarkTraversalKey({ kind: "expression", expression: "q" }),
        undefined,
      ),
    );
    expect(stamped).not.toBe(launchName);
    await controller.close();
  });

  test("the accepted traversal is recorded: a scope-less provider's custom mark is incomplete after Reset", async () => {
    const { controller, table } = await loadedController({
      queries: { q: { entries: [{ revisionId: "c1", logicalId: "change-c" }] } },
    });
    // With no scope on either side, only the traversal key tells launch from custom rows.
    table.launch!.scope = undefined;
    controller.toggleMark(1);
    await controller.replaceQuery({ kind: "reset" });
    await controller.replaceQuery({ kind: "apply", expression: "q" });
    controller.toggleMark(0);
    table.launch!.entries = [{ revisionId: "l1" }, { revisionId: "c2", logicalId: "change-c" }];
    await controller.replaceQuery({ kind: "reset" });
    const marks = resolution(controller);
    expect(marks.find((mark) => mark[1] === "c1")).toEqual([
      "unresolved",
      "c1",
      "incomplete",
      undefined,
    ]);
    await controller.close();
  });
});

describe("LogController.replaceQuery rules", () => {
  test("hands the launch row limit to the provider and stays within it while paging", async () => {
    const { controller, log } = await loadedController({
      maxCount: 2,
      queries: {
        all: { entries: ["a", "b", "c", "d", "e"].map((revisionId) => ({ revisionId })) },
      },
    });
    await controller.replaceQuery({ kind: "apply", expression: "all" });
    expect(log.targets).toEqual([{ kind: "expression", expression: "all", maxCount: 2 }]);
    await controller.loadMore();
    expect(subjects(controller)).toEqual(["a", "b"]);
    expect(controller.getSnapshot().historyDone).toBeTrue();
    await controller.close();
  });

  test("omits maxCount from the target when the launch had no limit", async () => {
    const { controller, log } = await loadedController({
      queries: { all: { entries: [{ revisionId: "a" }] } },
    });
    await controller.replaceQuery({ kind: "apply", expression: "all" });
    expect(log.targets).toEqual([{ kind: "expression", expression: "all" }]);
    await controller.close();
  });

  test("strips graph links from later pages and from refresh pages, not only the first", async () => {
    const chain: TestEntry[] = [
      { revisionId: "n1", parents: ["n2"], graphParents: ["n2"] },
      { revisionId: "n2", parents: ["n3"], graphParents: ["n3"] },
      { revisionId: "n3", parents: ["n4"], graphParents: ["n4"] },
      { revisionId: "n4", parents: [], graphParents: [] },
    ];
    const { controller } = await loadedController({
      maxCount: 100,
      queries: { q: { entries: chain, pageSize: 2 } },
    });
    await controller.replaceQuery({ kind: "apply", expression: "q" });
    expect(subjects(controller)).toEqual(["n1", "n2"]);
    await controller.loadMore();
    expect(subjects(controller)).toEqual(["n1", "n2", "n3", "n4"]);
    expect(controller.getSnapshot().rows.map((row) => row.lanesAfter)).toEqual([[], [], [], []]);

    expect(await controller.refresh()).toBeTrue();
    expect(subjects(controller).length).toBeGreaterThan(0);
    expect(controller.getSnapshot().rows.every((row) => row.lanesAfter.length === 0)).toBeTrue();
    await controller.close();
  });

  test("the first page of a replacement never reads more than the page limit, and done follows the page", async () => {
    const { controller, log } = await loadedController({
      queries: {
        q: { entries: ["a", "b", "c"].map((revisionId) => ({ revisionId })), pageSize: 2 },
      },
    });
    await controller.replaceQuery({ kind: "apply", expression: "q" });
    expect(log.reads.find((read) => read.query === "q")?.limit).toBe(256);
    expect(controller.getSnapshot().historyDone).toBeFalse();
    await controller.loadMore();
    expect(controller.getSnapshot().historyDone).toBeTrue();
    expect(subjects(controller)).toEqual(["a", "b", "c"]);
    // The continuation read the accepted source, not the launch source.
    expect(log.reads.filter((read) => read.query === "q")).toHaveLength(2);
    expect(log.reads.filter((read) => read.query === "launch")).toHaveLength(1);
    await controller.close();
  });

  test("an Apply during a page load drops that page, aborts the old read and resets loading", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { controller, log, table } = await loadedController({
      queries: { q: { entries: [{ revisionId: "n1" }] } },
    });
    // Reopen the controller on a launch source that pages two at a time.
    table.launch!.pageSize = 2;
    await controller.replaceQuery({ kind: "reset" });
    expect(controller.getSnapshot().historyDone).toBeFalse();
    table.launch!.readGate = gate;
    const loading = controller.loadMore();
    expect(controller.getSnapshot().loading).toBeTrue();
    const stale = log.readSignals.at(-1)!;
    expect(stale.query).toBe("launch");

    await controller.replaceQuery({ kind: "apply", expression: "q" });
    expect(stale.signal?.aborted).toBeTrue();
    release();
    expect(await loading).toBeFalse();
    expect(subjects(controller)).toEqual(["n1"]);
    expect(controller.getSnapshot()).toMatchObject({ loading: false, historyDone: true });
    await controller.close();
  });

  test("cancels an in-flight navigation: focus lands where the replacement put it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { controller, table } = await loadedController({
      queries: {
        q: { entries: [{ revisionId: "n1" }, { revisionId: "l1" }, { revisionId: "n3" }] },
      },
    });
    table.launch!.pageSize = 2;
    await controller.replaceQuery({ kind: "reset" });
    table.launch!.readGate = gate;
    expect(subjects(controller)).toEqual(["l1", "l2"]);
    const moving = controller.select(2, 10);
    expect(controller.isNavigating()).toBeTrue();
    await controller.replaceQuery({ kind: "apply", expression: "q" });
    release();
    await moving;
    expect(controller.isNavigating()).toBeFalse();
    // `l1` was focused and sits second in the new rows; the navigation to row 3 never ran.
    expect(controller.getSnapshot().selected).toBe(1);
    expect(subjects(controller)).toEqual(["n1", "l1", "n3"]);
    await controller.close();
  });

  test("kept focus keeps its screen offset and its scroll inside a tall entry", async () => {
    const launch: TestEntry[] = ["a", "b", "c", "d", "e", "f"].map((revisionId) =>
      revisionId === "e" ? { revisionId, cutoffs: ["p1", "p2", "p3", "p4", "p5"] } : { revisionId },
    );
    const { controller, table } = await loadedController();
    table.launch!.entries = launch;
    await controller.replaceQuery({ kind: "reset" });
    controller.clampViewport(4);
    await controller.select(4, 4);
    expect(controller.scrollEntry(2, 4)).toBeTrue();
    const before = controller.getSnapshot();
    expect(before.selected).toBe(4);
    expect(before.entryScroll).toBe(2);

    // One new row sits above the same revisions: focus moves down one, the view follows.
    table.q = { entries: [{ revisionId: "z" }, ...launch] };
    await controller.replaceQuery({ kind: "apply", expression: "q" });
    const after = controller.getSnapshot();
    expect(after.selected).toBe(5);
    expect(after.rows[5]?.commit.revisionId).toBe("e");
    expect(after.top).toBe(before.top + 1);
    expect(after.entryScroll).toBe(2);
    await controller.close();
  });

  test("an entry scroll resets when focus is not kept", async () => {
    const launch: TestEntry[] = ["a", "b", "c", "d", "e", "f"].map((revisionId) =>
      revisionId === "e" ? { revisionId, cutoffs: ["p1", "p2", "p3", "p4", "p5"] } : { revisionId },
    );
    const { controller, table } = await loadedController();
    table.launch!.entries = launch;
    await controller.replaceQuery({ kind: "reset" });
    controller.clampViewport(4);
    await controller.select(4, 4);
    expect(controller.scrollEntry(2, 4)).toBeTrue();
    expect(controller.getSnapshot().entryScroll).toBe(2);

    // The focused revision is not in the new rows, so the newest row is selected from the top.
    table.q = {
      entries: [{ revisionId: "z", cutoffs: ["p1", "p2", "p3", "p4", "p5"] }, { revisionId: "y" }],
    };
    await controller.replaceQuery({ kind: "apply", expression: "q" });
    expect(controller.getSnapshot()).toMatchObject({ selected: 0, entryScroll: 0, top: 0 });
    await controller.close();
  });

  test("quit during a pending read discards the candidate exactly once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { controller, log } = await loadedController({
      queries: { slow: { entries: [{ revisionId: "s1" }], readGate: gate } },
    });
    const pending = controller.replaceQuery({ kind: "apply", expression: "slow" });
    await Promise.resolve();
    await Promise.resolve();
    const closing = controller.close();
    release();
    expect(await pending).toEqual({ status: "obsolete" });
    await closing;
    expect(log.accepted).toEqual([]);
    expect(log.closed.filter((entry) => entry.startsWith("slow"))).toEqual(["slow#2"]);
  });

  test("an already-aborted signal returns aborted without opening anything", async () => {
    const { controller, log } = await loadedController({
      queries: { q: { entries: [{ revisionId: "n1" }] } },
    });
    const abort = new AbortController();
    abort.abort();
    expect(await controller.replaceQuery({ kind: "apply", expression: "q" }, abort.signal)).toEqual(
      {
        status: "aborted",
      },
    );
    expect(log.opened).toEqual([]);
    await controller.close();
  });

  test("a throw after the view is published still reports the Apply as applied", async () => {
    const { controller, log } = await loadedController({
      queries: { q: { entries: [{ revisionId: "n1" }] } },
    });
    controller.subscribe(() => {
      throw new Error("a subscriber failed");
    });
    const result = await controller.replaceQuery({ kind: "apply", expression: "q" });
    expect(result).toEqual({ status: "applied", mode: "custom", expression: "q" });
    expect(subjects(controller)).toEqual(["n1"]);
    expect(log.accepted).toEqual(["q"]);
    await controller.close();
  });
});

describe("a refresh racing a query replacement", () => {
  const STALE = "History session changed while refreshing.";

  /** Make the refresh path fail the way the real bootstrap does once its source has changed. */
  function failReopenAfter(runtime: { reopenSource: (signal?: AbortSignal) => Promise<unknown> }) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.reopenSource = async () => {
      await gate;
      throw new Error(STALE);
    };
    return release;
  }

  test("a refresh inside reopenSource when an Apply publishes leaves the applied view clean", async () => {
    const { controller, runtime } = await loadedController({
      queries: { q: { entries: [{ revisionId: "n1" }, { revisionId: "n2" }] } },
    });
    controller.toggleMark(0);
    await controller.select(2, 10);
    const release = failReopenAfter(runtime);

    const refreshing = controller.refresh();
    expect(controller.getSnapshot().markStatus).toBe("checking");
    await controller.replaceQuery({ kind: "apply", expression: "q" });
    expect(controller.getSnapshot().notice).toBe("Selected newest; previous not loaded.");
    release();
    expect(await refreshing).toBeFalse();

    const after = controller.getSnapshot();
    expect(after.markStatus).toBe("ready");
    expect(after.notice).toBe("Selected newest; previous not loaded.");
    expect(after.marks).toHaveLength(1);
    // Marking still works straight after: nothing is stuck in a failed or checking state.
    expect(controller.toggleMark(0)).toBeTrue();
    expect(controller.getSnapshot().marks).toHaveLength(2);
    await controller.close();
  });

  test("an Apply that starts while a refresh is pending and publishes first drops the refresh's later failure", async () => {
    const { controller, runtime, table } = await loadedController({
      queries: { q: { entries: [{ revisionId: "n1" }, { revisionId: "n2" }] } },
    });
    controller.toggleMark(0);
    await controller.select(2, 10);
    const releaseRefresh = failReopenAfter(runtime);
    let releaseApply!: () => void;
    table.q!.gate = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });

    const refreshing = controller.refresh();
    const applying = controller.replaceQuery({ kind: "apply", expression: "q" });
    releaseApply();
    expect((await applying).status).toBe("applied");
    // The refresh fails only after the Apply published; that failure must not land on the new view.
    releaseRefresh();
    expect(await refreshing).toBeFalse();

    const after = controller.getSnapshot();
    expect(after.markStatus).toBe("ready");
    expect(after.notice).toBe("Selected newest; previous not loaded.");
    expect(controller.toggleMark(0)).toBeTrue();
    await controller.close();
  });

  test("a refresh that starts while an Apply is pending, and fails after it published, is dropped", async () => {
    const { controller, runtime, table } = await loadedController({
      queries: { q: { entries: [{ revisionId: "n1" }, { revisionId: "n2" }] } },
    });
    controller.toggleMark(0);
    await controller.select(2, 10);
    let releaseApply!: () => void;
    table.q!.gate = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });

    const applying = controller.replaceQuery({ kind: "apply", expression: "q" });
    const releaseRefresh = failReopenAfter(runtime);
    const refreshing = controller.refresh();
    releaseApply();
    expect((await applying).status).toBe("applied");
    releaseRefresh();
    expect(await refreshing).toBeFalse();

    const after = controller.getSnapshot();
    expect(after.markStatus).toBe("ready");
    expect(after.notice).toBe("Selected newest; previous not loaded.");
    expect(controller.toggleMark(0)).toBeTrue();
    await controller.close();
  });

  test("an Apply that lands during a refresh frees the next refresh to start and publish", async () => {
    const { controller, runtime, log } = await loadedController({
      queries: { q: { entries: [{ revisionId: "n1" }] } },
    });
    // The first refresh never finishes on its own.
    let releaseStuck!: () => void;
    const stuck = new Promise<void>((resolve) => {
      releaseStuck = resolve;
    });
    const reopen = runtime.reopenSource.bind(runtime);
    let calls = 0;
    let firstSignal: AbortSignal | undefined;
    runtime.reopenSource = async (signal) => {
      calls += 1;
      if (calls === 1) {
        firstSignal = signal;
        await stuck;
        throw new Error("History session changed while refreshing.");
      }
      return reopen(signal);
    };
    const firstRefresh = controller.refresh();
    await controller.replaceQuery({ kind: "apply", expression: "q" });
    // The superseded refresh was told to stop; the abort is how it learns its work is moot.
    expect(firstSignal?.aborted).toBeTrue();
    // Without clearing the pending refresh this call would join it and reopen nothing.
    const secondRefresh = controller.refresh();
    expect(await secondRefresh).toBeTrue();
    expect(calls).toBe(2);
    expect(log.opened.at(-1)).toBe("q");
    expect(controller.getSnapshot().notice).toBe("History refreshed.");
    releaseStuck();
    expect(await firstRefresh).toBeFalse();
    // The newer refresh had already finished here. The overlapping case, where the aborted
    // refresh winds down while the newer one is still checking, has its own test below.
    expect(controller.getSnapshot().notice).toBe("History refreshed.");
    expect(controller.getSnapshot().markStatus).toBe("ready");
    await controller.close();
  });

  test("a superseded refresh winding down does not overwrite the freed refresh's checking status", async () => {
    const { controller, runtime } = await loadedController({
      queries: {
        q: { entries: [{ revisionId: "l1", logicalId: "change-l1" }, { revisionId: "n1" }] },
      },
    });
    // l1 stays in the applied view, so one resolved mark exists throughout.
    controller.toggleMark(0);
    let releaseStuck!: () => void;
    const stuck = new Promise<void>((resolve) => {
      releaseStuck = resolve;
    });
    let releaseSecond!: () => void;
    const second = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const reopen = runtime.reopenSource.bind(runtime);
    let calls = 0;
    runtime.reopenSource = async (signal) => {
      calls += 1;
      if (calls === 1) {
        await stuck;
        throw new Error(STALE);
      }
      await second;
      return reopen(signal);
    };

    const firstRefresh = controller.refresh();
    expect((await controller.replaceQuery({ kind: "apply", expression: "q" })).status).toBe(
      "applied",
    );
    expect(controller.getSnapshot().markStatus).toBe("ready");
    // The `r` that the Apply freed starts a refresh that is still reading.
    const secondRefresh = controller.refresh();
    expect(calls).toBe(2);
    expect(controller.getSnapshot().markStatus).toBe("checking");

    // The superseded refresh now winds down; it must publish no mark status of its own.
    const seen: string[] = [];
    controller.subscribe(() => seen.push(controller.getSnapshot().markStatus));
    releaseStuck();
    expect(await firstRefresh).toBeFalse();
    expect(controller.getSnapshot().markStatus).toBe("checking");
    expect(seen).not.toContain("refresh-failed");
    // Marking stays blocked while the second refresh checks, then works.
    expect(controller.toggleMark(1)).toBeFalse();

    releaseSecond();
    expect(await secondRefresh).toBeTrue();
    expect(controller.getSnapshot().markStatus).toBe("ready");
    expect(controller.toggleMark(1)).toBeTrue();
    await controller.close();
  });

  test("a refresh that fails with no replacement in between still reports the failure", async () => {
    const { controller, runtime } = await loadedController();
    controller.toggleMark(0);
    const release = failReopenAfter(runtime);
    const refreshing = controller.refresh();
    release();
    expect(await refreshing).toBeFalse();
    expect(controller.getSnapshot().markStatus).toBe("refresh-failed");
    expect(controller.getSnapshot().notice).toBe(STALE);
    await controller.close();
  });

  test("a refresh that was accepted and then throws inside its own publish still reports the failure", async () => {
    const { controller, runtime } = await loadedController();
    controller.toggleMark(0);
    // The listener runs inside the refresh's publish, after the refresh was accepted.
    let first = true;
    controller.subscribe(() => {
      if (controller.getSnapshot().notice === "History refreshed." && first) {
        first = false;
        throw new Error("a subscriber failed");
      }
    });
    void runtime;
    expect(await controller.refresh()).toBeFalse();
    expect(controller.getSnapshot().notice).toBe("a subscriber failed");
    await controller.close();
  });
});

test("applying a query keeps the compact reading row with hidden workspace labels", async () => {
  const entries = Array.from({ length: 20 }, (_, index) => ({
    revisionId: `revision-${index}`,
    decorations: [
      {
        kind: "ref" as const,
        label: `@workspace-with-a-long-recorded-name-${index}`,
        workspaceName: `workspace-${index}`,
      },
    ],
  }));
  const { runtime } = createTestQueryRuntime({
    queries: {
      launch: { entries },
      same: { entries },
    },
  });
  const controller = new LogController(runtime);
  try {
    while (!controller.getSnapshot().historyDone) await controller.loadMore();
    controller.setViewport(70, 13);
    controller.togglePresentation("graph");
    await controller.select(8, 13);
    controller.togglePresentation("workspaceNames");
    const before = controller.planViewport().selectedRowOffset;
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(13);
    expect((await controller.replaceQuery({ kind: "apply", expression: "same" })).status).toBe(
      "applied",
    );
    expect(controller.getSelectedRow()?.commit.revisionId).toBe("revision-8");
    expect(controller.planViewport().selectedRowOffset).toBe(before);
    expect(controller.planViewport().usedHeight).toBeLessThanOrEqual(13);
  } finally {
    await controller.close();
  }
});
