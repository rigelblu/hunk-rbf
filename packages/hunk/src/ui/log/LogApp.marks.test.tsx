import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { createTestExtensionSession } from "../../../../../test/helpers/extension-session";
import { persistedViewPreferencesFromOptions } from "../../core/run/config";
import { createInteractiveSessionInitialization } from "../../core/session/initialization";
import type { InteractiveHistoryRuntime } from "../history/types";
import { ThemeController } from "../theme/controller";
import { LogApp } from "./LogApp";
import { LogController } from "./controller";

type TestHarness = Awaited<ReturnType<typeof testRender>>;

/** Settle React and terminal row layout after one test gesture. */
async function flushTestFrame(setup: TestHarness) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
  return setup.captureCharFrame();
}

/** Find actual rendered cells rather than assuming footer or dialog offsets. */
async function clickTestText(setup: TestHarness, text: string) {
  const lines = (await flushTestFrame(setup)).split("\n");
  const y = lines.findIndex((line) => line.includes(text));
  if (y < 0) throw new Error(`Missing ${text}:\n${lines.join("\n")}`);
  await act(async () => setup.mockMouse.click(lines[y]!.indexOf(text), y));
  return flushTestFrame(setup);
}

/** Render history marks with a real terminal renderer and deterministic clipboard capability. */
async function createTestMarkedHistory({
  width = 120,
  height = 20,
  count = 12,
  clipboard = true,
  remap = false,
  marked = true,
  cutoffParents = [],
}: {
  width?: number;
  height?: number;
  count?: number;
  clipboard?: boolean;
  remap?: boolean;
  marked?: boolean;
  cutoffParents?: string[];
} = {}) {
  let refreshFailure = false;
  let commits = Array.from({ length: count }, (_, i) => ({
    revisionId: `${String(i).padStart(8, "0")}${"abcdef".repeat(6)}`,
    displayId: String(i).padStart(8, "0"),
    // Hidden parents of the last revision produce the bounded-history cutoff markers below it.
    parentRevisionIds: i === count - 1 ? cutoffParents : [],
    ...(i === count - 1 && cutoffParents.length
      ? { graphCutoffParentRevisionIds: cutoffParents }
      : {}),
    subject: `Retained mark ${i}`,
    authorName: "Test",
    authoredAt: "2026-10-11T00:00:00Z",
    decorations: [],
  }));
  const originalIds = commits.map((commit) => commit.revisionId);
  const makeSource = () => {
    const contents = commits;
    return { read: async () => ({ commits: contents, done: true }), close: async () => {} };
  };
  const preferences = persistedViewPreferencesFromOptions({});
  const runtime: InteractiveHistoryRuntime = {
    input: {
      kind: "history",
      color: "never",
      format: "compact",
      ascii: false,
      static: false,
      extensionsEnabled: false,
      extensionPaths: [],
    },
    source: makeSource(),
    providerId: "test",
    providerName: "Test",
    repoRoot: "test-repo",
    notices: [],
    customThemes: [],
    keybindings: remap ? { "hunk.history.toggleMark": "m" } : {},
    initialViewPreferences: preferences,
    promptSaveViewPreferences: false,
    extensionSession: createTestExtensionSession(),
    initialization: createInteractiveSessionInitialization({
      theme: {},
      viewPreferences: preferences,
    }),
    planReview: async (commit) => ({ kind: "revision-show", revisionId: commit.revisionId }),
    reopenSource: async () => {
      if (refreshFailure) throw new Error("Test refresh failure");
      return makeSource();
    },
    close: async () => {},
  };
  const controller = new LogController(runtime);
  await controller.loadMore();
  if (marked) for (let i = 0; i < count; i++) controller.toggleMark(i);
  const setup = await testRender(
    <LogApp
      controller={controller}
      runtime={runtime}
      onOutcome={() => {}}
      sessionViewPreferences={preferences}
      autoRefreshEnabled={false}
      onAutoRefreshEnabledChange={() => {}}
      refreshOnMountGeneration={0}
      themeController={new ThemeController({})}
      useColor={false}
    />,
    { width, height },
  );
  const copied: string[] = [];
  setup.renderer.isOsc52Supported = () => clipboard;
  setup.renderer.copyToClipboardOSC52 = (text) => {
    copied.push(text);
    return true;
  };
  await flushTestFrame(setup);
  return {
    setup,
    copied,
    controller,
    originalIds,
    failRefresh: () => {
      refreshFailure = true;
    },
    removeHistory: () => {
      commits = [];
    },
    close: async () => {
      await controller.close();
      await act(async () => setup.renderer.destroy());
      await runtime.extensionSession.shutdown();
    },
  };
}

