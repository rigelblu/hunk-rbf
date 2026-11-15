import { describe, expect, test } from "bun:test";
import { createTestExtensionSession } from "../../../../../test/helpers/extension-session";
import { persistedViewPreferencesFromOptions } from "../../core/run/config";
import type { HistoryRuntime } from "../history/types";
import { LogController } from "./controller";
import type { HistoryCommit } from "../../core/history/types";
import { RevisionSourceSelection } from "./revisionSourceSelection";
import { isHistoryCommandEnabled } from "./commands";
import { planLogViewportGeometry } from "./geometry";

type TestHistoryEntry =
  | string
  | {
      revisionId: string;
      subject?: string;
      logicalId?: string;
      authoredAt?: string;
      decorations?: HistoryCommit["decorations"];
    };

function createTestRuntime(
  subjects: TestHistoryEntry[] = ["first", "second", "third"],
  notices: readonly string[] = [],
) {
  let historyEntries = subjects;
  let closeCount = 0;
  const makeSource = () => {
    const entries = [...historyEntries];
    let cursor = 0;
    return {
      async read({ limit }: { limit: number; signal?: AbortSignal }) {
        const selected = entries.slice(cursor, cursor + Math.min(limit, 2));
        cursor += selected.length;
        return {
          commits: selected.map((entry) => {
            const commit =
              typeof entry === "string"
                ? {
                    revisionId: entry,
                    subject: entry,
                    authoredAt: undefined,
                    decorations: undefined,
                  }
                : entry;
            return {
              revisionId: commit.revisionId,
              displayId: commit.revisionId.slice(0, 8),
              parentRevisionIds: [],
              subject: commit.subject ?? commit.revisionId,
              ...(commit.logicalId ? { logicalId: commit.logicalId } : {}),
              authorName: "Ada",
              authoredAt: commit.authoredAt ?? "2026-01-01T00:00:00Z",
              decorations: commit.decorations ?? [],
            };
          }),
          done: cursor >= entries.length,
        };
      },
      async close() {},
    };
  };
  let source: HistoryRuntime["source"] = makeSource();
  const runtime: HistoryRuntime = {
    input: {
      kind: "history",
      color: "never",
      format: "compact",
      ascii: false,
      static: false,
      extensionsEnabled: false,
      extensionPaths: [],
    },
    source,
    extensionSession: createTestExtensionSession(),
    providerId: "test",
    providerName: "Test",
    repoRoot: "/repo",
    notices,
    customThemes: [],
    keybindings: {},
    initialViewPreferences: persistedViewPreferencesFromOptions({}),
    promptSaveViewPreferences: true,
    async planReview(commit) {
      return { kind: "revision-show", revisionId: commit.revisionId };
    },
    async reopenSource() {
      return makeSource();
    },
    async acceptSource(nextSource) {
      source = nextSource;
      runtime.source = nextSource;
    },
    async close() {
      closeCount += 1;
    },
  };
  return {
    runtime,
    closeCount: () => closeCount,
    setHistory(entries: TestHistoryEntry[]) {
      historyEntries = entries;
    },
  };
}

