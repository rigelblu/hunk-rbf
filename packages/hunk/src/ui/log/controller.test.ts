import { describe, expect, test } from "bun:test";
import { createTestExtensionSession } from "../../../../../test/helpers/extension-session";
import { persistedViewPreferencesFromOptions } from "../../core/run/config";
import type { HistoryRuntime } from "../history/types";
import { LogController } from "./controller";

type TestHistoryEntry = string | { revisionId: string; subject?: string; logicalId?: string };

function createRuntime(
  subjects: TestHistoryEntry[] = ["first", "second", "third"],
  notices: readonly string[] = [],
) {
  let historyEntries = subjects;
  let cursor = 0;
  let closeCount = 0;
  const makeSource = () => ({
    async read({ limit }: { limit: number; signal?: AbortSignal }) {
      const selected = historyEntries.slice(cursor, cursor + Math.min(limit, 2));
      cursor += selected.length;
      return {
        commits: selected.map((entry) => {
          const commit = typeof entry === "string" ? { revisionId: entry, subject: entry } : entry;
          return {
            revisionId: commit.revisionId,
            displayId: commit.revisionId.slice(0, 8),
            parentRevisionIds: [],
            subject: commit.subject ?? commit.revisionId,
            ...(commit.logicalId ? { logicalId: commit.logicalId } : {}),
            authorName: "Ada",
            authoredAt: "2026-01-01T00:00:00Z",
            decorations: [],
          };
        }),
        done: cursor >= historyEntries.length,
      };
    },
    async close() {},
  });
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
      cursor = 0;
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
    const { runtime } = createRuntime(undefined, [
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
    const { runtime } = createRuntime();
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
      const { runtime } = createRuntime();
      const controller = new LogController(runtime);
      expect(controller.getSnapshot().presentation.unicode).toBe(false);
      await controller.close();
    } finally {
      if (previous === undefined) delete process.env.TERM;
      else process.env.TERM = previous;
    }
  });

  test("loads enough bounded pages for responsive navigation", async () => {
    const { runtime } = createRuntime(["one", "two", "three", "four", "five"]);
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
    const { runtime } = createRuntime(["one", "two", "three", "four", "five"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    await controller.loadMore();
    await controller.halfPage(1, 10);
    expect(controller.getSnapshot().selected).toBe(1);
    await controller.halfPage(1, 10);
    expect(controller.getSnapshot().selected).toBe(2);
    await controller.halfPage(-1, 10);
    expect(controller.getSnapshot().selected).toBe(1);
    await controller.close();
  });

  test("preserves rapid navigation targets while bounded continuation is loading", async () => {
    const { runtime } = createRuntime(["one", "two", "three", "four"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    await Promise.all([controller.move(1, 1), controller.move(1, 1), controller.move(1, 1)]);
    expect(controller.getSnapshot().selected).toBe(3);
    await controller.close();
  });

  test("extends, shrinks, reverses, and collapses an inclusive range", async () => {
    const { runtime } = createRuntime(["one", "two", "three", "four"]);
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
    const { runtime } = createRuntime(["one", "two", "three", "four"]);
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
      const { runtime } = createRuntime(["one", "two", "three"]);
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
    const { runtime } = createRuntime(["one", "two", "three"]);
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
    const { runtime } = createRuntime(["one", "two", "three"]);
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
    const { runtime } = createRuntime(["one", "two", "three", "four"]);
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
    const { runtime, setHistory } = createRuntime([
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
    const { runtime, setHistory } = createRuntime([
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
    const { runtime, setHistory } = createRuntime([
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
    const { runtime } = createRuntime(["one", "two", "three"]);
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
    const { runtime } = createRuntime(["one", "two", "three"]);
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
    expect(controller.getSnapshot().rows).toHaveLength(2);
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
    const { runtime } = createRuntime(["one"]);
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
    const { runtime } = createRuntime(["one", "two", "three"]);
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
    const { runtime } = createRuntime(["one", "two", "three", "four"]);
    const controller = new LogController(runtime);
    await controller.loadMore();
    await controller.select(2, 8);
    expect(controller.getSnapshot().top).toBe(1);
    controller.setSearch("four");
    await controller.findMatch(1, 8);
    expect(controller.getSnapshot()).toMatchObject({ selected: 3, top: 2 });
    await controller.refresh();
    expect(
      controller.getSnapshot().rows[controller.getSnapshot().selected]?.commit.revisionId,
    ).toBe("four");
    expect(controller.getSnapshot().selected - controller.getSnapshot().top).toBe(1);
    await controller.close();
  });

  test("closes a replacement cursor when quit wins a refresh race", async () => {
    let resolveReplacement!: (source: HistoryRuntime["source"]) => void;
    let replacementCloseCount = 0;
    let reopenSignal: AbortSignal | undefined;
    const { runtime } = createRuntime(["one"]);
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
    const { runtime } = createRuntime(["one", "two"]);
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
    const { runtime, closeCount } = createRuntime(["first"]);
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
    const { runtime, setHistory } = createRuntime(entries);
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
    const { runtime } = createRuntime(["one", "two", "three", "four", "five"]);
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
    const { runtime } = createRuntime(["one", "two", "three", "four", "five"]);
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
    const { runtime } = createRuntime(["one", "two", "three", "four"]);
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
    const { runtime } = createRuntime(["first", "second"]);
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
    const { runtime } = createRuntime(["first", "second"]);
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