test("recovery windows retain visible keyboard focus and copy full original IDs without pointer focus changes", async () => {
  const fixture = await createTestMarkedHistory({ height: 18 });
  const { setup, controller, copied, originalIds } = fixture;
  try {
    fixture.removeHistory();
    await act(async () => {
      await controller.refresh();
    });
    expect(await flushTestFrame(setup)).toContain("No commits");
    let frame = await clickTestText(setup, "Review marks");
    expect(frame).toContain("> 00000000");
    expect(frame).toContain("1–3 of 12");
    await clickTestText(setup, "00000001");
    expect(copied.at(-1)).toBe(originalIds[1]);
    expect(await flushTestFrame(setup)).toContain("> 00000000");
    await act(async () => setup.mockInput.pressKey("y"));
    await flushTestFrame(setup);
    expect(copied.at(-1)).toBe(originalIds[0]);
    await act(async () => setup.mockInput.pressKey("\x1b[6~"));
    frame = await flushTestFrame(setup);
    expect(frame).toContain("> 00000003");
    expect(frame).toContain("Retained mark 3");
    await act(async () => setup.mockInput.pressKey("y"));
    await flushTestFrame(setup);
    expect(copied.at(-1)).toBe(originalIds[3]);
    for (let i = 0; i < 12; i++) await act(async () => setup.mockInput.pressKey("ARROW_DOWN"));
    frame = await flushTestFrame(setup);
    expect(frame).toContain("> 00000011");
    expect(frame).toContain("10–12 of 12");
    await act(async () => setup.mockInput.pressKey("\x1b[5~"));
    expect(await flushTestFrame(setup)).toContain("> 00000008");
    expect(controller.getSnapshot().marks).toHaveLength(12);
  } finally {
    await fixture.close();
  }
});

test("unavailable clipboard preserves recovery and marks, and reports the exact notice", async () => {
  const fixture = await createTestMarkedHistory({ clipboard: false, count: 2 });
  try {
    fixture.removeHistory();
    await act(async () => {
      await fixture.controller.refresh();
    });
    await clickTestText(fixture.setup, "Review marks");
    await act(async () => fixture.setup.mockInput.pressKey("y"));
    const frame = await flushTestFrame(fixture.setup);
    expect(frame).toContain("Clipboard is unavailable in this terminal.");
    expect(frame).toContain("These marks could not be matched to history.");
    expect(frame).toContain("Remove unresolved marks");
    expect(frame).toContain("> 00000000");
    expect(fixture.controller.getSnapshot().marks).toHaveLength(2);
    expect(fixture.copied).toEqual([]);
  } finally {
    await fixture.close();
  }
});

