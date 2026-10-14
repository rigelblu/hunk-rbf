import { expect, test } from "bun:test";
import { MouseButton } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { createTestExtensionSession } from "../../../../../test/helpers/extension-session";
import { persistedViewPreferencesFromOptions } from "../../core/run/config";
import { createInteractiveSessionInitialization } from "../../core/session/initialization";
import type {
  ExtensionVcsMutationPrepared,
  ExtensionVcsMutationRequest,
} from "../../extension-api/types";
import type { InteractiveHistoryRuntime } from "../history/types";
import { ThemeController } from "../theme/controller";
import { LogApp, type LogAppOutcome } from "./LogApp";
import { LogController } from "./controller";
import type { HistoryMutationModalFrame } from "./mutationFlow";
import { HistoryMutationFlowController } from "./HistoryMutationFlowController";

/** Settle controller input, React commits and terminal geometry after a gesture. */
async function flushTestFrame(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
  return setup.captureCharFrame();
}
/** Mount the actual production log/operation UI while replacing only its provider boundary. */
async function createTestOperationHistory(
  width = 80,
  height = 24,
  count = 12,
  immutableDestination = false,
) {
  let refreshFailure = false;
  let commits = Array.from({ length: count }, (_, index) => ({
    revisionId: `${String(index + 1).repeat(8)}${"a".repeat(32)}`,
    displayId: String(index + 1).repeat(8),
    logicalId: `change-${index}`,
    isImmutable: immutableDestination && index === 1,
    parentRevisionIds: [],
    subject: `History subject ${index}`,
    authorName: "Test",
    authoredAt: "2026-10-14T00:00:00Z",
    decorations: [],
  }));
  const originalIds = commits.map((commit) => commit.revisionId);
  const makeSource = () => {
    const entries = [...commits];
    return { read: async () => ({ commits: entries, done: true }), close: async () => {} };
  };
  const preferences = persistedViewPreferencesFromOptions({});
  const outcomes: LogAppOutcome[] = [];
  const applied: string[] = [];
  const prepared = (request: ExtensionVcsMutationRequest): ExtensionVcsMutationPrepared => ({
    handleId: "test-preview",
    request,
    facts: {
      providerVersion: "test",
      operationId: "observed",
      files: { kind: "clean" },
      revisions: commits.slice(0, 2).map((commit) => ({
        revisionId: commit.revisionId,
        logicalId: commit.logicalId,
        parents: [],
        description: commit.subject,
        isEmpty: false,
        hasConflict: false,
        isDivergent: false,
        isWorkingCopy: false,
        isImmutable: false,
        isRoot: false,
        bookmarks: [],
      })),
    },
    projection: { headline: "Test provider preview", named: [], notes: [], warnings: [] },
    isInteractive: false,
  });
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
    planReview: async (commit) => ({ kind: "revision-show", revisionId: commit.revisionId }),
    reopenSource: async () => {
      if (refreshFailure) throw new Error("Test refresh failure");
      return makeSource();
    },
    close: async () => {},
    mutations: {
      availability: async () => ({
        kind: "supported",
        providerVersion: "test",
        kinds: ["squash", "rebase"],
      }),
      prepare: async (request) => ({ kind: "ready", prepared: prepared(request) }),
      apply: async (handle) => {
        applied.push(handle);
        return { kind: "not-run", reason: "start-failed", text: "Test process did not start" };
      },
      dispose: async () => {},
    },
  };
  const controller = new LogController(runtime);
  await controller.loadMore();
  const flow = new HistoryMutationFlowController(controller, runtime.mutations);
  const setup = await testRender(
    <LogApp
      controller={controller}
      runtime={runtime}
      mutationFlow={flow}
      onOutcome={(outcome) => {
        outcomes.push(outcome);
        if (outcome.kind === "open-review" && outcome.inspectionToken)
          flow.finishInspection(outcome.inspectionToken);
      }}
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
  setup.renderer.isOsc52Supported = () => true;
  setup.renderer.copyToClipboardOSC52 = (text) => {
    copied.push(text);
    return true;
  };
  const key = async (name: string) => {
    await act(async () => {
      const bytes: Record<string, string> = {
        enter: "\r",
        escape: "\x1b",
        space: " ",
        down: "\x1b[B",
        up: "\x1b[A",
        right: "\x1b[C",
        left: "\x1b[D",
        f10: "\x1b[21~",
        end: "\x1b[F",
        home: "\x1b[H",
        pagedown: "\x1b[6~",
        "shift+down": "\x1b[1;2B",
      };
      setup.mockInput.pressKey(bytes[name] ?? name);
      if (name === "escape") await Bun.sleep(35);
    });
    return flushTestFrame(setup);
  };
  const click = async (text: string, x?: number, button = MouseButton.LEFT) => {
    const lines = (await flushTestFrame(setup)).split("\n");
    const y = lines.findIndex((line) => line.includes(text));
    if (y < 0) throw new Error(`Missing ${text}:\n${lines.join("\n")}`);
    await act(async () => {
      await setup.mockMouse.click(
        x ?? lines[y]!.indexOf(text),
        y,
        button as Parameters<typeof setup.mockMouse.click>[2],
      );
    });
    return flushTestFrame(setup);
  };
  await flushTestFrame(setup);
  return {
    setup,
    controller,
    flow,
    runtime,
    originalIds,
    outcomes,
    copied,
    applied,
    key,
    click,
    frame: () => flushTestFrame(setup),
    removeHistory: () => {
      commits = [];
    },
    failRefresh: () => {
      refreshFailure = true;
    },
    close: async () => {
      await act(async () => {
        await flow.shutdown();
        await controller.close();
        setup.renderer.destroy();
      });
      await runtime.extensionSession.shutdown();
    },
  };
}