describe("LogController", () => {
  test("preserves bootstrap notices when keymap diagnostics arrive after mount", async () => {
    const { runtime } = createTestRuntime(undefined, [
      "Configured VCS is unavailable.",
      "Extension registration was skipped.",
    ]);
    const controller = new LogController(runtime);

    controller.addStartupNotices(["Unknown history command."]);
    controller.addStartupNotices(["Unknown history command."]);

    expect(controller.getSnapshot().notice).toBe(
      "Configured VCS is unavailable. • Extension registration was skipped. • Unknown history command.",
    );
    await controller.close();
  });

  test("loads bounded pages and retains navigation/search state", async () => {
    const { runtime } = createTestRuntime();
    const controller = new LogController(runtime);
    expect(controller.getSnapshot().presentation.graph).toBe(false);
    await controller.loadMore();
    expect(controller.getSnapshot().rows.map((row) => row.commit.subject)).toEqual([
      "first",
      "second",
    ]);
    controller.move(1, 1);
    expect(controller.getSnapshot().selected).toBe(1);
    await controller.search("third");
    expect(controller.getSnapshot().search).toBe("third");
    expect(controller.getSnapshot().rows).toHaveLength(3);
    expect(controller.getSnapshot().selected).toBe(2);
    // The query stays repeatable after the prompt closes.
    await controller.findMatch(1);
    expect(controller.getSnapshot().selected).toBe(2);
    expect(controller.getSnapshot().notice).toBe("");
    await controller.close();
  });

  test("forces ASCII graph presentation for TERM=dumb", async () => {
    const previous = process.env.TERM;
    process.env.TERM = "dumb";
    try {
      const { runtime } = createTestRuntime();
      const controller = new LogController(runtime);
      expect(controller.getSnapshot().presentation.unicode).toBe(false);
      await controller.close();
    } finally {
      if (previous === undefined) delete process.env.TERM;
      else process.env.TERM = previous;
    }
  });

  test("loads enough bounded pages for responsive navigation", async () => {
    const { runtime } = createTestRuntime(["one", "two", "three", "four", "five"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    await controller.page(1, 16);
    expect(controller.getSnapshot().selected).toBe(2);
    await controller.page(1, 16);
    expect(controller.getSnapshot().selected).toBe(4);
    expect(controller.getSnapshot().historyDone).toBe(true);
    await controller.close();
  });

  test("moves by half of the visible commit rows", async () => {
    const { runtime } = createTestRuntime(["one", "two", "three", "four", "five"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    await controller.loadMore();
    await controller.halfPage(1, 10);
    expect(controller.getSnapshot().selected).toBe(2);
    await controller.halfPage(1, 10);
    expect(controller.getSnapshot().selected).toBe(4);
    await controller.halfPage(-1, 10);
    expect(controller.getSnapshot().selected).toBe(2);
    await controller.close();
  });

  test("moves the selection on every page and wheel step when the body is shorter than one entry", async () => {
    for (const bodyHeight of [1, 2]) {
      const { runtime } = createTestRuntime(["one", "two", "three", "four", "five"]);
      const controller = new LogController(runtime);
      await controller.loadMore();
      await controller.loadMore();
      controller.clampViewport(bodyHeight);
      await controller.page(1, bodyHeight);
      expect(controller.getSnapshot().selected).toBe(1);
      await controller.page(1, bodyHeight);
      expect(controller.getSnapshot().selected).toBe(2);
      await controller.halfPage(1, bodyHeight);
      expect(controller.getSnapshot().selected).toBe(3);
      await controller.page(-1, bodyHeight);
      expect(controller.getSnapshot().selected).toBe(2);
      // The wheel moves the selection whenever the entry declines the scroll.
      expect(controller.scrollEntry(3, bodyHeight)).toBe(false);
      expect(controller.scrollEntry(-3, bodyHeight)).toBe(false);
      expect(controller.getSnapshot().entryScroll).toBe(0);
      await controller.close();
    }
  });

  test("preserves rapid navigation targets while bounded continuation is loading", async () => {
    const { runtime } = createTestRuntime(["one", "two", "three", "four"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    await Promise.all([controller.move(1, 1), controller.move(1, 1), controller.move(1, 1)]);
    expect(controller.getSnapshot().selected).toBe(3);
    await controller.close();
  });

  test("extends, shrinks, reverses, and collapses an inclusive range", async () => {
    const { runtime } = createTestRuntime(["one", "two", "three", "four"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    await controller.move(1, 1);
    await Promise.all([
      controller.move(1, 1, { extend: true }),
      controller.move(1, 1, { extend: true }),
    ]);
    expect(controller.getSelection()).toMatchObject({
      newestIndex: 1,
      oldestIndex: 3,
      count: 3,
    });
    await controller.move(-2, 1, { extend: true });
    expect(controller.getSelection()?.count).toBe(1);
    await controller.move(-1, 1, { extend: true });
    expect(controller.getSelection()).toMatchObject({ newestIndex: 0, oldestIndex: 1, count: 2 });
    expect(controller.getSelection()?.focus.commit.revisionId).toBe("one");
    await controller.move(1, 1);
    expect(controller.getSnapshot().selectionAnchor).toBeNull();
    expect(controller.getSelection()?.count).toBe(1);
    await controller.close();
  });

  test("keeps visual selection active while plain movement extends and reverses a range", async () => {
    const { runtime } = createTestRuntime(["one", "two", "three", "four"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    await controller.move(1, 1);

    controller.beginVisualSelection();
    expect(controller.getSnapshot()).toMatchObject({
      selected: 1,
      selectionAnchor: 1,
      visualSelectionActive: true,
    });
    await controller.move(2, 1, { extend: controller.getSnapshot().visualSelectionActive });
    expect(controller.getSelection()).toMatchObject({ newestIndex: 1, oldestIndex: 3, count: 3 });
    await controller.move(-2, 1, { extend: controller.getSnapshot().visualSelectionActive });
    expect(controller.getSnapshot()).toMatchObject({
      selected: 1,
      selectionAnchor: 1,
      visualSelectionActive: true,
    });
    await controller.move(-1, 1, { extend: controller.getSnapshot().visualSelectionActive });
    expect(controller.getSelection()).toMatchObject({ newestIndex: 0, oldestIndex: 1, count: 2 });
    expect(controller.clearSelection()).toBeTrue();
    expect(controller.getSnapshot()).toMatchObject({
      selected: 0,
      selectionAnchor: null,
      visualSelectionActive: false,
    });
    await controller.close();
  });

  test("rejects ranges when traversal options can hide or interleave commits", async () => {
    for (const input of [{ grep: "matching" }, { all: true }]) {
      const { runtime } = createTestRuntime(["one", "two", "three"]);
      runtime.input = { ...runtime.input, ...input };
      const controller = new LogController(runtime);
      await controller.loadMore();
      controller.beginVisualSelection();
      await controller.move(1, 1, { extend: true });

      expect(controller.getSnapshot().visualSelectionActive).toBeFalse();
      expect(controller.getSelection()?.count).toBe(1);
      expect(controller.getSnapshot().notice).toBe(
        "Multi-commit selection is unavailable when history traversal can hide or interleave commits.",
      );
      await controller.close();
    }
  });

  test("Escape-style clearing wins over a deferred visual selection move", async () => {
    const { runtime } = createTestRuntime(["one", "two", "three"]);
    const originalRead = runtime.source.read.bind(runtime.source);
    let readCount = 0;
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.source.read = async (options) => {
      readCount += 1;
      if (readCount === 2) await deferred;
      return originalRead(options);
    };
    const controller = new LogController(runtime);
    await controller.loadMore();
    await controller.select(1, 1);
    controller.beginVisualSelection();
    const pendingMove = controller.move(1, 1, { extend: true });

    expect(controller.clearSelection()).toBeTrue();
    release();
    await pendingMove;

    expect(controller.getSnapshot()).toMatchObject({
      selected: 1,
      selectionAnchor: null,
      visualSelectionActive: false,
    });
    await controller.close();
  });

  test("settles deferred navigation and prevents stale selection overwrite", async () => {
    const { runtime } = createTestRuntime(["one", "two", "three"]);
    const originalRead = runtime.source.read.bind(runtime.source);
    let readCount = 0;
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.source.read = async (options) => {
      readCount += 1;
      if (readCount === 2) await deferred;
      return originalRead(options);
    };
    const controller = new LogController(runtime);
    await controller.loadMore();
    const staleExtension = controller.move(2, 1, { extend: true });
    const latestSelection = controller.select(0, 1);
    release();
    await Promise.all([staleExtension, latestSelection, controller.settleNavigation()]);
    expect(controller.getSnapshot()).toMatchObject({ selected: 0, selectionAnchor: null });
    await controller.close();
  });

  test("refresh reconciles both range endpoints by immutable revision id", async () => {
    const { runtime } = createTestRuntime(["one", "two", "three", "four"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    await controller.move(2, 2, { extend: true });
    expect(controller.getSelection()?.count).toBe(3);
    await controller.refresh();
    expect(controller.getSelection()?.newest.commit.revisionId).toBe("one");
    expect(controller.getSelection()?.oldest.commit.revisionId).toBe("three");
    expect(controller.getSelection()?.count).toBe(3);
    await controller.close();
  });

  test("refresh restores a rewritten revision through its unique logical id", async () => {
    const { runtime, setHistory } = createTestRuntime([
      { revisionId: "old-head", logicalId: "head", subject: "head" },
      { revisionId: "old-selected", logicalId: "change", subject: "selected" },
    ]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    await controller.select(1, 5);

    setHistory([
      { revisionId: "new-head", logicalId: "head", subject: "head" },
      { revisionId: "new-selected", logicalId: "change", subject: "selected" },
    ]);
    await controller.refresh();

    expect(
      controller.getSnapshot().rows[controller.getSnapshot().selected]?.commit.revisionId,
    ).toBe("new-selected");
    expect(controller.getSnapshot().notice).toBe("History refreshed.");
    await controller.close();
  });

  test("refresh announces fallback to a surviving range anchor", async () => {
    const { runtime, setHistory } = createTestRuntime([
      { revisionId: "anchor", logicalId: "anchor", subject: "anchor" },
      { revisionId: "selected", logicalId: "selected", subject: "selected" },
    ]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    await controller.select(0, 5);
    controller.beginVisualSelection();
    await controller.move(1, 5, { extend: true });

    setHistory([{ revisionId: "anchor-rewritten", logicalId: "anchor", subject: "anchor" }]);
    await controller.refresh();

    expect(
      controller.getSnapshot().rows[controller.getSnapshot().selected]?.commit.revisionId,
    ).toBe("anchor-rewritten");
    expect(controller.getSnapshot()).toMatchObject({
      selectionAnchor: null,
      visualSelectionActive: false,
      notice: "Couldn’t uniquely identify selected change; moved to range anchor.",
    });
    await controller.close();
  });

  test("refresh refuses an ambiguous logical id and announces newest-row fallback", async () => {
    const { runtime, setHistory } = createTestRuntime([
      { revisionId: "old-head", logicalId: "head", subject: "head" },
      { revisionId: "old-selected", logicalId: "change", subject: "selected" },
    ]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    await controller.select(1, 5);

    setHistory([
      { revisionId: "new-head", logicalId: "head", subject: "head" },
      { revisionId: "split-a", logicalId: "change", subject: "split a" },
      { revisionId: "middle", logicalId: "middle", subject: "middle" },
      { revisionId: "split-b", logicalId: "change", subject: "split b" },
    ]);
    await controller.refresh();

    expect(
      controller.getSnapshot().rows[controller.getSnapshot().selected]?.commit.revisionId,
    ).toBe("new-head");
    expect(controller.getSnapshot().notice).toBe(
      "Couldn’t uniquely identify selected change; moved to newest change.",
    );
    await controller.close();
  });

  test("entering visual selection during refresh preserves the new mode", async () => {
    const { runtime } = createTestRuntime(["one", "two", "three"]);
    const reopenSource = runtime.reopenSource.bind(runtime);
    let release!: () => void;
    let markStarted!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    runtime.reopenSource = async (signal) => {
      markStarted();
      await deferred;
      return reopenSource(signal);
    };
    const controller = new LogController(runtime);
    await controller.loadMore();
    await controller.move(1, 2);

    const refresh = controller.refresh();
    await started;
    controller.beginVisualSelection();
    release();
    await refresh;

    expect(controller.getSnapshot()).toMatchObject({
      selected: 1,
      selectionAnchor: 1,
      visualSelectionActive: true,
    });
    await controller.close();
  });

  test("a refresh after a mutation reads again when a refresh was already in flight", async () => {
    const { runtime } = createTestRuntime(["one", "two", "three"]);
    const reopenSource = runtime.reopenSource.bind(runtime);
    let reads = 0;
    let release!: () => void;
    let markStarted!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    runtime.reopenSource = async (signal) => {
      reads += 1;
      markStarted();
      if (reads === 1) await deferred;
      return reopenSource(signal);
    };
    const controller = new LogController(runtime);
    await controller.loadMore();

    const inFlight = controller.refresh();
    await started;
    // A plain refresh joins the read in flight; the mutation's refresh must begin a new one.
    const joined = controller.refresh();
    const afterMutation = controller.refreshAfterMutation();
    release();
    await Promise.all([inFlight, joined, afterMutation]);

    expect(reads).toBe(2);
    await controller.close();
  });

  test("entering visual selection while refreshed rows load preserves the new mode", async () => {
    const { runtime } = createTestRuntime(["one", "two", "three"]);
    const reopenSource = runtime.reopenSource.bind(runtime);
    let release!: () => void;
    let markStarted!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    runtime.reopenSource = async (signal) => {
      const replacement = await reopenSource(signal);
      return {
        async read(options) {
          markStarted();
          await deferred;
          return replacement.read(options);
        },
        close: () => replacement.close(),
      };
    };
    const controller = new LogController(runtime);
    await controller.loadMore();
    await controller.move(1, 2);

    const refresh = controller.refresh();
    await started;
    expect(controller.getSnapshot().rows).toHaveLength(3);
    controller.beginVisualSelection();
    release();
    await refresh;

    expect(controller.getSnapshot()).toMatchObject({
      selected: 1,
      selectionAnchor: 1,
      visualSelectionActive: true,
    });
    await controller.close();
  });

  test("visual selection entered during refresh clears when history becomes empty", async () => {
    const { runtime } = createTestRuntime(["one"]);
    let release!: () => void;
    let markStarted!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    runtime.reopenSource = async () => ({
      async read() {
        markStarted();
        await deferred;
        return { commits: [], done: true };
      },
      async close() {},
    });
    const controller = new LogController(runtime);
    await controller.loadMore();

    const refresh = controller.refresh();
    await started;
    controller.beginVisualSelection();
    release();
    await refresh;

    expect(controller.getSnapshot()).toMatchObject({
      rows: [],
      selected: 0,
      selectionAnchor: null,
      visualSelectionActive: false,
    });
    await controller.close();
  });

  test("clearing visual selection during refresh prevents range restoration", async () => {
    const { runtime } = createTestRuntime(["one", "two", "three"]);
    const reopenSource = runtime.reopenSource.bind(runtime);
    let release!: () => void;
    let markStarted!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    runtime.reopenSource = async (signal) => {
      markStarted();
      await deferred;
      return reopenSource(signal);
    };
    const controller = new LogController(runtime);
    await controller.loadMore();
    controller.beginVisualSelection();
    await controller.move(1, 2, { extend: true });

    const refresh = controller.refresh();
    await started;
    expect(controller.clearSelection()).toBeTrue();
    release();
    await refresh;

    expect(controller.getSnapshot()).toMatchObject({
      selected: 1,
      selectionAnchor: null,
      visualSelectionActive: false,
    });
    await controller.close();
  });

  test("search reveals its match and refresh preserves immutable selection viewport offset", async () => {
    const { runtime } = createTestRuntime(["one", "two", "three", "four"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    await controller.select(2, 6);
    expect(controller.getSnapshot().top).toBe(1);
    controller.setSearch("four");
    await controller.findMatch(1, 6);
    expect(controller.getSnapshot()).toMatchObject({ selected: 3, top: 2 });
    await controller.refresh();
    expect(
      controller.getSnapshot().rows[controller.getSnapshot().selected]?.commit.revisionId,
    ).toBe("four");
    expect(controller.getSnapshot().selected - controller.getSnapshot().top).toBe(1);
    await controller.close();
  });

  test("refresh preserves the selected terminal row when rewritten day groups change", async () => {
    const entries = Array.from({ length: 50 }, (_, index) => ({
      revisionId: `revision-${index}`,
      logicalId: `logical-${index}`,
      authoredAt: new Date(2026, 8, 20, 12).toISOString(),
    }));
    const { runtime, setHistory } = createTestRuntime(entries);
    const controller = new LogController(runtime);
    while (!controller.getSnapshot().historyDone) await controller.loadMore();
    await controller.select(8, 23);
    controller.clampViewport(40);
    const measure = () => {
      const snapshot = controller.getSnapshot();
      return planLogViewportGeometry({
        rows: snapshot.rows,
        selected: snapshot.selected,
        requestedTop: snapshot.top,
        bodyHeight: 40,
        groupByDay: true,
      }).selectedRowOffset;
    };
    const before = measure();
    setHistory(
      entries.map((entry, index) => ({
        ...entry,
        revisionId: `rewritten-${index}`,
        authoredAt: new Date(
          2026,
          8,
          index < 3 ? 20 : index < 7 ? index + 18 : 25,
          12,
        ).toISOString(),
      })),
    );
    expect(await controller.refresh()).toBeTrue();
    expect(controller.getSelectedRow()?.commit.revisionId).toBe("rewritten-8");
    expect(measure()).toBe(20);
    expect(Math.abs(measure()! - before!)).toBe(2);
    expect(before).toBe(18);
    expect(controller.getSnapshot().notice).toBe("History refreshed.");
    await controller.close();
  });

  test("closes a replacement cursor when quit wins a refresh race", async () => {
    let resolveReplacement!: (source: HistoryRuntime["source"]) => void;
    let replacementCloseCount = 0;
    let reopenSignal: AbortSignal | undefined;
    const { runtime } = createTestRuntime(["one"]);
    runtime.reopenSource = (signal) => {
      reopenSignal = signal;
      return new Promise((resolve) => {
        resolveReplacement = resolve;
      });
    };
    const controller = new LogController(runtime);
    await controller.loadMore();
    const refresh = controller.refresh();
    await Promise.resolve();
    const close = controller.close();
    resolveReplacement({
      async read() {
        return { commits: [], done: true };
      },
      async close() {
        replacementCloseCount += 1;
      },
    });
    await Promise.all([refresh, close]);
    expect(reopenSignal?.aborted).toBe(true);
    expect(replacementCloseCount).toBe(1);
  });

  test("closing while replacement rows load settles the pending refresh", async () => {
    const { runtime } = createTestRuntime(["one", "two"]);
    const reopenSource = runtime.reopenSource.bind(runtime);
    let release!: () => void;
    let markStarted!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    runtime.reopenSource = async (signal) => {
      const replacement = await reopenSource(signal);
      return {
        async read(options) {
          markStarted();
          await deferred;
          return replacement.read(options);
        },
        close: () => replacement.close(),
      };
    };
    const controller = new LogController(runtime);
    await controller.loadMore();

    const refresh = controller.refresh();
    await started;
    const close = controller.close();
    release();
    await Promise.all([refresh, close]);
  });

  test("refreshes through the provider-owned cursor factory and closes once", async () => {
    const { runtime, closeCount } = createTestRuntime(["first"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    await controller.refresh();
    expect(controller.getSnapshot().rows).toHaveLength(1);
    await controller.close();
    await controller.close();
    expect(closeCount()).toBe(1);
  });

  test("stages deep selection pages before publishing the replacement", async () => {
    const entries = ["one", "two", "three", "four", "five"];
    const { runtime, setHistory } = createTestRuntime(entries);
    const controller = new LogController(runtime);
    await controller.loadMore();
    await controller.loadMore();
    await controller.loadMore();
    await controller.select(4, 3);
    const originalRows = controller.getSnapshot().rows;
    setHistory(["new-head", "new-two", "new-three", "new-four", "five"]);

    const reopenSource = runtime.reopenSource.bind(runtime);
    let release!: () => void;
    let markSecondRead!: () => void;
    const secondReadStarted = new Promise<void>((resolve) => {
      markSecondRead = resolve;
    });
    const secondReadGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.reopenSource = async (signal) => {
      const source = await reopenSource(signal);
      let reads = 0;
      return {
        async read(options) {
          reads += 1;
          if (reads === 2) {
            markSecondRead();
            await secondReadGate;
          }
          return source.read(options);
        },
        close: () => source.close(),
      };
    };

    const refreshing = controller.refresh();
    await secondReadStarted;
    expect(controller.getSnapshot().rows).toEqual(originalRows);
    release();
    expect(await refreshing).toBeTrue();
    expect(controller.getSnapshot().rows.map((row) => row.commit.revisionId)).toEqual([
      "new-head",
      "new-two",
      "new-three",
      "new-four",
      "five",
    ]);
    expect(
      controller.getSnapshot().rows[controller.getSnapshot().selected]?.commit.revisionId,
    ).toBe("five");
    await controller.close();
  });

  test("defers when an interaction starts during deep selection staging", async () => {
    const { runtime } = createTestRuntime(["one", "two", "three", "four", "five"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    await controller.loadMore();
    await controller.loadMore();
    await controller.select(4, 3);
    const originalRows = controller.getSnapshot().rows;
    const originalSource = runtime.source;
    const reopenSource = runtime.reopenSource.bind(runtime);
    let release!: () => void;
    let markSecondRead!: () => void;
    const secondReadStarted = new Promise<void>((resolve) => {
      markSecondRead = resolve;
    });
    const secondReadGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.reopenSource = async (signal) => {
      const source = await reopenSource(signal);
      let reads = 0;
      return {
        async read(options) {
          reads += 1;
          if (reads === 2) {
            markSecondRead();
            await secondReadGate;
          }
          return source.read(options);
        },
        close: () => source.close(),
      };
    };
    let interactionActive = false;

    const refreshing = controller.refresh(() => !interactionActive);
    await secondReadStarted;
    interactionActive = true;
    release();

    expect(await refreshing).toBeFalse();
    expect(controller.getSnapshot().rows).toEqual(originalRows);
    expect(runtime.source).toBe(originalSource);
    await controller.close();
  });

  test("keeps the previous source and rows when a later staged page fails", async () => {
    const { runtime } = createTestRuntime(["one", "two", "three", "four", "five"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    await controller.loadMore();
    await controller.loadMore();
    await controller.select(4, 3);
    const originalRows = controller.getSnapshot().rows;
    const originalSource = runtime.source;
    const reopenSource = runtime.reopenSource.bind(runtime);
    runtime.reopenSource = async (signal) => {
      const source = await reopenSource(signal);
      let reads = 0;
      return {
        async read(options) {
          reads += 1;
          if (reads === 2) throw new Error("second replacement page failed");
          return source.read(options);
        },
        close: () => source.close(),
      };
    };

    expect(await controller.refresh()).toBeFalse();
    expect(controller.getSnapshot().rows).toEqual(originalRows);
    expect(controller.getSnapshot().notice).toBe("second replacement page failed");
    expect(runtime.source).toBe(originalSource);
    await controller.close();
  });

  test("clears a canceled page indicator when replacement refresh fails", async () => {
    const { runtime } = createTestRuntime(["one", "two", "three", "four"]);
    const originalSource = runtime.source;
    let release!: () => void;
    let markStarted!: () => void;
    let reads = 0;
    const readStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const readGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.source = {
      async read(options) {
        reads += 1;
        if (reads === 2) {
          markStarted();
          await readGate;
        }
        return originalSource.read(options);
      },
      close: () => originalSource.close(),
    };
    runtime.reopenSource = async () => {
      throw new Error("replacement unavailable");
    };
    const controller = new LogController(runtime);
    await controller.loadMore();

    const loading = controller.loadMore();
    await readStarted;
    const refreshing = controller.refresh();
    release();
    await Promise.all([loading, refreshing]);

    expect(controller.getSnapshot()).toMatchObject({
      loading: false,
      notice: "replacement unavailable",
    });
    await controller.close();
  });

  test("keeps the current rows and source when a replacement page fails", async () => {
    const { runtime } = createTestRuntime(["first", "second"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    const previousSource = controller.getSnapshot().rows;
    runtime.reopenSource = async () => ({
      async read() {
        throw new Error("replacement read failed");
      },
      async close() {},
    });

    expect(await controller.refresh()).toBeFalse();
    expect(controller.getSnapshot().rows).toEqual(previousSource);
    expect(controller.getSnapshot().notice).toBe("replacement read failed");
    await controller.close();
  });

  test("does not apply a replacement when an interaction starts during its read", async () => {
    const { runtime } = createTestRuntime(["first", "second"]);
    const reopenSource = runtime.reopenSource.bind(runtime);
    let release!: () => void;
    let markStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const readGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = new LogController(runtime);
    await controller.loadMore();
    const originalRows = controller.getSnapshot().rows;
    runtime.reopenSource = async (signal) => {
      const replacement = await reopenSource(signal);
      return {
        async read(options) {
          markStarted();
          await readGate;
          return replacement.read(options);
        },
        close: () => replacement.close(),
      };
    };
    let interactionActive = false;
    const refreshing = controller.refresh(() => !interactionActive);
    await readStarted;
    interactionActive = true;
    release();

    expect(await refreshing).toBeFalse();
    expect(controller.getSnapshot().rows).toEqual(originalRows);
    await controller.close();
  });
});

/** Release deterministic source reads without relying on timer ordering. */
function createTestGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Pause one cursor page and expose its started/close ownership to the test. */
function createTestPausedSource(source: HistoryRuntime["source"], pageNumber = 1) {
  const started = createTestGate();
  const gate = createTestGate();
  let reads = 0;
  let closes = 0;
  return {
    source: {
      async read(options: { limit: number; signal?: AbortSignal }) {
        if (++reads === pageNumber) {
          started.release();
          await gate.promise;
        }
        options.signal?.throwIfAborted();
        return source.read(options);
      },
      async close() {
        closes++;
        gate.release();
        await source.close();
      },
    },
    started: started.promise,
    release: gate.release,
    closes: () => closes,
  };
}

describe("refresh source and navigation ownership", () => {
  for (const endpoint of ["focus", "anchor"] as const) {
    test(`finds a late exact ${endpoint} after duplicate logical matches`, async () => {
      const { runtime, setHistory } = createTestRuntime([
        { revisionId: "anchor", logicalId: "A" },
        { revisionId: "focus", logicalId: "F" },
      ]);
      const controller = new LogController(runtime);
      await controller.loadMore();
      if (endpoint === "anchor") await controller.select(1, 1, { extend: true });
      const logicalId = "A";
      setHistory([
        { revisionId: "duplicate-one", logicalId },
        { revisionId: "duplicate-two", logicalId },
        { revisionId: "focus", logicalId: "F" },
        { revisionId: "anchor", logicalId: "A" },
      ]);
      expect(await controller.refresh()).toBeTrue();
      expect(controller.getSelectedRow()?.commit.revisionId).toBe(
        endpoint === "focus" ? "anchor" : "focus",
      );
      if (endpoint === "anchor")
        expect(controller.getSelection()?.oldest.commit.revisionId).toBe("anchor");
      expect(controller.getSnapshot().notice).toBe("History refreshed.");
      await controller.close();
    });
  }

  for (const failure of ["open", "first page", "later page", "guard"] as const) {
    test(`retains consumed and unread active pages after candidate ${failure} failure`, async () => {
      const { runtime } = createTestRuntime(["a", "b", "c", "d", "e", "f"]);
      const active = createTestPausedSource(runtime.source, 2);
      runtime.source = active.source;
      const reopen = runtime.reopenSource.bind(runtime);
      runtime.reopenSource = async (signal) => {
        if (failure === "open") throw new Error("replacement failed");
        const source = await reopen(signal);
        let reads = 0;
        return {
          async read(options) {
            if (++reads === (failure === "first page" ? 1 : 2) && failure !== "guard")
              throw new Error("replacement failed");
            const page = await source.read(options);
            return {
              ...page,
              commits: page.commits.map((c) => ({ ...c, revisionId: "new-" + c.revisionId })),
            };
          },
          close: () => source.close(),
        };
      };
      const controller = new LogController(runtime);
      await controller.loadMore();
      const pending = controller.loadMore();
      await active.started;
      let allowed = true;
      const refreshing = controller.refresh(() => allowed);
      if (failure === "guard") allowed = false;
      expect(await refreshing).toBeFalse();
      expect(active.closes()).toBe(0);
      expect(controller.getSnapshot()).toMatchObject({ loading: true, historyDone: false });
      active.release();
      expect(await pending).toBeTrue();
      await controller.loadMore();
      expect(controller.getSnapshot().rows.map((r) => r.commit.revisionId)).toEqual([
        "a",
        "b",
        "c",
        "d",
        "e",
        "f",
      ]);
      expect(controller.getSnapshot().historyDone).toBeTrue();
      await controller.close();
    });
  }

  for (const action of ["select", "search", "last", "rapid", "clear range"] as const) {
    test(`keeps latest ${action}, viewport and presentation using one staged candidate`, async () => {
      const { runtime, setHistory } = createTestRuntime(["a", "b", "c", "d", "e", "f"]);
      const controller = new LogController(runtime);
      await controller.last(3);
      await controller.select(1, 3);
      setHistory(["new", "a", "b", "c", "d", "e", "f"]);
      const reopen = runtime.reopenSource.bind(runtime);
      let opens = 0;
      let candidate!: ReturnType<typeof createTestPausedSource>;
      runtime.reopenSource = async (signal) => {
        opens++;
        candidate = createTestPausedSource(await reopen(signal));
        return candidate.source;
      };
      const refreshing = controller.refresh();
      const coalesced = controller.refresh();
      await Promise.resolve();
      await candidate.started;
      if (action === "search") await controller.search("f", 1, 3);
      else if (action === "last") await controller.last(3);
      else {
        if (action === "rapid") await controller.select(4, 3);
        if (action === "clear range") controller.beginVisualSelection();
        await controller.select(2, 3, { extend: action === "clear range" });
        if (action === "clear range") controller.clearSelection();
      }
      controller.togglePresentation("graph");
      controller.clampViewport(6);
      const before = controller.getSnapshot();
      const focused = controller.getSelectedRow()?.commit.revisionId;
      candidate.release();
      expect(await refreshing).toBeTrue();
      expect(await coalesced).toBeTrue();
      expect(opens).toBe(1);
      expect(controller.getSelectedRow()?.commit.revisionId).toBe(focused);
      expect(controller.getSnapshot().selected - controller.getSnapshot().top).toBe(
        before.selected - before.top,
      );
      expect(controller.getSnapshot()).toMatchObject({
        selectionAnchor: null,
        visualSelectionActive: false,
        presentation: { graph: true },
      });
      await controller.close();
    });
  }

  test("awaits latest pending row target before accepting candidate pages", async () => {
    const { runtime, setHistory } = createTestRuntime(["a", "b", "c", "d", "e", "f"]);
    const active = createTestPausedSource(runtime.source, 2);
    runtime.source = active.source;
    const controller = new LogController(runtime);
    await controller.loadMore();
    setHistory(["new", "a", "b", "c", "d", "e", "f"]);
    const reopen = runtime.reopenSource.bind(runtime);
    let candidate!: ReturnType<typeof createTestPausedSource>;
    runtime.reopenSource = async (signal) => {
      candidate = createTestPausedSource(await reopen(signal));
      return candidate.source;
    };
    const refreshing = controller.refresh();
    await Promise.resolve();
    await candidate.started;
    const navigation = controller.select(4, 3);
    await active.started;
    candidate.release();
    await Promise.resolve();
    expect(runtime.source).toBe(active.source);
    controller.clampViewport(3);
    active.release();
    await navigation;
    expect(await refreshing).toBeTrue();
    expect(controller.getSelectedRow()?.commit.revisionId).toBe("e");
    expect(controller.getSnapshot().selected).toBe(controller.getSnapshot().top);
    await controller.close();
  });

  test("ignores old read completion without clearing a replacement load", async () => {
    const { runtime, setHistory } = createTestRuntime(["a", "b", "c", "d", "e", "f"]);
    const active = createTestPausedSource(runtime.source, 2);
    runtime.source = active.source;
    const controller = new LogController(runtime);
    await controller.loadMore();
    const oldLoad = controller.loadMore();
    await active.started;
    setHistory(["new", "a", "b", "c", "d"]);
    const reopen = runtime.reopenSource.bind(runtime);
    let candidate!: ReturnType<typeof createTestPausedSource>;
    runtime.reopenSource = async (signal) => {
      candidate = createTestPausedSource(await reopen(signal), 2);
      return candidate.source;
    };
    expect(await controller.refresh()).toBeTrue();
    const newLoad = controller.loadMore();
    await candidate.started;
    active.release();
    expect(await oldLoad).toBeFalse();
    expect(controller.getSnapshot().loading).toBeTrue();
    expect(controller.getSnapshot().rows.map((r) => r.commit.revisionId)).toEqual(["new", "a"]);
    candidate.release();
    expect(await newLoad).toBeTrue();
    expect(controller.getSnapshot().rows.map((r) => r.commit.revisionId)).toEqual([
      "new",
      "a",
      "b",
      "c",
    ]);
    await controller.close();
  });

  for (const request of ["search", "last"] as const) {
    test(`new loaded selection supersedes a pending ${request}`, async () => {
      const { runtime } = createTestRuntime(["a", "b", "c", "d", "e", "f"]);
      const active = createTestPausedSource(runtime.source, 2);
      runtime.source = active.source;
      const controller = new LogController(runtime);
      await controller.loadMore();
      const stale = request === "search" ? controller.search("f") : controller.last(3);
      await active.started;
      await controller.select(0, 3);
      active.release();
      await stale;
      expect(controller.getSelectedRow()?.commit.revisionId).toBe("a");
      await controller.close();
    });
  }

  test("keeps accepted replacement when old cleanup rejects", async () => {
    const { runtime } = createTestRuntime(["a", "b"]);
    const accept = runtime.acceptSource!.bind(runtime);
    runtime.acceptSource = async (source) => {
      await accept(source);
      throw new Error("old cleanup failed");
    };
    const controller = new LogController(runtime);
    await controller.loadMore();
    expect(await controller.refresh()).toBeTrue();
    await Promise.resolve();
    expect(controller.getSnapshot().notice).toBe("old cleanup failed");
    expect(controller.getSelectedRow()?.commit.revisionId).toBe("a");
    await controller.close();
  });

  test("quit closes a blocked unaccepted candidate once without later publication", async () => {
    const { runtime } = createTestRuntime(["a", "b"]);
    const reopen = runtime.reopenSource.bind(runtime);
    let candidate!: ReturnType<typeof createTestPausedSource>;
    runtime.reopenSource = async (signal) => {
      candidate = createTestPausedSource(await reopen(signal));
      return candidate.source;
    };
    const controller = new LogController(runtime);
    await controller.loadMore();
    const refreshing = controller.refresh();
    await Promise.resolve();
    await candidate.started;
    const before = controller.getSnapshot();
    await controller.close();
    expect(await refreshing).toBeFalse();
    expect(candidate.closes()).toBe(1);
    expect(controller.getSnapshot()).toBe(before);
  });
});

for (const request of ["search", "last"] as const) {
  test(`refresh awaits a pending ${request} and resolves its latest focus`, async () => {
    const { runtime, setHistory } = createTestRuntime(["a", "b", "c", "d", "e", "f"]);
    const active = createTestPausedSource(runtime.source, 2);
    runtime.source = active.source;
    const controller = new LogController(runtime);
    await controller.loadMore();
    setHistory(["new", "a", "b", "c", "d", "e", "f"]);
    const reopen = runtime.reopenSource.bind(runtime);
    let candidate!: ReturnType<typeof createTestPausedSource>;
    runtime.reopenSource = async (signal) => {
      candidate = createTestPausedSource(await reopen(signal));
      return candidate.source;
    };
    const refreshing = controller.refresh();
    await Promise.resolve();
    await candidate.started;
    const navigation = request === "search" ? controller.search("f", 1, 6) : controller.last(6);
    await active.started;
    candidate.release();
    await Promise.resolve();
    expect(runtime.source).toBe(active.source);
    active.release();
    await navigation;
    expect(await refreshing).toBeTrue();
    expect(controller.getSelectedRow()?.commit.revisionId).toBe("f");
    expect(controller.isNavigating()).toBeFalse();
    await controller.close();
  });
}

test("an empty submitted search cancels a pending match and stays canceled through refresh", async () => {
  const { runtime } = createTestRuntime(["a", "b", "c", "d"]);
  const active = createTestPausedSource(runtime.source, 2);
  runtime.source = active.source;
  const controller = new LogController(runtime);
  await controller.loadMore();
  const stale = controller.search("d");
  await active.started;
  await controller.search("");
  expect(await controller.refresh()).toBeTrue();
  active.release();
  await stale;
  expect(controller.getSelectedRow()?.commit.revisionId).toBe("a");
  expect(controller.getSnapshot().search).toBe("");
  await controller.close();
});

for (const request of ["search", "last"] as const) {
  for (const cancellation of ["selection", "empty search", "range clear"] as const) {
    test(`ready refresh stops awaiting ${request} superseded by ${cancellation}`, async () => {
      const { runtime } = createTestRuntime(["a", "b", "c", "d"]);
      const active = createTestPausedSource(runtime.source, 2);
      runtime.source = active.source;
      const controller = new LogController(runtime);
      await controller.loadMore();
      controller.beginVisualSelection();
      const stale = request === "search" ? controller.search("d") : controller.last(3);
      await active.started;
      const settling = createTestGate();
      const settle = controller.settleNavigation.bind(controller);
      controller.settleNavigation = async () => {
        settling.release();
        await settle();
      };
      const accepted = createTestGate();
      const accept = runtime.acceptSource!.bind(runtime);
      runtime.acceptSource = async (source) => {
        await accept(source);
        accepted.release();
      };
      const refreshing = controller.refresh();
      try {
        await settling.promise;
        if (cancellation === "selection") await controller.select(0, 3);
        else if (cancellation === "empty search") await controller.search("");
        else expect(controller.clearSelection()).toBeTrue();
        expect(
          await Promise.race([accepted.promise.then(() => true), Bun.sleep(250).then(() => false)]),
        ).toBeTrue();
        expect(await refreshing).toBeTrue();
        expect(controller.getSelectedRow()?.commit.revisionId).toBe("a");
        expect(controller.isNavigating()).toBeFalse();
      } finally {
        active.release();
        await Promise.all([stale, refreshing]);
        await controller.close();
      }
    });
  }
}

test("HK-93 scope refresh keeps fallback with active pages and switches scope only at acceptance", async () => {
  const { runtime } = createTestRuntime(["first", "second", "third"]);
  runtime.source = { ...runtime.source, scope: { kind: "fallback", reason: "unavailable" } };
  const controller = new LogController(runtime);
  await controller.loadMore();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = runtime.reopenSource!;
  runtime.reopenSource = async () => {
    const source = await original();
    await waiting;
    return { ...source, scope: { kind: "bounded", boundaryRevisionId: "main" } };
  };
  const refresh = controller.refresh();
  await controller.loadMore();
  controller.setNotice("ordinary transient notice");
  expect(controller.getSnapshot().rows).toHaveLength(3);
  expect(controller.getSnapshot().scope).toEqual({ kind: "fallback", reason: "unavailable" });
  release();
  expect(await refresh).toBe(true);
  expect(controller.getSnapshot().scope).toEqual({ kind: "bounded", boundaryRevisionId: "main" });
  runtime.reopenSource = async () => {
    throw new Error("replacement failed");
  };
  expect(await controller.refresh()).toBe(false);
  expect(controller.getSnapshot().scope).toEqual({ kind: "bounded", boundaryRevisionId: "main" });
  await controller.close();
});

test("HK-93 accepts initial scope only with a valid first page, including empty EOF", async () => {
  for (const failure of [false, true]) {
    const { runtime } = createTestRuntime([]);
    runtime.source = {
      ...runtime.source,
      scope: { kind: "fallback", reason: "unavailable" },
      read: async () => {
        if (failure) throw new Error("invalid machine record");
        return { commits: [], done: true };
      },
    };
    const controller = new LogController(runtime);
    expect(controller.getSnapshot().scope).toBeUndefined();
    expect(await controller.loadMore()).toBe(!failure);
    expect(controller.getSnapshot().scope).toEqual(
      failure ? undefined : { kind: "fallback", reason: "unavailable" },
    );
    expect(controller.getSnapshot().notice).toBe(
      failure ? "invalid machine record" : "No commits found.",
    );
    await controller.close();
  }
});

test("HK-93 page and wheel scrolling reach every oversized cutoff while preserving commit selection", async () => {
  const { runtime } = createTestRuntime([]);
  const parents = Array.from({ length: 22 }, (_, index) => `hidden-${index}`);
  runtime.source = {
    read: async () => ({
      commits: [
        {
          revisionId: "cut",
          displayId: "cut",
          parentRevisionIds: parents,
          graphCutoffParentRevisionIds: parents,
          subject: "cut",
          authorName: "Test",
          authoredAt: "2026-01-01",
          decorations: [],
        },
      ],
      done: true,
    }),
    async close() {},
  };
  const controller = new LogController(runtime);
  await controller.loadMore();
  controller.clampViewport(20);
  await controller.page(1, 20);
  expect(controller.getSnapshot().selected).toBe(0);
  expect(controller.getSnapshot().entryScroll).toBe(4);
  expect(controller.scrollEntry(-3, 20)).toBe(true);
  expect(controller.getSnapshot().entryScroll).toBe(1);
  await controller.page(-1, 20);
  expect(controller.getSnapshot().entryScroll).toBe(0);
  controller.clampViewport(30);
  expect(controller.getSnapshot().entryScroll).toBe(0);
  await controller.close();
});

/** Create an oversized row for cutoff scrolling and navigation ownership checks. */
function createTestCutoffCommit(id: string) {
  const parents = Array.from({ length: 22 }, (_, index) => `hidden-${index}`);
  return {
    revisionId: id,
    displayId: id,
    parentRevisionIds: parents,
    graphCutoffParentRevisionIds: parents,
    subject: id,
    authorName: "Test",
    authoredAt: "2026-01-01",
    decorations: [],
  };
}

test("HK-93 tail offsets follow reconciled identity and reset on search or refresh fallback", async () => {
  const { runtime } = createTestRuntime([]);
  runtime.source = {
    async read() {
      return {
        commits: [createTestCutoffCommit("one"), createTestCutoffCommit("two")],
        done: true,
      };
    },
    async close() {},
  };
  const controller = new LogController(runtime);
  await controller.loadMore();
  controller.clampViewport(20);
  controller.scrollEntry(5, 20);
  await controller.search("two", 1, 20);
  expect(controller.getSelectedRow()?.commit.revisionId).toBe("two");
  expect(controller.getSnapshot().entryScroll).toBe(0);
  controller.scrollEntry(5, 20);
  runtime.reopenSource = async () => ({
    async read() {
      return { commits: [createTestCutoffCommit("two")], done: true };
    },
    async close() {},
  });
  expect(await controller.refresh()).toBe(true);
  expect(controller.getSnapshot().entryScroll).toBe(4);
  runtime.reopenSource = async () => ({
    async read() {
      return { commits: [createTestCutoffCommit("unrelated")], done: true };
    },
    async close() {},
  });
  expect(await controller.refresh()).toBe(true);
  expect(controller.getSelectedRow()?.commit.revisionId).toBe("unrelated");
  expect(controller.getSnapshot().entryScroll).toBe(0);
  await controller.close();
});

test("HK-93 latest tail scrolling cancels older pending End navigation", async () => {
  const { runtime } = createTestRuntime([]);
  let reads = 0;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  runtime.source = {
    async read() {
      if (reads++ === 0) return { commits: [createTestCutoffCommit("one")], done: false };
      await waiting;
      return { commits: [createTestCutoffCommit("last")], done: true };
    },
    async close() {},
  };
  const controller = new LogController(runtime);
  await controller.loadMore();
  controller.clampViewport(20);
  const end = controller.last(20);
  expect(controller.scrollEntry(3, 20)).toBe(true);
  expect(controller.isNavigating()).toBe(false);
  release();
  await end;
  expect(controller.getSelectedRow()?.commit.revisionId).toBe("one");
  expect(controller.getSnapshot().entryScroll).toBe(3);
  await controller.close();
});

test("compact toggles and resize retain focused identity at the nearest whole-entry row", async () => {
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
  const { runtime } = createTestRuntime(entries);
  const controller = new LogController(runtime);
  while (!controller.getSnapshot().historyDone) await controller.loadMore();
  controller.setViewport(70, 13);
  controller.togglePresentation("graph");
  await controller.select(8, 13);
  const before = controller.planViewport().selectedRowOffset!;
  expect(before).toBe(9);
  controller.togglePresentation("workspaceNames");
  const hidden = controller.planViewport().selectedRowOffset!;
  expect(controller.getSelectedRow()?.commit.revisionId).toBe("revision-8");
  expect(Math.abs(hidden - before)).toBe(1);
  expect(controller.planViewport().usedHeight).toBeLessThanOrEqual(13);
  controller.togglePresentation("workspaceNames");
  expect(controller.planViewport().selectedRowOffset).toBe(9);
  controller.setViewport(120, 13);
  expect(Math.abs(controller.planViewport().selectedRowOffset! - 9)).toBe(1);
  controller.setViewport(70, 13);
  expect(controller.planViewport().selectedRowOffset).toBe(9);
  controller.beginVisualSelection();
  await controller.move(1, 13, { extend: true });
  const selection = controller.getSelection();
  controller.togglePresentation("workspaceNames");
  expect(controller.getSelection()?.focus.commit.revisionId).toBe(
    selection?.focus.commit.revisionId,
  );
  expect(controller.getSelection()?.oldest.commit.revisionId).toBe(
    selection?.oldest.commit.revisionId,
  );
  await controller.close();
});

test("compact pointer-only label refresh keeps the old focus instead of following a new head", async () => {
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
  const { runtime, setHistory } = createTestRuntime(entries);
  const controller = new LogController(runtime);
  while (!controller.getSnapshot().historyDone) await controller.loadMore();
  controller.setViewport(70, 13);
  controller.togglePresentation("graph");
  await controller.select(8, 13);
  const before = controller.planViewport().selectedRowOffset!;
  setHistory(
    entries.map((entry, index) => ({
      ...entry,
      decorations:
        index === 8
          ? []
          : index === 12
            ? [...entry.decorations, entries[8]!.decorations[0]!]
            : entry.decorations,
    })),
  );
  expect(await controller.refresh()).toBe(true);
  expect(controller.getSelectedRow()?.commit.revisionId).toBe("revision-8");
  expect(controller.getSelectedRow()?.commit.decorations).toHaveLength(0);
  expect(Math.abs(controller.planViewport().selectedRowOffset! - before)).toBeLessThanOrEqual(1);
  await controller.close();
});

describe("exact revision marks", () => {
  test("separates exact provider-ordered operation membership from focused and ranged review", async () => {
    const { runtime } = createTestRuntime(["A", "B", "C"]);
    const controller = new LogController(runtime);
    expect(controller.getOperationTargets()).toEqual({ kind: "empty" });
    await controller.last(20);
    controller.toggleMark();
    await controller.first(20);
    controller.toggleMark();
    expect(controller.getSnapshot().selected).toBe(0);
    expect(controller.getOperationTargets()).toMatchObject({
      kind: "ready",
      source: "marks",
      revisionIds: ["A", "C"],
    });
    await controller.select(1, 20);
    expect(controller.getSelectedRows().map((r) => r.commit.revisionId)).toEqual(["B"]);
    expect(controller.getOperationTargets()).toMatchObject({ revisionIds: ["A", "C"] });
    await controller.select(0, 20);
    await controller.select(2, 20, { extend: true });
    expect(controller.getSelectedRows().map((r) => r.commit.revisionId)).toEqual(["A", "B", "C"]);
    const targets = controller.getOperationTargets();
    expect(targets).toMatchObject({ revisionIds: ["A", "C"] });
    expect(Object.isFrozen(targets)).toBe(true);
    if (targets.kind === "ready")
      expect(() => (targets.revisionIds as string[]).push("B")).toThrow();
    controller.toggleMark(0);
    controller.toggleMark(0);
    expect(controller.getSnapshot().selected).toBe(2);
    const top = controller.getSnapshot().top;
    controller.clearSelection();
    expect(controller.getSnapshot()).toMatchObject({
      marks: [],
      selectionAnchor: null,
      visualSelectionActive: false,
      selected: 2,
      top,
    });
    expect(controller.getOperationTargets()).toMatchObject({
      source: "highlight",
      revisionIds: ["C"],
    });
    controller.clearSelection();
    await controller.close();
  });

  test("preserves membership through search, paging, presentation, and exact refresh", async () => {
    const { runtime, setHistory } = createTestRuntime(["A", "B", "C"]);
    const controller = new LogController(runtime);
    await controller.last(8);
    controller.toggleMark();
    await controller.first(8);
    controller.toggleMark();
    await controller.search("B");
    await controller.findMatch(1, 8);
    await controller.page(1, 8);
    controller.togglePresentation("graph");
    setHistory(["X", "A", "B", "C"]);
    expect(await controller.refresh()).toBe(true);
    expect(controller.getOperationTargets()).toMatchObject({ revisionIds: ["A", "C"] });
    await controller.close();
  });

  test("reserves a later exact match before considering duplicate logical identities", async () => {
    const { runtime, setHistory } = createTestRuntime([{ revisionId: "old", logicalId: "change" }]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    controller.toggleMark();
    setHistory([
      { revisionId: "new", logicalId: "change" },
      ...Array.from({ length: 257 }, (_, i) => ({ revisionId: "filler" + i })),
      { revisionId: "old", logicalId: "change" },
    ]);
    expect(await controller.refresh()).toBe(true);
    expect(controller.getOperationTargets()).toMatchObject({ revisionIds: ["old"] });
    expect(controller.getSnapshot().rows.length).toBe(259);
    await controller.close();
  });

  test("only accepts a unique logical rewrite in a complete unchanged eligible stream", async () => {
    for (const filter of [
      undefined,
      { maxCount: 1 },
      { author: "Ada" },
      { grep: "x" },
      { since: "y" },
      { until: "z" },
      { pathspecs: ["file"] },
    ]) {
      const { runtime, setHistory } = createTestRuntime([
        { revisionId: "old", logicalId: "change", subject: "Original subject" },
      ]);
      Object.assign(runtime.input, filter ?? {});
      const controller = new LogController(runtime);
      await controller.loadMore();
      controller.toggleMark();
      setHistory([{ revisionId: "new", logicalId: "change" }]);
      expect(await controller.refresh()).toBe(true);
      if (!filter) expect(controller.getOperationTargets()).toMatchObject({ revisionIds: ["new"] });
      else {
        expect(controller.getSnapshot().marks).toMatchObject([
          {
            kind: "unresolved",
            reason: "incomplete",
            mark: { revisionId: "old", subject: "Original subject" },
          },
        ]);
        expect(controller.getOperationTargets()).toMatchObject({
          kind: "blocked",
          reason: "unresolved",
        });
      }
      await controller.close();
    }
  });

  test("retains ambiguous and missing marks and never publishes partial operation IDs", async () => {
    const { runtime, setHistory } = createTestRuntime([
      { revisionId: "A", logicalId: "a" },
      { revisionId: "C", logicalId: "c", subject: "Retained C" },
    ]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    controller.toggleMark(0);
    controller.toggleMark(1);
    setHistory([
      { revisionId: "A", logicalId: "a" },
      { revisionId: "C1", logicalId: "c" },
      { revisionId: "C2", logicalId: "c" },
    ]);
    await controller.refresh();
    expect(controller.getSnapshot().marks[1]).toMatchObject({
      kind: "unresolved",
      reason: "ambiguous",
      mark: { revisionId: "C", subject: "Retained C" },
    });
    expect(controller.getOperationTargets()).toMatchObject({
      kind: "blocked",
      reason: "unresolved",
    });
    expect(controller.getOperationTargets()).not.toHaveProperty("revisionIds");
    setHistory(["A"]);
    await controller.refresh();
    expect(controller.getSnapshot().marks[1]).toMatchObject({
      kind: "unresolved",
      reason: "missing",
    });
    controller.removeUnresolvedMarks();
    expect(controller.getOperationTargets()).toMatchObject({ revisionIds: ["A"] });
    await controller.close();
  });

  test("blocks logical collision with an exact mark and duplicate mark claims", async () => {
    for (const exact of [true, false]) {
      const { runtime, setHistory } = createTestRuntime([
        { revisionId: "A", logicalId: "same" },
        { revisionId: "B", logicalId: "same" },
      ]);
      const controller = new LogController(runtime);
      await controller.loadMore();
      controller.toggleMark(0);
      controller.toggleMark(1);
      setHistory([{ revisionId: exact ? "A" : "new", logicalId: "same" }]);
      await controller.refresh();
      expect(controller.getOperationTargets()).toMatchObject({ kind: "blocked" });
      expect(controller.getSnapshot().marks.at(-1)).toMatchObject({
        kind: "unresolved",
        reason: "ambiguous",
      });
      await controller.close();
    }
  });

  test("clearing during deferred refresh never restores stale intent", async () => {
    const { runtime } = createTestRuntime(["A", "B", "C"]);
    const controller = new LogController(runtime);
    await controller.last(20);
    controller.toggleMark();
    const original = runtime.reopenSource.bind(runtime);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    runtime.reopenSource = async (signal) => {
      await gate;
      return original(signal);
    };
    const refreshing = controller.refresh();
    expect(controller.getOperationTargets()).toMatchObject({ kind: "blocked", reason: "checking" });
    controller.clearSelection();
    release();
    expect(await refreshing).toBe(true);
    expect(controller.getSnapshot().marks).toEqual([]);
    expect(controller.getOperationTargets()).toMatchObject({
      source: "highlight",
      revisionIds: ["C"],
    });
    await controller.close();
  });

  test("keeps active rows and marks blocked on reopen, read, and synchronous acceptance failure; retry recovers", async () => {
    for (const stage of ["reopen", "read", "accept"]) {
      const { runtime } = createTestRuntime(["A", "B"]);
      const controller = new LogController(runtime);
      await controller.loadMore();
      controller.toggleMark();
      const rows = controller.getSnapshot().rows;
      const reopen = runtime.reopenSource.bind(runtime);
      const accept = runtime.acceptSource;
      if (stage === "reopen")
        runtime.reopenSource = async () => {
          throw new Error("reopen failed");
        };
      if (stage === "read")
        runtime.reopenSource = async () => ({
          read: async () => {
            throw new Error("read failed");
          },
          close: async () => {},
        });
      if (stage === "accept")
        runtime.acceptSource = () => {
          throw new Error("accept failed");
        };
      expect(await controller.refresh()).toBe(false);
      expect(controller.getSnapshot().rows).toBe(rows);
      expect(controller.getSnapshot().marks).toHaveLength(1);
      expect(controller.getOperationTargets()).toMatchObject({
        kind: "blocked",
        reason: "refresh-failed",
      });
      runtime.reopenSource = reopen;
      runtime.acceptSource = accept;
      expect(await controller.refresh()).toBe(true);
      expect(controller.getOperationTargets()).toMatchObject({ kind: "ready", revisionIds: ["A"] });
      await controller.close();
    }
  });
});

test("refresh disables new marks before and after clearing and guard refusal keeps unchecked intent blocked", async () => {
  const { runtime } = createTestRuntime(["A", "B"]);
  const controller = new LogController(runtime);
  await controller.loadMore();
  const original = runtime.reopenSource.bind(runtime);
  let release!: () => void;
  let gate = new Promise<void>((resolve) => (release = resolve));
  runtime.reopenSource = async (signal) => {
    await gate;
    return original(signal);
  };
  let refreshing = controller.refresh();
  expect(controller.getSnapshot().markStatus).toBe("checking");
  expect(controller.toggleMark()).toBe(false);
  release();
  await refreshing;
  controller.toggleMark();
  gate = new Promise<void>((resolve) => (release = resolve));
  refreshing = controller.refresh();
  controller.clearSelection();
  expect(controller.toggleMark()).toBe(false);
  expect(controller.getOperationTargets()).toMatchObject({ source: "highlight" });
  release();
  await refreshing;
  controller.toggleMark();
  gate = new Promise<void>((resolve) => (release = resolve));
  let allowed = true;
  refreshing = controller.refresh(() => allowed);
  allowed = false;
  release();
  expect(await refreshing).toBe(false);
  expect(controller.getOperationTargets()).toMatchObject({
    kind: "blocked",
    reason: "refresh-failed",
  });
  expect(await controller.refresh(() => false)).toBe(false);
  expect(controller.getOperationTargets()).toMatchObject({ kind: "blocked" });
  await controller.close();
});

test("checking recovery cannot remove unresolved marks; an explicit revision scope never follows a logical rewrite", async () => {
  const { runtime, setHistory } = createTestRuntime([{ revisionId: "old", logicalId: "logical" }]);
  runtime.input.revision = "explicit-scope";
  runtime.input.firstParent = true;
  const controller = new LogController(runtime);
  await controller.loadMore();
  controller.toggleMark();
  setHistory([]);
  await controller.refresh();
  const original = runtime.reopenSource.bind(runtime);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  runtime.reopenSource = async (signal) => {
    await gate;
    return original(signal);
  };
  setHistory([{ revisionId: "rewritten", logicalId: "logical" }]);
  const refreshing = controller.refresh();
  expect(controller.removeUnresolvedMarks()).toBe(false);
  expect(controller.getSnapshot().marks).toHaveLength(1);
  release();
  await refreshing;
  expect(controller.getSnapshot().marks).toMatchObject([
    { kind: "unresolved", reason: "incomplete", mark: { revisionId: "old" } },
  ]);
  expect(controller.getOperationTargets()).toMatchObject({ kind: "blocked", reason: "unresolved" });
  setHistory([{ revisionId: "another", logicalId: "logical" }]);
  runtime.input.revision = "different-scope";
  await controller.refresh();
  expect(controller.getSnapshot().marks).toMatchObject([
    { kind: "unresolved", reason: "incomplete" },
  ]);
  await controller.close();
});

type TestHistoryScope = HistoryRuntime["source"]["scope"];

/** Give the mounted source and every reopened source a history scope that tests can move. */
function scopeTestRuntime(runtime: HistoryRuntime, initial: TestHistoryScope) {
  let scope = initial;
  const withScope = (source: HistoryRuntime["source"]): HistoryRuntime["source"] => ({
    read: (options) => source.read(options),
    close: () => source.close(),
    ...(scope ? { scope } : {}),
  });
  const reopen = runtime.reopenSource.bind(runtime);
  runtime.source = withScope(runtime.source);
  runtime.reopenSource = async (signal) => withScope(await reopen(signal));
  return (next: TestHistoryScope) => {
    scope = next;
  };
}

describe("revision marks across history scopes", () => {
  const boundedAt = (boundaryRevisionId: string): TestHistoryScope => ({
    kind: "bounded",
    boundaryRevisionId,
  });
  const fallback: TestHistoryScope = { kind: "fallback", reason: "unavailable" };

  for (const scenario of [
    {
      name: "main advances past an unchanged marked revision",
      before: { scope: boundedAt("T1"), history: ["A", "B", "T1"] },
      mark: "B",
      after: { scope: boundedAt("T2"), history: ["A", "T2"] },
    },
    {
      name: "a divergent copy stays visible while the marked copy leaves the bound",
      before: {
        scope: boundedAt("T1"),
        history: [{ revisionId: "c1", logicalId: "k" }, { revisionId: "c3", logicalId: "k" }, "T1"],
      },
      mark: "c1",
      after: { scope: boundedAt("T2"), history: [{ revisionId: "c3", logicalId: "k" }, "T2"] },
    },
    {
      name: "fallback history becomes bounded",
      before: { scope: fallback, history: ["A", "T1", "OLD"] },
      mark: "OLD",
      after: { scope: boundedAt("T1"), history: ["A", "T1"] },
    },
    {
      name: "bounded history falls back and a logical sibling appears",
      before: { scope: boundedAt("T1"), history: [{ revisionId: "c1", logicalId: "k" }, "T1"] },
      mark: "c1",
      after: { scope: fallback, history: [{ revisionId: "c3", logicalId: "k" }, "T1", "OLD"] },
    },
    {
      name: "the fallback reason changes",
      before: { scope: fallback, history: [{ revisionId: "c1", logicalId: "k" }] },
      mark: "c1",
      after: {
        scope: { kind: "fallback", reason: "ambiguous" } as TestHistoryScope,
        history: [{ revisionId: "c3", logicalId: "k" }],
      },
    },
    {
      name: "an unscoped history gains a bound",
      before: { scope: undefined, history: [{ revisionId: "c1", logicalId: "k" }, "T1"] },
      mark: "c1",
      after: { scope: boundedAt("T1"), history: [{ revisionId: "c3", logicalId: "k" }, "T1"] },
    },
  ] satisfies Array<{
    name: string;
    before: { scope: TestHistoryScope; history: TestHistoryEntry[] };
    mark: string;
    after: { scope: TestHistoryScope; history: TestHistoryEntry[] };
  }>)
    test(`keeps an absent mark unchecked, never re-targeted or missing, when ${scenario.name}`, async () => {
      const { runtime, setHistory } = createTestRuntime(scenario.before.history);
      const setScope = scopeTestRuntime(runtime, scenario.before.scope);
      const controller = new LogController(runtime);
      await controller.last(20);
      const index = controller
        .getSnapshot()
        .rows.findIndex((row) => row.commit.revisionId === scenario.mark);
      expect(controller.toggleMark(index)).toBe(true);
      expect(controller.getOperationTargets()).toMatchObject({ revisionIds: [scenario.mark] });

      setHistory(scenario.after.history);
      setScope(scenario.after.scope);
      expect(await controller.refresh()).toBe(true);

      expect(controller.getSnapshot().scope).toEqual(scenario.after.scope);
      expect(controller.getSnapshot().markStatus).toBe("ready");
      expect(controller.getSnapshot().marks).toMatchObject([
        { kind: "unresolved", reason: "incomplete", mark: { revisionId: scenario.mark } },
      ]);
      expect(controller.getOperationTargets()).toMatchObject({
        kind: "blocked",
        reason: "unresolved",
        unresolved: [{ revisionId: scenario.mark }],
      });
      await controller.close();
    });

  test("keeps an exact match resolved when the bound moves", async () => {
    const { runtime, setHistory } = createTestRuntime(["A", "B", "T1"]);
    const setScope = scopeTestRuntime(runtime, boundedAt("T1"));
    const controller = new LogController(runtime);
    await controller.last(20);
    controller.toggleMark(0);
    setHistory(["A", "T2"]);
    setScope(boundedAt("T2"));
    expect(await controller.refresh()).toBe(true);
    expect(controller.getSnapshot().marks).toMatchObject([{ kind: "resolved", revisionId: "A" }]);
    expect(controller.getOperationTargets()).toMatchObject({ kind: "ready", revisionIds: ["A"] });
    await controller.close();
  });

  for (const scope of [boundedAt("T1"), fallback, undefined])
    test(`follows a unique logical rewrite and reports a vanished revision as missing when ${scope ? `${scope.kind} scope` : "unscoped history"} is unchanged`, async () => {
      const { runtime, setHistory } = createTestRuntime([
        { revisionId: "old", logicalId: "change" },
        { revisionId: "gone", logicalId: "gone-change" },
        "T1",
      ]);
      scopeTestRuntime(runtime, scope);
      const controller = new LogController(runtime);
      await controller.last(20);
      controller.toggleMark(0);
      controller.toggleMark(1);
      setHistory([{ revisionId: "new", logicalId: "change" }, "T1"]);
      expect(await controller.refresh()).toBe(true);
      expect(controller.getSnapshot().scope).toEqual(scope);
      expect(controller.getSnapshot().marks).toMatchObject([
        { kind: "resolved", revisionId: "new" },
        { kind: "unresolved", reason: "missing", mark: { revisionId: "gone" } },
      ]);
      await controller.close();
    });

  test("still reports a limited unscoped history as unchecked", async () => {
    const { runtime, setHistory } = createTestRuntime([
      { revisionId: "c1", logicalId: "k" },
      { revisionId: "c3", logicalId: "k" },
    ]);
    runtime.input.maxCount = 50;
    scopeTestRuntime(runtime, undefined);
    const controller = new LogController(runtime);
    await controller.last(20);
    controller.toggleMark(0);
    setHistory([{ revisionId: "c3", logicalId: "k" }]);
    expect(await controller.refresh()).toBe(true);
    expect(controller.getSnapshot().marks).toMatchObject([
      { kind: "unresolved", reason: "incomplete", mark: { revisionId: "c1" } },
    ]);
    await controller.close();
  });
});

describe("revision marks across repeated refreshes", () => {
  const boundedAt = (boundaryRevisionId: string): TestHistoryScope => ({
    kind: "bounded",
    boundaryRevisionId,
  });
  const change = (revisionId: string, logicalId = "k") => ({ revisionId, logicalId });

  /** Summarize every mark as `state:original->target` so a sequence reads as one line per refresh. */
  function describeTestMarks(controller: LogController) {
    return controller
      .getSnapshot()
      .marks.map((entry) =>
        entry.kind === "resolved"
          ? `resolved:${entry.revisionId}`
          : `${entry.reason}:${entry.mark.revisionId}`,
      );
  }

  /** Mount a scoped history, load every row, and mark the named revisions. */
  async function createTestScopedMarks(
    history: TestHistoryEntry[],
    scope: TestHistoryScope,
    marked: string[],
  ) {
    const { runtime, setHistory } = createTestRuntime(history);
    const setScope = scopeTestRuntime(runtime, scope);
    const controller = new LogController(runtime);
    await controller.last(20);
    for (const revisionId of marked)
      expect(
        controller.toggleMark(
          controller.getSnapshot().rows.findIndex((row) => row.commit.revisionId === revisionId),
        ),
      ).toBe(true);
    /** Replace the provider's history and scope, refresh once, and report the marks. */
    const refreshTo = async (
      next: TestHistoryEntry[],
      nextScope: TestHistoryScope,
      shouldApply?: () => boolean,
    ) => {
      setHistory(next);
      setScope(nextScope);
      expect(await controller.refresh(shouldApply)).toBe(true);
      expect(controller.getSnapshot().markStatus).toBe("ready");
      return describeTestMarks(controller);
    };
    return { runtime, controller, refreshTo };
  }

  for (const [name, shouldApply] of [
    ["manual refresh", undefined],
    ["the guarded refresh auto-refresh runs", () => true],
  ] as const)
    test(`never re-targets a mark to a divergent copy on any later refresh under the moved bound, through ${name}`, async () => {
      const { controller, refreshTo } = await createTestScopedMarks(
        [change("c1"), change("c3"), "T1"],
        boundedAt("T1"),
        ["c1"],
      );
      for (let refresh = 0; refresh < 4; refresh += 1) {
        expect(await refreshTo([change("c3"), "T2"], boundedAt("T2"), shouldApply)).toEqual([
          "incomplete:c1",
        ]);
        expect(controller.getOperationTargets()).toMatchObject({
          kind: "blocked",
          reason: "unresolved",
          unresolved: [{ revisionId: "c1" }],
        });
      }
      await controller.close();
    });

  test("never calls an unchanged revision missing on any later refresh under the moved bound", async () => {
    const { controller, refreshTo } = await createTestScopedMarks(
      ["A", "B", "T1"],
      boundedAt("T1"),
      ["B"],
    );
    for (let refresh = 0; refresh < 4; refresh += 1)
      expect(await refreshTo(["A", "T2"], boundedAt("T2"))).toEqual(["incomplete:B"]);
    await controller.close();
  });

  test("resolves the mark when the bound moves back and its revision is visible again, then follows a later rewrite there", async () => {
    const { controller, refreshTo } = await createTestScopedMarks(
      [change("c1"), "T1"],
      boundedAt("T1"),
      ["c1"],
    );
    expect(await refreshTo(["T2"], boundedAt("T2"))).toEqual(["incomplete:c1"]);
    expect(await refreshTo(["T2"], boundedAt("T2"))).toEqual(["incomplete:c1"]);
    expect(await refreshTo([change("c1"), "T1"], boundedAt("T1"))).toEqual(["resolved:c1"]);
    expect(await refreshTo([change("c2"), "T1"], boundedAt("T1"))).toEqual(["resolved:c2"]);
    expect(controller.getOperationTargets()).toMatchObject({ kind: "ready", revisionIds: ["c2"] });
    await controller.close();
  });

  test("moves a mark's record to the new bound once its revision is seen there", async () => {
    const { controller, refreshTo } = await createTestScopedMarks(
      [change("c1"), "T1"],
      boundedAt("T1"),
      ["c1"],
    );
    expect(await refreshTo(["T2"], boundedAt("T2"))).toEqual(["incomplete:c1"]);
    expect(await refreshTo([change("c1"), "T2"], boundedAt("T2"))).toEqual(["resolved:c1"]);
    // Seen under T2 now: a rewrite under T2 follows, and the old bound proves nothing any more.
    expect(await refreshTo([change("c2"), "T2"], boundedAt("T2"))).toEqual(["resolved:c2"]);
    expect(await refreshTo([change("c9"), "T1"], boundedAt("T1"))).toEqual(["incomplete:c2"]);
    expect(await refreshTo([change("c9"), "T1"], boundedAt("T1"))).toEqual(["incomplete:c2"]);
    await controller.close();
  });

  test("decides each mark by its own record when only one was left behind by the moved bound", async () => {
    const { controller, refreshTo } = await createTestScopedMarks(
      [change("kept", "kept-change"), change("c1"), change("c3"), "T1"],
      boundedAt("T1"),
      ["kept", "c1"],
    );
    expect(await refreshTo([change("kept", "kept-change"), change("c3"), "T2"], boundedAt("T2")))
      // `kept` was seen under T2, `c1` was not.
      .toEqual(["resolved:kept", "incomplete:c1"]);
    expect(
      await refreshTo([change("kept2", "kept-change"), change("c3"), "T2"], boundedAt("T2")),
    ).toEqual(["resolved:kept2", "incomplete:c1"]);
    await controller.close();
  });

  test("keeps following rewrites across refreshes while the scope is unchanged", async () => {
    for (const scope of [boundedAt("T1"), undefined]) {
      const { controller, refreshTo } = await createTestScopedMarks([change("c1"), "T1"], scope, [
        "c1",
      ]);
      expect(await refreshTo([change("c2"), "T1"], scope)).toEqual(["resolved:c2"]);
      expect(await refreshTo([change("c3"), "T1"], scope)).toEqual(["resolved:c3"]);
      expect(await refreshTo(["T1"], scope)).toEqual(["missing:c3"]);
      expect(await refreshTo([change("c4"), "T1"], scope)).toEqual(["resolved:c4"]);
      await controller.close();
    }
  });

  test("keeps a mark unchecked on every refresh after the traversal input changes", async () => {
    const { runtime, controller, refreshTo } = await createTestScopedMarks(
      [change("old")],
      undefined,
      ["old"],
    );
    runtime.input.revision = "other-revset";
    for (let refresh = 0; refresh < 3; refresh += 1)
      expect(await refreshTo([change("another")], undefined)).toEqual(["incomplete:old"]);
    delete runtime.input.revision;
    expect(await refreshTo([change("rewritten")], undefined)).toEqual(["resolved:rewritten"]);
    await controller.close();
  });

  test("records the rows on screen, not a pending input or bound, when a mark is made", async () => {
    const { runtime, controller, refreshTo } = await createTestScopedMarks(
      [change("old"), "T1"],
      boundedAt("T1"),
      [],
    );
    // The input changes before any refresh: the rows on screen still come from the old one.
    // `all` changes the traversal without filtering it, so a later rewrite can still follow.
    runtime.input.all = true;
    controller.toggleMark(0);
    expect(await refreshTo([change("another"), "T1"], boundedAt("T1"))).toEqual(["incomplete:old"]);
    // A mark made on the refreshed rows records them, so a rewrite there follows.
    controller.toggleMark(0);
    expect(await refreshTo([change("later"), "T1"], boundedAt("T1"))).toEqual([
      "incomplete:old",
      "resolved:later",
    ]);
    await controller.close();
  });
});

describe("revision marks under a revision or first-parent filter", () => {
  const change = (revisionId: string, logicalId = "k") => ({ revisionId, logicalId });

  /** Mount a history under the given input, load every row, and mark the named revision. */
  async function createTestFilteredMark(
    input: Partial<HistoryRuntime["input"]>,
    history: TestHistoryEntry[],
    marked: string,
  ) {
    const { runtime, setHistory } = createTestRuntime(history);
    Object.assign(runtime.input, input);
    const controller = new LogController(runtime);
    await controller.last(20);
    expect(
      controller.toggleMark(
        controller.getSnapshot().rows.findIndex((row) => row.commit.revisionId === marked),
      ),
    ).toBe(true);
    /** Replace the provider's history, refresh once, and report the mark as `state:revision`. */
    const refreshTo = async (next: TestHistoryEntry[]) => {
      setHistory(next);
      expect(await controller.refresh()).toBe(true);
      expect(controller.getSnapshot().markStatus).toBe("ready");
      return controller
        .getSnapshot()
        .marks.map((entry) =>
          entry.kind === "resolved"
            ? `resolved:${entry.revisionId}`
            : `${entry.reason}:${entry.mark.revisionId}`,
        );
    };
    return { controller, refreshTo };
  }

  for (const [name, input] of [
    ["a revision", { revision: "@" }],
    ["first-parent", { firstParent: true }],
    ["a revision and first-parent", { revision: "@", firstParent: true }],
  ] as const) {
    test(`never re-targets a mark to a divergent copy that enters the rows under ${name}`, async () => {
      // `jj edit <other copy>` moves `@` only: the marked copy is still visible, outside the rows.
      const { controller, refreshTo } = await createTestFilteredMark(
        input,
        [change("c1"), "base"],
        "c1",
      );
      for (let refresh = 0; refresh < 3; refresh += 1) {
        expect(await refreshTo([change("c2"), "base"])).toEqual(["incomplete:c1"]);
        expect(controller.getOperationTargets()).toMatchObject({
          kind: "blocked",
          reason: "unresolved",
          unresolved: [{ revisionId: "c1" }],
        });
      }
      await controller.close();
    });

    test(`never calls an unchanged revision missing when it leaves the rows under ${name}`, async () => {
      // `jj new main` moves `@` elsewhere: the marked revision is unchanged, outside the rows.
      const { controller, refreshTo } = await createTestFilteredMark(
        input,
        [change("Y", "y-change"), "base"],
        "Y",
      );
      for (let refresh = 0; refresh < 3; refresh += 1)
        expect(await refreshTo(["elsewhere", "base"])).toEqual(["incomplete:Y"]);
      await controller.close();
    });

    test(`keeps an exact match resolved under ${name}`, async () => {
      const { controller, refreshTo } = await createTestFilteredMark(
        input,
        [change("c1"), "base"],
        "c1",
      );
      expect(await refreshTo(["newer", change("c1"), "base"])).toEqual(["resolved:c1"]);
      expect(await refreshTo([change("c2"), "base"])).toEqual(["incomplete:c1"]);
      expect(await refreshTo([change("c1"), "base"])).toEqual(["resolved:c1"]);
      await controller.close();
    });
  }

  for (const [name, input] of [
    ["the default view", {}],
    ["--all", { all: true }],
  ] as const)
    test(`still follows a rewrite across two refreshes in ${name}`, async () => {
      const { controller, refreshTo } = await createTestFilteredMark(
        input,
        [change("c1"), "base"],
        "c1",
      );
      expect(await refreshTo([change("c2"), "base"])).toEqual(["resolved:c2"]);
      expect(await refreshTo([change("c3"), "base"])).toEqual(["resolved:c3"]);
      expect(controller.getOperationTargets()).toMatchObject({
        kind: "ready",
        revisionIds: ["c3"],
      });
      await controller.close();
    });
});

describe("operation source selection preparation", () => {
  test("seeds the highlight, toggles without moving focus, and leaves explicit empty sources", async () => {
    const { runtime } = createTestRuntime(["A", "B", "C"]);
    const controller = new LogController(runtime);
    await controller.last(8);
    const selection = new RevisionSourceSelection(controller, () => ({ eligible: true }));
    const visit = Symbol("operation");
    expect(selection.begin(visit)).toEqual({ kind: "changed" });
    expect(selection.targets(visit)).toMatchObject({ source: "marks", revisionIds: ["C"] });
    expect(selection.indicator("C")).toBe("✓");
    const { selected, top, entryScroll } = controller.getSnapshot();
    expect(selection.toggle(visit)).toEqual({ kind: "changed" });
    expect(selection.targets(visit)).toEqual({ kind: "empty" });
    expect(selection.lock(visit)).toEqual({ kind: "empty" });
    expect(selection.indicator("C")).toBe(" ");
    expect(controller.getSnapshot()).toMatchObject({ selected, top, entryScroll });
    // Other consumers retain their existing highlighted fallback until host wiring changes.
    expect(controller.getOperationTargets()).toMatchObject({
      source: "highlight",
      revisionIds: ["C"],
    });
    expect(selection.toggle(visit, 0)).toEqual({ kind: "changed" });
    expect(selection.targets(visit)).toMatchObject({ revisionIds: ["A"] });
    expect(controller.getSnapshot().selected).toBe(selected);
    selection.end(visit);
    await controller.close();
  });

  test("keeps exact provider order and a frozen source indication through a locked phase", async () => {
    const { runtime } = createTestRuntime(["A", "B", "C"]);
    const controller = new LogController(runtime);
    await controller.last(8);
    const selection = new RevisionSourceSelection(controller, () => ({ eligible: true }));
    const visit = Symbol("operation");
    selection.begin(visit);
    selection.toggle(visit, 0);
    const targets = selection.lock(visit);
    expect(targets).toMatchObject({ source: "marks", revisionIds: ["A", "C"] });
    expect(Object.isFrozen(targets)).toBeTrue();
    if (targets.kind === "ready") expect(Object.isFrozen(targets.revisionIds)).toBeTrue();
    await controller.select(1, 8);
    expect(selection.toggle(visit)).toEqual({ kind: "inactive" });
    expect(selection.targets(visit)).toBe(targets);
    expect(selection.indicator("A")).toBe("✓");
    expect(selection.indicator("B")).toBe(" ");
    expect(selection.indicator("C")).toBe("✓");
    selection.end(visit);
    expect(controller.getSnapshot().selected).toBe(1);
    expect(selection.indicator("A")).toBe(" ");
    await controller.close();
  });

  test("leaves eligibility and its refusal wording with the host", async () => {
    const { runtime } = createTestRuntime(["A", "B"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    let allowed = false;
    const selection = new RevisionSourceSelection(controller, () =>
      allowed ? { eligible: true } : { eligible: false, reason: "Host source refusal" },
    );
    const visit = Symbol("operation");
    expect(selection.begin(visit)).toEqual({ kind: "refused", reason: "Host source refusal" });
    expect(controller.getSnapshot().marks).toEqual([]);
    allowed = true;
    expect(selection.begin(visit)).toEqual({ kind: "changed" });
    allowed = false;
    expect(selection.toggle(visit, 1)).toEqual({ kind: "refused", reason: "Host source refusal" });
    expect(selection.targets(visit)).toMatchObject({ revisionIds: ["A"] });
    expect(selection.toggle(visit)).toEqual({ kind: "changed" });
    expect(selection.targets(visit)).toEqual({ kind: "empty" });
    selection.end(visit);
    await controller.close();
  });

  test("rejects overlapping visits and ignores stale callbacks after a new visit starts", async () => {
    const { runtime } = createTestRuntime(["A", "B"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    const selection = new RevisionSourceSelection(controller, () => ({ eligible: true }));
    const first = Symbol("first");
    const second = Symbol("second");
    selection.begin(first);
    expect(selection.begin(second).kind).toBe("refused");
    expect(selection.end(first)).toBeTrue();
    await controller.select(1, 8);
    selection.begin(second);
    expect(selection.end(first)).toBeFalse();
    expect(selection.toggle(first)).toEqual({ kind: "inactive" });
    expect(selection.lock(first)).toEqual({ kind: "empty" });
    expect(selection.targets(second)).toMatchObject({ revisionIds: ["B"] });
    selection.end(second);
    await controller.close();
  });

  test("mark-only cleanup preserves review range and waits for queued navigation", async () => {
    const { runtime } = createTestRuntime(["A", "B", "C"]);
    const read = runtime.source.read.bind(runtime.source);
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.source.read = async (options) => {
      if (++reads === 2) await gate;
      return read(options);
    };
    const controller = new LogController(runtime);
    await controller.loadMore();
    await controller.select(1, 1);
    controller.beginVisualSelection();
    controller.seedSourceSelection("B");
    const moving = controller.move(1, 1, { extend: true });
    let settled = false;
    const settlement = controller.settleNavigation().then(() => {
      settled = true;
    });
    expect(controller.clearRevisionMarks()).toBeTrue();
    await Promise.resolve();
    expect(settled).toBeFalse();
    expect(controller.getSnapshot()).toMatchObject({
      selected: 1,
      selectionAnchor: 1,
      visualSelectionActive: true,
    });
    release();
    await Promise.all([moving, settlement]);
    expect(controller.getSnapshot()).toMatchObject({
      selected: 2,
      selectionAnchor: 1,
      visualSelectionActive: true,
      marks: [],
    });
    await controller.close();
  });

  test("mark-only cleanup during refresh cannot resurrect source intent", async () => {
    const { runtime } = createTestRuntime(["A", "B"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    controller.seedSourceSelection("A");
    const reopen = runtime.reopenSource.bind(runtime);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.reopenSource = async (signal) => {
      await gate;
      return reopen(signal);
    };
    const refreshing = controller.refresh();
    expect(controller.seedSourceSelection("A")).toBeFalse();
    expect(controller.clearRevisionMarks()).toBeTrue();
    release();
    expect(await refreshing).toBeTrue();
    expect(controller.getOperationTargets({ allowHighlightedFallback: false })).toEqual({
      kind: "empty",
    });
    expect(controller.getSnapshot().marks).toEqual([]);
    expect(controller.clearRevisionMarks()).toBeFalse();
    await controller.close();
  });

  test("refuses to lock unresolved sources and keeps them available for recovery", async () => {
    const { runtime, setHistory } = createTestRuntime(["A", "B"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    const selection = new RevisionSourceSelection(controller, () => ({ eligible: true }));
    const visit = Symbol("operation");
    selection.begin(visit);
    setHistory(["B"]);
    await controller.refresh();
    expect(selection.lock(visit)).toMatchObject({ kind: "blocked", reason: "unresolved" });
    expect(selection.targets(visit)).not.toHaveProperty("revisionIds");
    controller.removeUnresolvedMarks();
    expect(selection.targets(visit)).toEqual({ kind: "empty" });
    expect(selection.toggle(visit)).toEqual({ kind: "changed" });
    expect(selection.targets(visit)).toMatchObject({ revisionIds: ["B"] });
    selection.end(visit);
    await controller.close();
  });
});

test("source entry publishes its checkmark immediately and cannot seed an unchecked replacement highlight", async () => {
  const { runtime } = createTestRuntime(["A", "B"]);
  const controller = new LogController(runtime);
  await controller.loadMore();
  const selection = new RevisionSourceSelection(controller, () => ({ eligible: true }));
  const indications: string[] = [];
  const unsubscribe = controller.subscribe(() => {
    indications.push(selection.indicator("A"));
  });
  const visit = Symbol("operation");
  expect(selection.begin(visit)).toEqual({ kind: "changed" });
  expect(indications[0]).toBe("✓");
  selection.end(visit);
  unsubscribe();
  await controller.select(1, 8);
  expect(controller.seedSourceSelection("A")).toBeFalse();
  expect(controller.getSnapshot().marks).toEqual([]);
  await controller.close();
});

test("a host callback cannot replace a visit during begin and have it overwritten", async () => {
  const { runtime } = createTestRuntime(["A", "B"]);
  const controller = new LogController(runtime);
  await controller.loadMore();
  const first = Symbol("first");
  const second = Symbol("second");
  let replace = true;
  const selection = new RevisionSourceSelection(controller, () => {
    if (replace) {
      replace = false;
      expect(selection.end(first)).toBeTrue();
      void controller.select(1, 8);
      expect(selection.begin(second)).toEqual({ kind: "changed" });
    }
    return { eligible: true };
  });
  expect(selection.begin(first)).toEqual({ kind: "inactive" });
  expect(selection.targets(second)).toMatchObject({ revisionIds: ["B"] });
  expect(selection.end(first)).toBeFalse();
  selection.end(second);
  await controller.close();
});

test("an obsolete toggle cannot remove a replacement visit's source after host eligibility", async () => {
  const { runtime } = createTestRuntime(["A", "B"]);
  const controller = new LogController(runtime);
  await controller.loadMore();
  const first = Symbol("first");
  const second = Symbol("second");
  let replace = false;
  const selection = new RevisionSourceSelection(controller, () => {
    if (replace) {
      replace = false;
      selection.end(first);
      void controller.select(1, 8);
      selection.begin(second);
    }
    return { eligible: true };
  });
  selection.begin(first);
  replace = true;
  expect(selection.toggle(first, 1)).toEqual({ kind: "inactive" });
  expect(selection.targets(second)).toMatchObject({ revisionIds: ["B"] });
  expect(selection.indicator("B")).toBe("✓");
  selection.end(second);
  await controller.close();
});

test("a closed controller cannot report a successful source toggle", async () => {
  const { runtime } = createTestRuntime(["A", "B"]);
  const controller = new LogController(runtime);
  await controller.loadMore();
  const selection = new RevisionSourceSelection(controller, () => ({ eligible: true }));
  const visit = Symbol("operation");
  selection.begin(visit);
  await controller.close();
  expect(selection.toggle(visit, 1)).toMatchObject({ kind: "refused" });
  expect(selection.targets(visit)).toMatchObject({ revisionIds: ["A"] });
  expect(controller.toggleMark(1)).toBeFalse();
  selection.end(visit);
});

test("source entry cannot lock generic marks before seeding its checked highlight", async () => {
  const { runtime } = createTestRuntime(["A", "B"]);
  const controller = new LogController(runtime);
  await controller.loadMore();
  controller.toggleMark(1);
  const visit = Symbol("operation");
  const selection = new RevisionSourceSelection(controller, () => {
    expect(selection.lock(visit)).toEqual({ kind: "empty" });
    expect(selection.toggle(visit, 1)).toEqual({ kind: "inactive" });
    expect(selection.indicator("B")).toBe(" ");
    return { eligible: true };
  });
  expect(selection.begin(visit)).toEqual({ kind: "changed" });
  expect(selection.targets(visit)).toMatchObject({ revisionIds: ["A"] });
  expect(controller.getOperationTargets()).toMatchObject({ revisionIds: ["A"] });
  expect(selection.indicator("A")).toBe("✓");
  expect(selection.indicator("B")).toBe(" ");
  selection.end(visit);
  await controller.close();
});

test("operation endpoint highlighting retains range and current geometry without logical retargeting", async () => {
  const { runtime } = createTestRuntime([
    { revisionId: "A", logicalId: "same" },
    { revisionId: "B", logicalId: "same" },
    { revisionId: "C", logicalId: "other" },
  ]);
  const controller = new LogController(runtime);
  try {
    await controller.loadMore();
    await controller.loadMore();
    await controller.select(2, 10);
    await controller.select(1, 10, { extend: true });
    const anchor = controller.getSnapshot().selectionAnchor;
    expect(controller.highlightLoadedRevision("A")).toBe(true);
    expect(controller.getSnapshot().selected).toBe(0);
    expect(controller.getSnapshot().selectionAnchor).toBe(anchor);
    expect(controller.highlightLoadedRevision("absent")).toBe(false);
    expect(controller.getSnapshot().selected).toBe(0);
  } finally {
    await controller.close();
  }
});

test("actual removed pre-refresh identities cannot survive as logical replacements", async () => {
  const { runtime, setHistory } = createTestRuntime([
    { revisionId: "A", logicalId: "a" },
    { revisionId: "B", logicalId: "b" },
  ]);
  const controller = new LogController(runtime);
  try {
    await controller.loadMore();
    controller.toggleMark(0);
    controller.toggleMark(1);
    setHistory([
      { revisionId: "A2", logicalId: "a" },
      { revisionId: "B2", logicalId: "b" },
    ]);
    expect(await controller.refreshAfterMutation(() => true, ["A"])).toBe(true);
    expect(controller.getSnapshot().marks.map((m) => m.mark.revisionId)).toEqual(["B2"]);
  } finally {
    await controller.close();
  }
});

describe("LogController native graph switching", () => {
  test("shows notice on a provider that does not support openGraph", async () => {
    const { runtime } = createTestRuntime(["c1", "c2"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    expect(controller.getSnapshot().supportsNativeGraph).toBeFalse();
    controller.toggleNativeGraph();
    expect(controller.getSnapshot().notice).toBe(
      "Graph view (jj style) is available only for JJ history.",
    );
    await controller.close();
  });

  test("stages and adopts native graph style", async () => {
    const { runtime } = createTestRuntime(["c1", "c2"]);
    (runtime.source as any).graphStyle = "default";
    (runtime.source as any).graphSnapshotId = "snap-1";
    (runtime.source as any).openGraph = async (style: string) => {
      expect(style).toBe("native");
      return {
        graphStyle: "native",
        graphSnapshotId: "snap-1",
        async read() {
          return {
            commits: [
              {
                revisionId: "c1",
                displayId: "c1",
                parentRevisionIds: [],
                subject: "c1",
                authorName: "Ada",
                authoredAt: "2026-01-01T00:00:00Z",
                decorations: [],
                nativeGraph: { body: ["@  ", "│  ", "│  "], after: [] },
              },
              {
                revisionId: "c2",
                displayId: "c2",
                parentRevisionIds: [],
                subject: "c2",
                authorName: "Ada",
                authoredAt: "2026-01-01T00:00:00Z",
                decorations: [],
                nativeGraph: { body: ["○  ", "│  ", "│  "], after: [] },
              },
            ],
            done: true,
          };
        },
        async close() {},
      };
    };

    const controller = new LogController(runtime);
    controller.togglePresentation("graph");
    await controller.loadMore();
    expect(controller.getSnapshot().supportsNativeGraph).toBeTrue();
    expect(controller.getSnapshot().graphStyle).toBe("default");

    controller.toggleNativeGraph();
    expect(controller.getSnapshot().stagingGraph).toBeTrue();
    expect(controller.getSnapshot().notice).toBe("Switching graph… Esc cancel");

    // Wait for staging to complete
    await new Promise((r) => setTimeout(r, 20));

    expect(controller.getSnapshot().stagingGraph).toBeFalse();
    expect(controller.getSnapshot().graphStyle).toBe("native");
    expect(controller.getSnapshot().graphPreference).toBe("native");
    expect(controller.getSnapshot().rows[0]!.commit.nativeGraph).toBeDefined();

    await controller.close();
  });

  test("canceling staging with cancelStagingGraph restores state", async () => {
    const { runtime } = createTestRuntime(["c1", "c2"]);
    let releaseCandidate!: () => void;
    const gate = new Promise<void>((resolve) => (releaseCandidate = resolve));
    (runtime.source as any).graphStyle = "default";
    (runtime.source as any).graphSnapshotId = "snap-1";
    (runtime.source as any).openGraph = async () => {
      await gate;
      return {
        graphStyle: "native",
        graphSnapshotId: "snap-1",
        async read() {
          return { commits: [], done: true };
        },
        async close() {},
      };
    };

    const controller = new LogController(runtime);
    controller.togglePresentation("graph");
    await controller.loadMore();

    controller.toggleNativeGraph();
    expect(controller.getSnapshot().stagingGraph).toBeTrue();
    expect(controller.getSnapshot().notice).toBe("Switching graph… Esc cancel");

    controller.cancelStagingGraph();
    expect(controller.getSnapshot().stagingGraph).toBeFalse();
    expect(controller.getSnapshot().graphStyle).toBe("default");
    expect(controller.getSnapshot().graphPreference).toBe("default");

    releaseCandidate();
    await new Promise((r) => setTimeout(r, 20));
    expect(controller.getSnapshot().graphStyle).toBe("default");

    await controller.close();
  });

  test("refuses graph switch when selection is outside limit", async () => {
    const { runtime } = createTestRuntime(["c1", "c2", "c3"]);
    (runtime.source as any).graphStyle = "default";
    (runtime.source as any).graphSnapshotId = "snap-1";
    (runtime.source as any).openGraph = async () => ({
      graphStyle: "native",
      graphSnapshotId: "snap-1",
      async read() {
        return {
          commits: [
            {
              revisionId: "c1",
              displayId: "c1",
              parentRevisionIds: [],
              subject: "c1",
              authorName: "Ada",
              authoredAt: "2026-01-01T00:00:00Z",
              decorations: [],
              nativeGraph: { body: ["@  ", "│  ", "│  "], after: [] },
            },
          ],
          done: true,
        };
      },
      async close() {},
    });

    const controller = new LogController(runtime);
    controller.togglePresentation("graph");
    await controller.loadMore();
    await controller.select(2, 20);
    expect(controller.getSnapshot().selected).toBe(2);

    controller.toggleNativeGraph();
    await new Promise((r) => setTimeout(r, 20));

    expect(controller.getSnapshot().stagingGraph).toBeFalse();
    expect(controller.getSnapshot().graphStyle).toBe("default");
    expect(controller.getSnapshot().notice).toBe(
      "Cannot switch graph: selection is outside the history limit. Reopen with a higher --max-count.",
    );

    await controller.close();
  });

  test("refuses graph switch when marked revision is outside limit", async () => {
    const { runtime } = createTestRuntime(["c1", "c2", "c3"]);
    (runtime.source as any).graphStyle = "default";
    (runtime.source as any).graphSnapshotId = "snap-1";
    (runtime.source as any).openGraph = async () => ({
      graphStyle: "native",
      graphSnapshotId: "snap-1",
      async read() {
        return {
          commits: [
            {
              revisionId: "c1",
              displayId: "c1",
              parentRevisionIds: [],
              subject: "c1",
              authorName: "Ada",
              authoredAt: "2026-01-01T00:00:00Z",
              decorations: [],
              nativeGraph: { body: ["@  ", "│  ", "│  "], after: [] },
            },
          ],
          done: true,
        };
      },
      async close() {},
    });

    const controller = new LogController(runtime);
    controller.togglePresentation("graph");
    await controller.loadMore();
    await controller.loadMore();
    controller.toggleMark(2);
    expect(controller.getSnapshot().marks).toHaveLength(1);

    controller.toggleNativeGraph();
    await new Promise((r) => setTimeout(r, 20));

    expect(controller.getSnapshot().stagingGraph).toBeFalse();
    expect(controller.getSnapshot().graphStyle).toBe("default");
    expect(controller.getSnapshot().notice).toBe(
      "Cannot switch graph: marked revisions are outside the history limit. Clear the marks or reopen with a higher --max-count.",
    );

    await controller.close();
  });

  test("refuses graph switch when range membership would change", async () => {
    const { runtime } = createTestRuntime(["c1", "c2", "c3"]);
    (runtime.source as any).graphStyle = "default";
    (runtime.source as any).graphSnapshotId = "snap-1";
    (runtime.source as any).openGraph = async () => ({
      graphStyle: "native",
      graphSnapshotId: "snap-1",
      async read() {
        return {
          commits: [
            {
              revisionId: "c1",
              displayId: "c1",
              parentRevisionIds: [],
              subject: "c1",
              authorName: "Ada",
              authoredAt: "2026-01-01T00:00:00Z",
              decorations: [],
              nativeGraph: { body: ["@  ", "│  ", "│  "], after: [] },
            },
            {
              revisionId: "different",
              displayId: "diff",
              parentRevisionIds: [],
              subject: "different",
              authorName: "Ada",
              authoredAt: "2026-01-01T00:00:00Z",
              decorations: [],
              nativeGraph: { body: ["○  ", "│  ", "│  "], after: [] },
            },
            {
              revisionId: "c3",
              displayId: "c3",
              parentRevisionIds: [],
              subject: "c3",
              authorName: "Ada",
              authoredAt: "2026-01-01T00:00:00Z",
              decorations: [],
              nativeGraph: { body: ["○  ", "│  ", "│  "], after: [] },
            },
          ],
          done: true,
        };
      },
      async close() {},
    });

    const controller = new LogController(runtime);
    controller.togglePresentation("graph");
    await controller.loadMore();
    await controller.select(2, 20, { extend: true });
    expect(controller.getSnapshot().selectionAnchor).toBe(0);
    expect(controller.getSnapshot().selected).toBe(2);

    controller.toggleNativeGraph();
    await new Promise((r) => setTimeout(r, 20));

    expect(controller.getSnapshot().stagingGraph).toBeFalse();
    expect(controller.getSnapshot().graphStyle).toBe("default");
    expect(controller.getSnapshot().notice).toBe(
      "Cannot switch graph: selected range would change. Clear the range and retry.",
    );

    await controller.close();
  });

  test("refuses graph switch and reports notice when config drift is detected", async () => {
    const { runtime } = createTestRuntime(["c1", "c2"]);
    (runtime.source as any).graphStyle = "default";
    (runtime.source as any).graphSnapshotId = "snap-1";
    (runtime.source as any).openGraph = async () => {
      throw new Error("JJ configuration changed between history reads.");
    };

    const controller = new LogController(runtime);
    controller.togglePresentation("graph");
    await controller.loadMore();

    controller.toggleNativeGraph();
    await new Promise((r) => setTimeout(r, 20));

    expect(controller.getSnapshot().stagingGraph).toBeFalse();
    expect(controller.getSnapshot().notice).toBe(
      "JJ configuration changed. Refresh history before switching graph.",
    );

    await controller.close();
  });

  test("late paging failure in native graph mode retains loaded revisions and formats notice", async () => {
    let pageCount = 0;
    const { runtime } = createTestRuntime([]);
    runtime.source = {
      graphStyle: "native",
      graphSnapshotId: "snap-1",
      async read() {
        pageCount += 1;
        if (pageCount === 1) {
          return {
            commits: [
              {
                revisionId: "c1",
                displayId: "c1",
                parentRevisionIds: [],
                subject: "c1",
                authorName: "Ada",
                authoredAt: "2026-01-01T00:00:00Z",
                decorations: [],
                nativeGraph: { body: ["@  ", "│  ", "│  "], after: [] },
              },
            ],
            done: false,
          };
        }
        throw new Error("Disk read failure.");
      },
      async close() {},
    };

    const controller = new LogController(runtime);
    await controller.loadMore();
    expect(controller.getSnapshot().rows).toHaveLength(1);
    expect(controller.getSnapshot().historyDone).toBeFalse();

    const loaded = await controller.loadMore();
    expect(loaded).toBeFalse();
    expect(controller.getSnapshot().rows).toHaveLength(1);
    expect(controller.getSnapshot().historyDone).toBeTrue();
    expect(controller.getSnapshot().notice).toBe(
      "Could not load more history: Disk read failure. Loaded revisions kept.",
    );

    await controller.close();
  });
});

/** Build reopenable graph sources with the same cursor-ownership behavior as bootstrap. */
function createTestGraphRuntime(ids: string[] = ["c1", "c2", "c3"]) {
  const { runtime } = createTestRuntime(ids);
  const sources: (HistoryRuntime["source"] & { closes: number })[] = [];
  const makeSource = (style: "default" | "native", entries = ids) => {
    let done = false;
    const source: HistoryRuntime["source"] & { closes: number } = {
      graphStyle: style,
      graphSnapshotId: "accepted-context",
      closes: 0,
      openGraph: async (next) => makeSource(next),
      async read() {
        if (done) return { commits: [], done: true };
        done = true;
        return {
          commits: entries.map((id) => ({
            revisionId: id,
            displayId: id,
            parentRevisionIds: [],
            subject: id,
            authorName: "Ada",
            authoredAt: "2026-01-01T00:00:00Z",
            decorations: [],
            ...(style === "native"
              ? {
                  nativeGraph: {
                    body: ["@  ", "│  ", "│  "] as [string, string, string],
                    after: ["╰─"],
                  },
                }
              : {}),
          })),
          done: true,
        };
      },
      async close() {
        source.closes++;
      },
    };
    sources.push(source);
    return source;
  };
  runtime.source = makeSource("default");
  runtime.acceptSource = async (next) => {
    const previous = runtime.source;
    runtime.source = next;
    await previous.close();
  };
  runtime.close = async () => {
    await runtime.source.close();
  };
  runtime.reopenSource = async () => makeSource("default");
  return { runtime, sources, makeSource };
}

/** Wait for a graph command's pending transaction to reach its acceptance or refusal. */
async function settleTestGraph(controller: LogController) {
  for (let attempt = 0; controller.getSnapshot().stagingGraph && attempt < 1000; attempt++)
    await Bun.sleep(1);
  expect(controller.getSnapshot().stagingGraph).toBeFalse();
}

describe("native graph accepted transactions", () => {
  test("graph commands select the visible style across grouped, Hunk and native views", async () => {
    const { runtime, sources } = createTestGraphRuntime();
    const c = new LogController(runtime);
    await c.loadMore();
    c.toggleNativeGraph();
    expect(c.getSnapshot()).toMatchObject({
      graphStyle: "default",
      graphPreference: "default",
      presentation: { graph: false },
    });
    await settleTestGraph(c);
    expect(c.getSnapshot()).toMatchObject({
      graphStyle: "native",
      graphPreference: "native",
      presentation: { graph: true },
    });
    c.togglePresentation("graph");
    expect(c.getSnapshot().presentation.graph).toBeTrue();
    await settleTestGraph(c);
    expect(c.getSnapshot()).toMatchObject({
      graphStyle: "default",
      graphPreference: "default",
      presentation: { graph: true },
    });
    c.togglePresentation("graph");
    await settleTestGraph(c);
    expect(c.getSnapshot()).toMatchObject({
      graphStyle: "default",
      graphPreference: "default",
      presentation: { graph: false },
    });
    c.toggleNativeGraph();
    await settleTestGraph(c);
    expect(c.getSnapshot()).toMatchObject({
      graphStyle: "native",
      graphPreference: "native",
      presentation: { graph: true },
    });
    c.toggleNativeGraph();
    await settleTestGraph(c);
    expect(c.getSnapshot()).toMatchObject({
      graphStyle: "default",
      graphPreference: "default",
      presentation: { graph: true },
    });
    await c.close();
    expect(sources.map((s) => s.closes)).toEqual(sources.map(() => 1));
  });

  test("choosing JJ from grouped history ignores a hidden retained native preference", async () => {
    const { runtime } = createTestGraphRuntime();
    const c = new LogController(runtime);
    try {
      await c.loadMore();
      expect(await c.stageGraph("default", { graph: false, preference: "native" })).toBeTrue();
      c.toggleNativeGraph();
      await settleTestGraph(c);
      expect(c.getSnapshot()).toMatchObject({
        graphStyle: "native",
        graphPreference: "native",
        presentation: { graph: true },
      });
    } finally {
      await c.close();
    }
  });

  test("failure/cancel keeps accepted rows, preference and checkboxes; candidate closes once", async () => {
    const { runtime, makeSource } = createTestGraphRuntime();
    const c = new LogController(runtime);
    await c.loadMore();
    const accepted = c.getSnapshot();
    runtime.source.openGraph = async () => {
      throw Error("malformed record");
    };
    expect(await c.stageGraph("native")).toBeFalse();
    expect(c.getSnapshot()).toMatchObject({
      rows: accepted.rows,
      graphStyle: "default",
      graphPreference: "default",
      presentation: accepted.presentation,
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const candidate = makeSource("native");
    runtime.source.openGraph = async () => {
      await gate;
      return candidate;
    };
    const pending = c.stageGraph("native");
    c.cancelStagingGraph();
    release();
    expect(await pending).toBeFalse();
    expect(candidate.closes).toBe(1);
    expect(c.getSnapshot().presentation).toEqual(accepted.presentation);
    await c.close();
  });

  test("latest selected ID, marks and physical offset are sampled after a delayed read", async () => {
    const { runtime, makeSource } = createTestGraphRuntime();
    const c = new LogController(runtime);
    c.togglePresentation("graph");
    await c.loadMore();
    const candidate = makeSource("native");
    const read = candidate.read.bind(candidate);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    candidate.read = async (options) => {
      await gate;
      return read(options);
    };
    runtime.source.openGraph = async () => candidate;
    const pending = c.stageGraph("native");
    await c.select(2, 10);
    c.toggleMark(1);
    const latest = c.getSnapshot();
    release();
    expect(await pending).toBeTrue();
    expect(c.getSelectedRow()?.commit.revisionId).toBe("c3");
    expect(c.getSnapshot().marks).toBe(latest.marks);
    await c.close();
  });

  test("accepted query and refresh obsolete a delayed old graph candidate", async () => {
    for (const replace of ["query", "refresh"] as const) {
      const { runtime, makeSource } = createTestGraphRuntime(["c1"]);
      const c = new LogController(runtime);
      await c.loadMore();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const old = makeSource("native", ["c1", "old-only"]);
      runtime.source.openGraph = async () => {
        await gate;
        return old;
      };
      const pending = c.stageGraph("native");
      const fresh = makeSource("default", ["c1", "new-only"]);
      if (replace === "query") {
        runtime.queryReplacement = {
          open: async () => fresh,
          accept: async (_target, next) => {
            runtime.source = next;
          },
        };
        expect((await c.replaceQuery({ kind: "apply", expression: "new-query" })).status).toBe(
          "applied",
        );
      } else {
        runtime.reopenSource = async () => fresh;
        expect(await c.refresh()).toBeTrue();
      }
      release();
      expect(await pending).toBeFalse();
      expect(c.getSnapshot().rows.map((r) => r.commit.revisionId)).toEqual(["c1", "new-only"]);
      expect(old.closes).toBe(1);
      await c.close();
    }
  });

  test("retains unresolved mark resolution instead of re-running refresh inference", async () => {
    const { runtime, makeSource } = createTestGraphRuntime(["c1", "c2"]);
    runtime.input.maxCount = 2;
    const c = new LogController(runtime);
    await c.loadMore();
    c.toggleMark(1);
    const refreshed = makeSource("default", ["c1", "c3"]);
    runtime.reopenSource = async () => refreshed;
    await c.refresh();
    const marks = c.getSnapshot().marks;
    expect(marks[0]?.kind).toBe("unresolved");
    refreshed.openGraph = async () => makeSource("native", ["c1", "c2"]);
    expect(await c.stageGraph("native")).toBeTrue();
    expect(c.getSnapshot().marks).toBe(marks);
    await c.close();
  });

  test("validates an empty candidate page and retains valid empty state on failure", async () => {
    const { runtime, makeSource } = createTestGraphRuntime([]);
    const c = new LogController(runtime);
    await c.loadMore();
    const candidate = makeSource("native", []);
    let reads = 0;
    candidate.read = async () => {
      reads++;
      throw Error("invalid stream");
    };
    runtime.source.openGraph = async () => candidate;
    expect(await c.stageGraph("native")).toBeFalse();
    expect(reads).toBe(1);
    expect(c.getSnapshot()).toMatchObject({ historyDone: true, graphStyle: "default", rows: [] });
    runtime.source.openGraph = async () => makeSource("native", []);
    expect(await c.stageGraph("native")).toBeTrue();
    expect(c.getSnapshot()).toMatchObject({ historyDone: true, graphStyle: "native", rows: [] });
    await c.close();
  });

  test("native conversion failures close intermediate refresh/query sources", async () => {
    const { runtime, makeSource } = createTestGraphRuntime();
    const c = new LogController(runtime);
    await c.loadMore();
    await c.stageGraph("native");
    const intermediate = () => {
      const s = makeSource("default");
      s.openGraph = async () => {
        throw Error("configuration changed");
      };
      return s;
    };
    const refresh = intermediate();
    runtime.reopenSource = async () => refresh;
    expect(await c.refresh()).toBeFalse();
    expect(refresh.closes).toBe(1);
    const query = intermediate();
    runtime.queryReplacement = { open: async () => query, accept: async () => {} };
    expect((await c.replaceQuery({ kind: "apply", expression: "next" })).status).toBe("failed");
    expect(query.closes).toBe(1);
    expect(c.getSnapshot().graphStyle).toBe("native");
    await c.close();
  });

  test("cleanup failure reports a notice but keeps the accepted native source", async () => {
    const { runtime } = createTestGraphRuntime();
    const c = new LogController(runtime);
    await c.loadMore();
    runtime.source.close = async () => {
      throw Error("old cleanup failed");
    };
    expect(await c.stageGraph("native")).toBeTrue();
    await Bun.sleep(0);
    expect(c.getSnapshot().graphStyle).toBe("native");
    expect(c.getSnapshot().notice).toBe("old cleanup failed");
    await c.close();
  });

  test("native entries scroll through 1–2-row clipped viewports without changing revision targets", async () => {
    for (const height of [1, 2]) {
      const { runtime } = createTestGraphRuntime(["c1"]);
      const c = new LogController(runtime);
      await c.loadMore();
      await c.stageGraph("native");
      expect(
        planLogViewportGeometry({
          rows: c.getSnapshot().rows,
          selected: 0,
          requestedTop: 0,
          bodyHeight: height,
          groupByDay: false,
        }).entries,
      ).toHaveLength(1);
      expect(c.scrollEntry(1, height)).toBeTrue();
      expect(c.getSelectedRow()?.commit.revisionId).toBe("c1");
      expect(c.getSnapshot().entryScroll).toBe(1);
      await c.close();
    }
  });
});

describe("graph cleanup survives transaction completion", () => {
  test("quit joins a cancelled candidate close and repeated quit joins the same promise", async () => {
    const { runtime, makeSource } = createTestGraphRuntime(["c1"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    const candidate = makeSource("native");
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => (releaseRead = resolve));
    const read = candidate.read.bind(candidate);
    candidate.read = async (options) => {
      await readGate;
      return read(options);
    };
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => (releaseClose = resolve));
    let cleanupFinished = false;
    candidate.close = async () => {
      candidate.closes++;
      await closeGate;
      cleanupFinished = true;
    };
    runtime.source.openGraph = async () => candidate;
    const staging = controller.stageGraph("native");
    await Bun.sleep(0);
    controller.cancelStagingGraph();
    let quitFinished = false;
    const quitting = controller.close().then(() => {
      quitFinished = true;
    });
    const repeated = controller.close();
    await Bun.sleep(0);
    expect(quitFinished).toBeFalse();
    expect(candidate.closes).toBe(1);
    releaseClose();
    await Promise.all([quitting, repeated]);
    expect(cleanupFinished).toBeTrue();
    releaseRead();
    expect(await staging).toBeFalse();
    expect(candidate.closes).toBe(1);
  });

  test("quit joins old-source cleanup after native adoption without rolling back", async () => {
    const { runtime } = createTestGraphRuntime(["c1"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    const old = runtime.source;
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => (releaseClose = resolve));
    let cleanupFinished = false;
    old.close = async () => {
      await closeGate;
      cleanupFinished = true;
    };
    expect(await controller.stageGraph("native")).toBeTrue();
    expect(controller.getSnapshot().graphStyle).toBe("native");
    let quitFinished = false;
    const quitting = controller.close().then(() => {
      quitFinished = true;
    });
    await Bun.sleep(0);
    expect(quitFinished).toBeFalse();
    releaseClose();
    await quitting;
    expect(cleanupFinished).toBeTrue();
    expect(controller.getSnapshot().graphStyle).toBe("native");
  });

  test("generic graph failure uses the approved current-view-kept copy", async () => {
    const { runtime } = createTestGraphRuntime(["c1"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    runtime.source.openGraph = async () => {
      throw Error("Reader failed.");
    };
    expect(await controller.stageGraph("native")).toBeFalse();
    expect(controller.getSnapshot().notice).toBe(
      "Could not switch graph: Reader failed. Current view kept.",
    );
    await controller.close();
  });
});

test("graph controls are disabled throughout a pending refresh or query replacement", async () => {
  for (const replacing of ["refresh", "query"] as const) {
    const { runtime, makeSource } = createTestGraphRuntime(["c1"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const open = async () => {
      await gate;
      return makeSource("default");
    };
    runtime.reopenSource = open;
    runtime.queryReplacement = {
      open,
      accept: async (_target, source) => runtime.acceptSource!(source),
    };
    const pending =
      replacing === "refresh"
        ? controller.refresh()
        : controller.replaceQuery({ kind: "apply", expression: "@" });
    expect(controller.getSnapshot().sourceTransitionPending).toBeTrue();
    expect(
      isHistoryCommandEnabled("hunk.history.toggleNativeGraph", controller.getSnapshot()),
    ).toBeFalse();
    expect(
      isHistoryCommandEnabled("hunk.history.toggleGraph", controller.getSnapshot()),
    ).toBeFalse();
    release();
    await pending;
    expect(controller.getSnapshot().sourceTransitionPending).toBeFalse();
    expect(
      isHistoryCommandEnabled("hunk.history.toggleNativeGraph", controller.getSnapshot()),
    ).toBeTrue();
    expect(
      isHistoryCommandEnabled("hunk.history.toggleGraph", controller.getSnapshot()),
    ).toBeTrue();
    await controller.close();
  }
});

test("aborted query cleanup cannot leave an enabled graph command inert", async () => {
  const { runtime, makeSource } = createTestGraphRuntime(["c1"]);
  const controller = new LogController(runtime);
  await controller.loadMore();
  const candidate = makeSource("default");
  candidate.read = async ({ signal }) =>
    new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(Error("aborted")), { once: true });
    });
  let releaseClose!: () => void;
  const closeGate = new Promise<void>((resolve) => (releaseClose = resolve));
  candidate.close = async () => {
    candidate.closes++;
    await closeGate;
  };
  runtime.queryReplacement = { open: async () => candidate, accept: async () => {} };
  const abort = new AbortController();
  const query = controller.replaceQuery({ kind: "apply", expression: "@" }, abort.signal);
  await Bun.sleep(0);
  abort.abort();
  await Bun.sleep(0);
  controller.toggleMark();
  expect(controller.getSnapshot().sourceTransitionPending).toBeFalse();
  expect(
    isHistoryCommandEnabled("hunk.history.toggleNativeGraph", controller.getSnapshot()),
  ).toBeTrue();
  expect(await controller.stageGraph("native")).toBeTrue();
  expect(controller.getSnapshot().graphStyle).toBe("native");
  releaseClose();
  expect(await query).toMatchObject({ status: "aborted" });
  expect(candidate.closes).toBe(1);
  await controller.close();
});