for (const width of [42, 60, 80, 120])
  test(`short recovery retains an original identity and reachable removal at ${width} columns`, async () => {
    const fixture = await createTestMarkedHistory({ width, height: 12, count: 2 });
    try {
      fixture.removeHistory();
      await act(async () => {
        await fixture.controller.refresh();
      });
      let frame = await clickTestText(fixture.setup, "Review marks");
      expect(frame).toContain("> 00000000");
      expect(frame).toContain("Retained mark 0");
      await act(async () => fixture.setup.mockInput.pressKey("ARROW_DOWN"));
      frame = await flushTestFrame(fixture.setup);
      expect(frame).toContain("> 00000001");
      await act(async () => fixture.setup.mockInput.pressKey("r"));
      await flushTestFrame(fixture.setup);
      expect(fixture.controller.getSnapshot().marks).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

test("persistent range and mark counts survive notices, and remapped marking reaches the live controller", async () => {
  const fixture = await createTestMarkedHistory({ count: 3, remap: true });
  try {
    await act(async () => {
      fixture.controller.beginVisualSelection();
      await fixture.controller.move(1, 17, { extend: true });
      fixture.controller.setNotice("Refresh notice");
    });
    let frame = await flushTestFrame(fixture.setup);
    expect(frame).toContain("2 in review range");
    expect(frame).toContain("3 marked");
    expect(frame).toContain("Refresh notice");
    await act(async () => fixture.setup.mockInput.pressKey("x"));
    await flushTestFrame(fixture.setup);
    expect(fixture.controller.getSnapshot().marks).toHaveLength(3);
    await act(async () => fixture.setup.mockInput.pressKey("m"));
    frame = await flushTestFrame(fixture.setup);
    expect(frame).toContain("2 marked");
    expect(fixture.controller.getSnapshot().selected).toBe(1);
  } finally {
    await fixture.close();
  }
});

test("failed refresh preserves readable persistent guidance at 80 columns", async () => {
  const fixture = await createTestMarkedHistory({ width: 80, count: 2 });
  try {
    fixture.failRefresh();
    await act(async () => {
      await fixture.controller.refresh();
    });
    const frame = await flushTestFrame(fixture.setup);
    expect(frame).toContain(
      "2 marked · Marks could not be checked. Refresh history or clear selection.",
    );
    expect(fixture.controller.getOperationTargets().kind).toBe("blocked");
    await clickTestText(fixture.setup, "2 marked");
    expect(await flushTestFrame(fixture.setup)).toContain("Review marks");
  } finally {
    await fixture.close();
  }
});

for (const graph of [false, true])
  test(`cutoff markers below a revision are not markable in ${graph ? "graph" : "grouped"} history`, async () => {
    const fixture = await createTestMarkedHistory({
      width: 80,
      count: 2,
      marked: false,
      cutoffParents: ["hidden-a", "hidden-b"],
    });
    const { setup, controller, originalIds } = fixture;
    try {
      if (graph) await act(async () => controller.togglePresentation("graph"));
      const lines = (await flushTestFrame(setup)).split("\n");
      const revisionRows = lines.flatMap((line, y) => (line.includes("[ ] ") ? [y] : []));
      const cutoffRows = lines.flatMap((line, y) => (line.trim().startsWith("~") ? [y] : []));
      expect(revisionRows).toHaveLength(2);
      expect(cutoffRows).toHaveLength(2);
      const checkboxX = lines[revisionRows[1]!]!.indexOf("[ ] ");
      // The first hidden parent continues the revision's own lane, after the focus and mark cells.
      expect(lines[cutoffRows[0]!]!.indexOf("~")).toBe(checkboxX + 4);
      for (const y of cutoffRows) {
        expect(lines[y]).not.toContain("[");
        await act(async () => setup.mockMouse.click(checkboxX + 1, y));
        await act(async () => setup.mockMouse.click(lines[y]!.indexOf("~"), y));
        await act(async () =>
          setup.mockMouse.click(checkboxX + 1, y, 0, { modifiers: { ctrl: true } }),
        );
      }
      await flushTestFrame(setup);
      expect(controller.getSnapshot().marks).toEqual([]);
      expect(controller.getSnapshot().selected).toBe(0);

      await act(async () => setup.mockMouse.click(checkboxX + 1, revisionRows[1]!));
      const marked = (await flushTestFrame(setup)).split("\n");
      expect(controller.getSnapshot().marks.map((entry) => entry.mark.revisionId)).toEqual([
        originalIds[1]!,
      ]);
      expect(marked.filter((line) => line.includes("[x] "))).toHaveLength(1);
      expect(marked[revisionRows[1]!]).toContain("[x] ");
      for (const y of cutoffRows) expect(marked[y]!.trim().startsWith("~")).toBeTrue();
      expect(marked.join("\n")).toContain("1 marked");
    } finally {
      await fixture.close();
    }
  });

type TestHistoryScope = InteractiveHistoryRuntime["source"]["scope"];
type TestScopedEntry = { id: string; change: string };

/**
 * Render history with auto-refresh on. Each return from review re-runs the auto-refresh start,
 * which refreshes the controller with no key press, as a watched repository change does.
 */
async function createTestAutoRefreshedHistory(
  initial: TestScopedEntry[],
  initialScope: TestHistoryScope,
) {
  let entries = initial;
  let scope = initialScope;
  let reopened = 0;
  const makeSource = () => {
    const commits = entries.map(({ id, change }) => ({
      revisionId: id,
      displayId: id,
      parentRevisionIds: [],
      subject: `Subject ${id}`,
      logicalId: change,
      authorName: "Test",
      authoredAt: "2026-10-11T00:00:00Z",
      decorations: [],
    }));
    return {
      ...(scope ? { scope } : {}),
      read: async () => ({ commits, done: true }),
      close: async () => {},
    };
  };
  const preferences = persistedViewPreferencesFromOptions({});
  const runtime: InteractiveHistoryRuntime = {
    input: {
      kind: "history",
      color: "never",
      format: "compact",
      ascii: false,
      static: false,
      extensionsEnabled: false,
      extensionPaths: [],
    },
    source: makeSource(),
    providerId: "test",
    providerName: "Test",
    repoRoot: "test-repo",
    notices: [],
    customThemes: [],
    keybindings: {},
    initialViewPreferences: preferences,
    promptSaveViewPreferences: false,
    extensionSession: createTestExtensionSession(),
    initialization: createInteractiveSessionInitialization({
      theme: {},
      viewPreferences: preferences,
    }),
    historyWatchPlan: { coverage: "poll-only", targets: [] },
    historyWatchSignature: () => "unchanged",
    planReview: async (commit) => ({ kind: "revision-show", revisionId: commit.revisionId }),
    reopenSource: async () => {
      reopened += 1;
      return makeSource();
    },
    close: async () => {},
  };
  const controller = new LogController(runtime);
  await controller.loadMore();
  let returnFromReview = () => {};
  /** Own the remount generation the session host bumps when a review closes. */
  function TestHistoryHost() {
    const [generation, setGeneration] = useState(0);
    returnFromReview = () => setGeneration((value) => value + 1);
    return (
      <LogApp
        controller={controller}
        runtime={runtime}
        onOutcome={() => {}}
        sessionViewPreferences={preferences}
        autoRefreshEnabled
        onAutoRefreshEnabledChange={() => {}}
        refreshOnMountGeneration={generation}
        themeController={new ThemeController({})}
        useColor={false}
      />
    );
  }
  const setup = await testRender(<TestHistoryHost />, { width: 100, height: 18 });
  await flushTestFrame(setup);
  return {
    setup,
    controller,
    /** Change what the provider reports, then let auto-refresh pick it up unprompted. */
    autoRefreshTo: async (next: TestScopedEntry[], nextScope: TestHistoryScope) => {
      entries = next;
      scope = nextScope;
      const before = reopened;
      await act(async () => returnFromReview());
      for (
        let attempt = 0;
        attempt < 100 && (reopened === before || controller.getSnapshot().markStatus !== "ready");
        attempt += 1
      )
        await flushTestFrame(setup);
      expect(reopened).toBe(before + 1);
      return flushTestFrame(setup);
    },
    close: async () => {
      await controller.close();
      await act(async () => setup.renderer.destroy());
      await runtime.extensionSession.shutdown();
    },
  };
}

test("auto-refresh keeps a mark left behind by a moved bound unchecked on every unprompted refresh", async () => {
  const fixture = await createTestAutoRefreshedHistory(
    [
      { id: "c1", change: "k" },
      { id: "c3", change: "k" },
      { id: "T1", change: "t1" },
    ],
    { kind: "bounded", boundaryRevisionId: "T1" },
  );
  const { setup, controller } = fixture;
  try {
    await act(async () => {
      controller.toggleMark(0);
    });
    expect(await flushTestFrame(setup)).toContain("1 marked");
    for (let refresh = 0; refresh < 3; refresh += 1) {
      const frame = await fixture.autoRefreshTo(
        [
          { id: "c3", change: "k" },
          { id: "T2", change: "t2" },
        ],
        { kind: "bounded", boundaryRevisionId: "T2" },
      );
      expect(controller.getSnapshot().marks).toMatchObject([
        { kind: "unresolved", reason: "incomplete", mark: { revisionId: "c1" } },
      ]);
      expect(controller.getOperationTargets()).toMatchObject({
        kind: "blocked",
        reason: "unresolved",
      });
      expect(frame).toContain("1 marked · 1 unresolved");
      // The divergent copy on screen never takes over the mark.
      expect(frame).not.toContain("[x]");
    }
    const dialog = await clickTestText(setup, "Review marks");
    expect(dialog).toContain("c1");
    expect(dialog).toContain("Incomplete history");
    expect(dialog).not.toContain("Missing");
    expect(dialog).not.toContain("Ambiguous");
  } finally {
    await fixture.close();
  }
});