test("ordinary history hides marks and x controls, preserves Space paging and Enter review", async () => {
  const f = await createTestOperationHistory();
  try {
    const frame = await f.frame();
    expect(frame).not.toContain("[ ]");
    expect(frame).not.toContain("Select/unselect");
    await f.key("x");
    expect(f.controller.getSnapshot().marks).toHaveLength(0);
    await f.key("space");
    expect(f.controller.getSnapshot().selected).toBeGreaterThan(0);
    await f.key("enter");
    expect(f.outcomes.at(-1)?.kind).toBe("open-review");
  } finally {
    await f.close();
  }
});
for (const width of [80, 120])
  test(`mounted source selection at ${width} columns uses Space and primary checkmark without advancing focus`, async () => {
    const f = await createTestOperationHistory(width);
    try {
      let frame = await f.key("S");
      expect(frame).toContain("Choose squash sources");
      expect(frame).toContain("1 selected");
      expect(frame).toContain("I Inspect");
      expect(frame).toContain("✓");
      await f.key("down");
      await f.key("down");
      await f.key("space");
      expect(f.controller.getSnapshot().selected).toBe(2);
      expect(f.controller.getSnapshot().marks).toHaveLength(2);
      await f.click("History subject 1", 3, MouseButton.RIGHT);
      expect(f.controller.getSnapshot().marks).toHaveLength(2);
      await f.click("History subject 1", 3);
      await f.click("History subject 1", 3);
      expect(f.controller.getSnapshot().marks).toHaveLength(2);
      expect(f.controller.getSnapshot().selected).toBe(2);
      expect(f.outcomes).toHaveLength(0);
      frame = await f.key("enter");
      expect(frame).toContain("2 are selected");
      expect(f.flow.getSnapshot().phase).toBe("sources");
    } finally {
      await f.close();
    }
  });
