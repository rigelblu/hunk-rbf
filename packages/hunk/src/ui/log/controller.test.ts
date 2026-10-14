import { describe, expect, test } from "bun:test";
import { createTestExtensionSession } from "../../../../../test/helpers/extension-session";
import { persistedViewPreferencesFromOptions } from "../../core/run/config";
import type { HistoryRuntime } from "../history/types";
import { LogController } from "./controller";
import type { HistoryCommit } from "../../core/history/types";
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