test("empty source membership withholds Continue and Enter never opens review or advances", async () => {
  const f = await createTestOperationHistory();
  try {
    await f.key("S");
    let frame = await f.key("space");
    expect(frame).toContain("0 selected");
    expect(frame).not.toContain("Enter Continue");
    await f.key("enter");
    expect(f.flow.getSnapshot().phase).toBe("sources");
    expect(f.outcomes).toHaveLength(0);
    await f.key("escape");
    expect(f.flow.getSnapshot().visit).toBeNull();
    expect(await f.frame()).not.toContain("Choose squash sources");
  } finally {
    await f.close();
  }
});
test("I inspects only highlight while marks and a review range stay retained", async () => {
  const f = await createTestOperationHistory();
  try {
    await f.key("S");
    await act(async () => f.controller.select(1, 15, { extend: true }));
    await f.key("I");
    const outcome = f.outcomes.at(-1);
    expect(outcome?.kind).toBe("open-review");
    if (outcome?.kind === "open-review") {
      expect(outcome.count).toBe(1);
      expect(outcome.commits[0]?.revisionId).toBe(f.originalIds[1]);
      expect(outcome.inspectionToken).toBeDefined();
    }
    expect(f.controller.getSelection()?.count).toBe(2);
    expect(f.controller.getSnapshot().marks).toHaveLength(1);
    expect(f.flow.getSnapshot().suspended).toBe(false);
  } finally {
    await f.close();
  }
});
test("Enter Continue opens destination; locked membership and range resist source/Shift gestures", async () => {
  const f = await createTestOperationHistory();
  try {
    await f.key("R");
    let frame = await f.key("enter");
    expect(frame).toContain("Choose rebase destination");
    expect(frame).toContain("Destination: not chosen");
    await f.key("down");
    await f.key("space");
    await f.key("shift+down");
    await f.click(`History subject ${f.controller.getSnapshot().selected}`, 3);
    expect(f.controller.getSnapshot().marks).toHaveLength(1);
    expect(f.controller.getSelection()?.count).toBe(1);
    frame = await f.key("enter");
    expect(frame).toContain("Confirm rebase");
    expect(frame).toContain("[Cancel]");
    expect(f.applied).toHaveLength(0);
    await f.key("enter");
    expect(f.flow.getSnapshot().phase).toBe("destination");
    expect(f.flow.indicator(f.originalIds[0]!)).toBe("✓");
    await f.key("escape");
    expect(f.controller.getSnapshot().marks).toHaveLength(0);
  } finally {
    await f.close();
  }
});
test("failed/unresolved source recovery exposes lowercase r and preserves original full-ID copy", async () => {
  const f = await createTestOperationHistory(80, 18, 3);
  try {
    await f.key("S");
    f.removeHistory();
    await act(async () => {
      await f.controller.refresh();
    });
    let frame = await f.frame();
    expect(frame).toContain("No commits");
    expect(frame).toContain("r Review marks");
    frame = await f.key("r");
    expect(frame).toContain("Review marks");
    await f.key("y");
    expect(f.copied).toContain(f.originalIds[0]!);
    await f.key("r");
    expect(f.controller.getSnapshot().marks).toHaveLength(0);
    expect(f.flow.getSnapshot().phase).toBe("sources");
  } finally {
    await f.close();
  }
});
test("menu entry starts selection even with remapped ordinary Rebase/Squash keys", async () => {
  const f = await createTestOperationHistory();
  try {
    f.runtime.keybindings = { "hunk.history.squash": "ctrl+s", "hunk.history.rebase": "ctrl+r" };
    await f.key("f10");
    await f.key("right");
    await f.key("right");
    await f.key("right");
    const frame = await f.frame();
    expect(frame).toContain("Squash revision…");
    await f.key("enter");
    expect(f.flow.getSnapshot().phase).toBe("sources");
  } finally {
    await f.close();
  }
});

test("destination navigation never inherits source visual-range extension", async () => {
  const f = await createTestOperationHistory();
  try {
    await f.key("S");
    await f.key("v");
    expect(f.controller.getSnapshot().visualSelectionActive).toBe(true);
    await f.key("enter");
    expect(f.flow.getSnapshot().phase).toBe("destination");
    await f.key("down");
    expect(f.controller.getSelection()?.count).toBe(1);
    expect(f.controller.getSnapshot().visualSelectionActive).toBe(false);
    expect(f.controller.getSnapshot().selectionAnchor).toBeNull();
    await f.key("shift+down");
    expect(f.controller.getSnapshot().selected).toBe(1);
    expect(f.controller.getSnapshot().marks).toHaveLength(1);
    expect(await f.frame()).toContain("[destination]");
  } finally {
    await f.close();
  }
});

test("an unavailable highlighted destination keeps its muted tag and visible refusal", async () => {
  const f = await createTestOperationHistory(80, 24, 12, true);
  try {
    await f.key("S");
    await f.key("enter");
    await f.key("down");
    const commit = f.controller.getSelectedRow()!.commit;
    const snapshot = f.flow.getSnapshot();
    const mark = snapshot.modal?.rowMark?.(commit, {
      highlighted: commit,
    } as HistoryMutationModalFrame);
    expect(mark?.tags).toEqual(["destination"]);
    expect(mark?.muted).toBe(true);
    expect(await f.frame()).toContain("[destination]");
    expect(await f.frame()).toContain("immutable");
    expect(await f.frame()).not.toContain("Enter Preview");
  } finally {
    await f.close();
  }
});

test("clipped confirmation facts expose scrolling before Apply and reach the safety text", async () => {
  const f = await createTestOperationHistory();
  const prepare = f.runtime.mutations!.prepare;
  f.runtime.mutations!.prepare = async (request, signal) => {
    const result = await prepare(request, signal);
    if (result.kind === "ready")
      result.prepared.projection.notes = Array.from(
        { length: 30 },
        (_, index) => `Observed consequence ${index}`,
      );
    return result;
  };
  try {
    await f.key("S");
    await f.key("enter");
    await f.key("down");
    let frame = await f.key("enter");
    expect(frame).toContain("Scroll");
    expect(frame).toContain("[Cancel]");
    expect(frame).toContain("Apply");
    expect(frame).not.toContain("Other tools can still");
    frame = await f.key("end");
    expect(frame).toContain("Other tools can still");
    expect(frame).toContain("Hunk cannot undo this yet");
    expect(f.applied).toHaveLength(0);
    expect(f.flow.getSnapshot().focus).toBe(0);
    const bottom = f.flow.getSnapshot().scroll;
    expect(bottom).toBeLessThan(100);
    await f.key("up");
    expect(f.flow.getSnapshot().scroll).toBe(bottom - 1);
    frame = await f.key("home");
    expect(frame).toContain("Test provider preview");
    expect(frame).toContain("Scroll");
  } finally {
    await f.close();
  }
});

test("minimum Rebase confirmation height keeps scrolling and every action inside its frame", async () => {
  const f = await createTestOperationHistory(33, 13);
  const prepare = f.runtime.mutations!.prepare;
  f.runtime.mutations!.prepare = async (request, signal) => {
    const result = await prepare(request, signal);
    if (result.kind === "ready")
      result.prepared.projection.notes = Array.from(
        { length: 30 },
        (_, index) => `Observed consequence ${index}`,
      );
    return result;
  };
  try {
    await f.key("R");
    await f.key("enter");
    await f.key("down");
    const frame = await f.key("enter");
    expect(frame).toContain("Confirm rebase");
    expect(frame).toContain("↑↓ Scroll");
    expect(frame).toContain("Cancel");
    expect(frame).toContain("Apply");
    expect(frame).toContain("Details");
    expect(frame.split("\n").some((line) => line.includes("└"))).toBe(true);
    expect(f.applied).toHaveLength(0);
  } finally {
    await f.close();
  }
});
