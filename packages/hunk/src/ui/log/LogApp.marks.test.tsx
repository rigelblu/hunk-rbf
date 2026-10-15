import type { HistoryQueryTarget } from "../../core/history/queryReplacement";
import { formatKeyChord } from "../lib/keymap";
import { createTestCleanSquashResult } from "../../../../../test/helpers/mutation-result";
import { expect, test } from "bun:test";
import { MouseButton, TextAttributes } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { capturedTestColorToHex } from "../../../../../test/helpers/test-color-helpers";
import { contrastRatio } from "../lib/color";
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
import { squashDockLayout } from "./HistoryOperationView";
import { resolveTheme } from "../themes";

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
  subjectLength = 0,
  options: {
    color?: boolean;
    editableQuery?: boolean;
    boundedScope?: boolean;
    sourceRef?: string;
    sourceSubject?: string;
    keybindings?: InteractiveHistoryRuntime["keybindings"];
    theme?: "nord" | "github-light-default";
  } = {},
) {
  let refreshFailure = false;
  let commits = Array.from({ length: count }, (_, index) => ({
    revisionId: `${String(index + 1).repeat(8)}${"a".repeat(32)}`,
    displayId: String(index + 1).repeat(8),
    logicalId: `change-${index}`,
    isImmutable: immutableDestination && index === 1,
    parentRevisionIds: [],
    subject:
      index === 0 && options.sourceSubject !== undefined
        ? options.sourceSubject
        : `History subject ${index}${" long description".repeat(subjectLength)}`,
    authorName: "Test",
    authoredAt: "2026-10-14T00:00:00Z",
    decorations:
      index === 0 && options.sourceRef ? [{ kind: "ref" as const, label: options.sourceRef }] : [],
  }));
  const originalIds = commits.map((commit) => commit.revisionId);
  const makeSource = () => {
    const entries = [...commits];
    return {
      ...(options.editableQuery ? { expression: "all()" } : {}),
      ...(options.boundedScope
        ? { scope: { kind: "bounded" as const, boundaryRevisionId: "boundary" } }
        : {}),
      read: async () => ({ commits: entries, done: true }),
      close: async () => {},
    };
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
    keybindings: options.keybindings ?? {},
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
    ...(options.editableQuery
      ? {
          queryReplacement: {
            open: async (target: HistoryQueryTarget) => ({
              ...makeSource(),
              expression: target.kind === "expression" ? target.expression : "all()",
            }),
            accept: async () => {},
          },
        }
      : {}),
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
      themeController={new ThemeController({ initialTheme: options.theme ?? "nord" })}
      useColor={options.color ?? false}
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
        pageup: "\x1b[5~",
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
      let frame = await f.key("R");
      expect(frame).toContain("Choose rebase sources");
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
    await f.key("R");
    let frame = await f.key("space");
    expect(frame).toContain("0 selected");
    expect(frame).not.toContain("Enter Continue");
    await f.key("enter");
    expect(f.flow.getSnapshot().phase).toBe("sources");
    expect(f.outcomes).toHaveLength(0);
    await f.key("escape");
    expect(f.flow.getSnapshot().visit).toBeNull();
    expect(await f.frame()).not.toContain("Choose rebase sources");
  } finally {
    await f.close();
  }
});
test("I inspects only highlight while marks and a review range stay retained", async () => {
  const f = await createTestOperationHistory();
  try {
    await f.key("R");
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
    await f.key("R");
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
    expect(f.flow.getSnapshot().phase).toBe("destination");
  } finally {
    await f.close();
  }
});

test("destination navigation never inherits source visual-range extension", async () => {
  const f = await createTestOperationHistory();
  try {
    await f.key("R");
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

test("an unavailable highlighted destination keeps its direction badge and visible refusal", async () => {
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
    expect(mark?.tags).toEqual(["into"]);
    expect(mark?.muted).toBe(true);
    expect(await f.frame()).toContain(" Into ");
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
    await f.key("R");
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

for (const [width, height] of [
  [42, 24],
  [28, 14],
  [80, 14],
] as const)
  test(`Squash scrolls every warning inline without a Details screen at ${width}x${height}`, async () => {
    const f = await createTestOperationHistory(width, height, 12, false, 100, {
      editableQuery: true,
    });
    const prepare = f.runtime.mutations!.prepare;
    f.runtime.mutations!.prepare = async (request, signal) => {
      const result = await prepare(request, signal);
      if (result.kind === "ready")
        result.prepared.projection.warnings = Array.from(
          { length: 8 },
          (_, i) => `Warning ${i} with a long explanation.`,
        );
      return result;
    };
    try {
      await f.key("S");
      await f.key("enter");
      const frame = await f.key("down");
      expect(frame).not.toContain("From:");
      expect(frame).not.toContain("Into:");
      expect(frame).not.toContain("Source is removed.");
      expect(frame).toContain("PgUp/PgDn");
      expect(frame).toContain("Squash");
      expect(frame).not.toContain("Apply");
      expect(f.applied).toHaveLength(0);
      const source = f.flow.getSnapshot().sources[0]!.revisionId;
      await f.key("d");
      expect(f.flow.getSnapshot().details).toBe(false);
      const initial = f.flow.getSnapshot().scroll;
      await act(async () => {
        await f.setup.mockMouse.scroll(4, height - 3, "down");
      });
      await f.frame();
      expect(f.flow.getSnapshot().scroll).toBeGreaterThan(initial);
      let last = "";
      let visited = frame;
      for (let i = 0; i < 40; i++) {
        last = await f.key("pagedown");
        visited += last;
      }
      expect(visited).toContain("Warning 7");
      expect(last).toContain("Enter Squash");
      const candidate = f.controller.getSelectedRow()!.commit.revisionId;
      await f.key("pageup");
      expect(f.controller.getSelectedRow()!.commit.revisionId).toBe(candidate);
      expect(f.flow.getSnapshot().sources[0]!.revisionId).toBe(source);
      expect(f.applied).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
test("short Squash dock withholds keyboard and mouse execution", async () => {
  const f = await createTestOperationHistory(42, 13);
  try {
    await f.key("S");
    await f.key("enter");
    await f.key("down");
    expect(await f.frame()).toContain("Resize the terminal");
    await f.key("enter");
    expect(f.applied).toHaveLength(0);
    await f.key("escape");
  } finally {
    await f.close();
  }
});

for (const width of [42, 60, 80, 120])
  test(`unsupported Squash result keeps its reason at ${width}x12`, async () => {
    const f = await createTestOperationHistory(width, 12);
    f.runtime.mutations!.availability = async () => ({
      kind: "unsupported",
      reason: "This provider cannot change history.",
    });
    try {
      const frame = await f.key("S");
      expect(frame).toContain("This provider cannot change history.");
      expect(frame).toContain("Close");
      expect(frame).not.toContain("Resize the terminal");
      expect(f.flow.getSnapshot().phase).toBe("result");
      expect(f.flow.getSnapshot().visit).toBeNull();
      expect(f.applied).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

test("Squash keeps inline direction badges while candidate preparation is pending", async () => {
  const f = await createTestOperationHistory();
  const prepare = f.runtime.mutations!.prepare;
  let settle!: () => void;
  const pending = new Promise<void>((resolve) => {
    settle = resolve;
  });
  f.runtime.mutations!.prepare = async (request, signal) => {
    await pending;
    return prepare(request, signal);
  };
  try {
    await f.key("S");
    await f.key("enter");
    await f.key("down");
    await act(async () => {
      await Bun.sleep(220);
    });
    const quiet = await f.frame();
    expect(quiet).not.toContain("Checking squash");
    expect(quiet).toContain(" From ");
    expect(quiet).toContain(" Into ");
    expect(quiet).not.toContain("Enter Squash");
    await act(async () => {
      await Bun.sleep(200);
    });
    const checking = await f.frame();
    expect(checking).toContain("Checking squash");
    expect(checking).toContain(" From ");
    expect(checking).toContain(" Into ");
    expect(checking).not.toContain("Enter Squash");
    const sourceRow = checking.split("\n").findIndex((line) => line.includes("History subject 0"));
    const destinationRow = checking
      .split("\n")
      .findIndex((line) => line.includes("History subject 1"));
    settle();
    const ready = await f.frame();
    expect(ready).toContain("Enter Squash");
    expect(ready.split("\n").findIndex((line) => line.includes("History subject 0"))).toBe(
      sourceRow,
    );
    expect(ready.split("\n").findIndex((line) => line.includes("History subject 1"))).toBe(
      destinationRow,
    );
  } finally {
    settle();
    await f.close();
  }
});

for (const width of [28, 42, 80, 120]) {
  for (const color of [false, true]) {
    test(`Squash badges share description rows at ${width} columns, color ${color}`, async () => {
      const f = await createTestOperationHistory(width, 24, 3, false, 0, {
        color,
        sourceRef: "role-ref",
      });
      try {
        const original = (await f.frame()).split("\n");
        await f.key("S");
        await f.key("enter");
        const frame = await f.key("down");
        const lines = frame.split("\n");
        const source = lines.findIndex((line) => line.includes(" From "));
        const destination = lines.findIndex((line) => line.includes(" Into "));
        expect(source).toBeGreaterThanOrEqual(0);
        expect(destination - source).toBe(3);
        const refRow = original.findIndex((line) => line.includes("role-ref"));
        expect(refRow).toBeGreaterThanOrEqual(0);
        expect(lines[refRow]).toBe(original[refRow]);
        expect(frame).not.toContain("[from]");
        expect(frame).not.toContain("[into]");
        expect(frame).toContain("Enter Squash");
        if (width >= 42) {
          const before = original.find((line) => line.includes("11111111"))!;
          expect(lines[source]!.indexOf("11111111")).toBe(before.indexOf("11111111"));
          const metadata = original[original.indexOf(before) + 1];
          expect(lines[source + 1]).toBe(metadata);
        }
        const spans = f.setup
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .filter((span) => span.text.trim() === "From" || span.text.trim() === "Into");
        expect(spans).toHaveLength(2);
        for (const span of spans) {
          expect(span.attributes & TextAttributes.BOLD).toBe(TextAttributes.BOLD);
          if (color)
            expect(
              contrastRatio(capturedTestColorToHex(span.fg)!, capturedTestColorToHex(span.bg)!),
            ).toBeGreaterThanOrEqual(4.5);
        }
        await f.click(" From ");
        expect(f.controller.getSnapshot().selected).toBe(0);
        expect(await f.frame()).not.toContain(" Into ");
        expect(f.controller.getSnapshot().marks).toHaveLength(0);
        expect(f.outcomes).toHaveLength(0);
        const cancelled = await f.key("escape");
        expect(cancelled).not.toContain(" From ");
        expect(cancelled).not.toContain(" Into ");
      } finally {
        await f.close();
      }
    });
  }
}

for (const sourceSubject of ["(no description set)", "日本語の説明を表示する変更"])
  test(`Squash badge preserves title formatting for ${sourceSubject}`, async () => {
    const f = await createTestOperationHistory(42, 24, 3, false, 0, { sourceSubject });
    try {
      await f.key("S");
      await f.key("enter");
      const frame = await f.key("down");
      expect(frame).toContain(" From ");
      expect(frame).toContain(" Into ");
      expect(frame).toContain("11111111");
      expect(frame).toContain("22222222");
      expect(
        f.setup
          .captureSpans()
          .lines.every((line) => line.spans.reduce((n, span) => n + span.width, 0) <= 42),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });

test("ready Squash keeps the destination hint and no hidden Details route; failure alone offers output", async () => {
  const f = await createTestOperationHistory();
  try {
    await f.key("S");
    await f.key("enter");
    const ready = await f.key("down");
    expect(ready).toContain("Enter Squash");
    expect(ready).toContain("1 revision will be squashed.");
    expect(ready).not.toContain("From:");
    expect(ready).not.toContain("Into:");
    expect(ready).not.toContain("Source is removed.");
    expect(ready).not.toContain("JJ opens your editor");
    expect(ready).not.toContain("Details");
    expect(
      squashDockLayout(f.flow, {
        terminalWidth: 80,
        terminalHeight: 24,
        theme: resolveTheme("nord", null),
        highlighted: f.controller.getSelectedRow()!.commit,
      }).rows,
    ).toBe(2);
    expect(ready).toContain("↑↓ Destination");
    await f.key("d");
    await f.key("\t");
    expect(f.flow.getSnapshot().details).toBe(false);
    await f.key("enter");
    let failed = await f.frame();
    expect(failed).toContain("Error output");
    await f.key("o");
    expect(await f.frame()).toContain("Squash error output");
    expect(f.flow.getSnapshot().details).toBe(true);
    await f.key("escape");
    expect(f.flow.getSnapshot().phase).toBe("result");
    expect(f.flow.getSnapshot().details).toBe(false);
  } finally {
    await f.close();
  }
});

for (const sourceCount of [1, 2])
  test(`ready Squash counts ${sourceCount} effective sources separately from selected Into and descendants`, async () => {
    const f = await createTestOperationHistory(42, 24, 3, false, 0, { editableQuery: true });
    const prepare = f.runtime.mutations!.prepare;
    const notes = ["The source revision is removed.", "5 other revisions will be rebased."];
    const warning = "JJ will create conflicts in 5 other revisions.";
    f.runtime.mutations!.prepare = async (request, signal) => {
      const result = await prepare(request, signal);
      if (result.kind === "ready") {
        result.prepared.projection.notes = notes;
        result.prepared.projection.warnings = [warning];
      }
      return result;
    };
    try {
      await f.key("m");
      await f.key("down");
      await f.key("m");
      if (sourceCount === 2) {
        await f.key("down");
        await f.key("m");
        await f.key("up");
      }
      const frame = await f.key("S");
      const snapshot = f.flow.getSnapshot();
      expect(snapshot.sources).toHaveLength(sourceCount + 1);
      expect(snapshot.prepared?.request.kind).toBe("squash");
      if (snapshot.prepared?.request.kind !== "squash") throw new Error("Expected Squash");
      expect(snapshot.prepared.request.sources).toHaveLength(sourceCount);
      expect(snapshot.prepared.request.sources.map((source) => source.revisionId)).not.toContain(
        f.originalIds[1]!,
      );
      expect(frame).toContain(
        `${sourceCount} revision${sourceCount === 1 ? "" : "s"} will be squashed.`,
      );
      expect(frame).not.toContain("will be rebased");
      expect(frame.replace(/\s+/g, " ")).toContain(`Warning: ${warning}`);
      expect(snapshot.prepared.projection.notes).toEqual(notes);
      expect(snapshot.prepared.projection.warnings).toEqual([warning]);
      expect(frame).toContain("Enter Squash · Esc Cancel");
      expect(frame).toContain(f.originalIds[1]!.slice(0, 8));
      expect(f.applied).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

test("Squash preserves nonroutine provider consequences while replacing routine removal and rebase counts", async () => {
  const f = await createTestOperationHistory(80, 24);
  const prepare = f.runtime.mutations!.prepare;
  const notes = [
    "The source revision is removed.",
    "2 other revisions will be rebased.",
    "Only this version is squashed. Another version of the change stays.",
    "JJ creates a new empty working-copy revision.",
    "Bookmark topic will move.",
    "JJ adds your configured trailers to the description: Signed-off-by: Test",
  ];
  f.runtime.mutations!.prepare = async (request, signal) => {
    const result = await prepare(request, signal);
    if (result.kind === "ready") result.prepared.projection.notes = notes;
    return result;
  };
  try {
    await f.key("S");
    await f.key("enter");
    let frame = await f.key("down");
    expect(frame).toContain("1 revision will be squashed.");
    const seen = new Set<string>();
    for (let i = 0; i < 15; i++) {
      expect(frame).not.toContain("will be rebased");
      for (const note of notes.slice(2))
        if (
          frame
            .split("\n")
            .map((line) => line.trim())
            .join(" ")
            .replace(/\s+/g, " ")
            .includes(note)
        )
          seen.add(note);
      expect(frame).not.toContain(notes[0]!);
      expect(frame).not.toContain("Details");
      expect(frame).toContain("Enter Squash");
      frame = await f.key("pagedown");
    }
    expect([...seen]).toEqual(notes.slice(2));
    expect(f.flow.getSnapshot().prepared?.projection.notes).toEqual(notes);
    expect(f.applied).toHaveLength(0);
  } finally {
    await f.close();
  }
});

for (const width of [28, 42, 80])
  test(`ordinary m/M selection at ${width} columns stays separate from focus and range`, async () => {
    const f = await createTestOperationHistory(width, 24, 3);
    try {
      const selected = await f.key("m");
      expect(selected).toContain("Selected");
      expect(selected).toContain("11111111");
      expect(selected).toContain("1 selected");
      expect(selected).toContain("Clear selected revisions");
      await f.key("down");
      await f.key("m");
      const before = f.controller.getSnapshot().selected;
      await f.key("M");
      expect(f.controller.getSnapshot().selected).toBe(before);
      expect(f.controller.getSnapshot().marks).toHaveLength(0);
      expect(await f.frame()).not.toContain("Clear selected revisions");
      expect(await f.frame()).not.toContain("> ");
      await f.key("m");
      await f.key("S");
      expect(f.flow.getSnapshot().sources.map((c) => c.revisionId)).toEqual([f.originalIds[1]!]);
      expect(f.flow.getSnapshot().phase).toBe("destination");
      expect(await f.frame()).not.toContain("Continue");
      expect(await f.frame()).not.toContain("Inspect");
      await f.key("escape");
      expect(f.controller.getSnapshot().marks).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

test("Navigate mouse commands use the same selection intent without moving focus", async () => {
  const f = await createTestOperationHistory();
  try {
    await f.click("Navigate");
    await f.click("Select revision");
    expect(f.controller.getSnapshot().marks).toHaveLength(1);
    expect(f.controller.getSnapshot().selected).toBe(0);
    await f.click("Navigate");
    expect(await f.frame()).toContain("Unselect revision");
    await f.click("Clear selected revisions");
    expect(f.controller.getSnapshot().marks).toHaveLength(0);
    expect(f.controller.getSnapshot().selected).toBe(0);
  } finally {
    await f.close();
  }
});

test("Clear defeats an ordinary toggle still waiting for navigation", async () => {
  const f = await createTestOperationHistory();
  let settle!: () => void;
  const waiting = new Promise<void>((resolve) => {
    settle = resolve;
  });
  try {
    await act(async () => {
      f.controller.toggleMark(1);
    });
    f.controller.settleNavigation = () => waiting;
    await f.key("m");
    await f.key("M");
    settle();
    await f.frame();
    expect(f.controller.getSnapshot().marks).toHaveLength(0);
  } finally {
    settle();
    await f.close();
  }
});

test("an accepted keyboard toggle retains its immutable identity across later focus", async () => {
  const f = await createTestOperationHistory();
  let settle!: () => void;
  const waiting = new Promise<void>((resolve) => {
    settle = resolve;
  });
  try {
    f.controller.settleNavigation = () => waiting;
    await f.key("m");
    await act(async () => {
      await f.controller.select(1, 15);
    });
    settle();
    await f.frame();
    expect(f.controller.getSnapshot().marks.map((m) => m.mark.revisionId)).toEqual([
      f.originalIds[0]!,
    ]);
  } finally {
    settle();
    await f.close();
  }
});

test("explicit selection and review range retain separate labels and clearing", async () => {
  const f = await createTestOperationHistory(80, 24, 12, false, 0, { editableQuery: true });
  try {
    await act(async () => {
      await f.controller.select(1, 15, { extend: true });
    });
    await f.key("m");
    expectTestUpperContext(await f.frame(), "Review range: 2");
    await f.key("M");
    expect(f.controller.getSelection()?.count).toBe(2);
    await f.key("m");
    await f.key("escape");
    expect(f.controller.getSelection()?.count).toBe(1);
    expect(f.controller.getSnapshot().marks).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("a pending ordinary toggle drains before Squash captures its fixed source", async () => {
  const f = await createTestOperationHistory();
  let settle!: () => void;
  const waiting = new Promise<void>((resolve) => {
    settle = resolve;
  });
  try {
    f.controller.settleNavigation = () => waiting;
    await f.key("m");
    await f.key("S");
    expect(f.flow.getSnapshot().phase).toBe("preparing");
    settle();
    await f.frame();
    expect(f.flow.getSnapshot().sources.map((c) => c.revisionId)).toEqual([f.originalIds[0]!]);
    expect(f.controller.getSnapshot().marks).toHaveLength(1);
  } finally {
    settle();
    await f.close();
  }
});

test("ordinary unresolved intent blocks keyboard/menu toggles while retaining Clear", async () => {
  const f = await createTestOperationHistory(42, 24, 3, false, 0, { editableQuery: true });
  try {
    await f.key("m");
    f.removeHistory();
    await act(async () => {
      await f.controller.refresh();
    });
    const before = f.controller.getSnapshot().marks;
    await f.key("m");
    expect(f.controller.getSnapshot().marks).toBe(before);
    expectTestUpperContext(await f.frame(), "unresolved");
    await f.key("M");
    expect(f.controller.getSnapshot().marks).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("long ordinary notices preserve minimum focused entry and full selection actions", async () => {
  const f = await createTestOperationHistory(28, 14, 3);
  try {
    await f.key("m");
    await act(async () => {
      f.controller.setNotice("Provider refresh failed: " + "long diagnostic ".repeat(100));
    });
    const frame = await f.frame();
    expect(frame).toContain("11111111");
    expect(frame).toContain("Selected");
    expect(frame).toContain("M Clear selected revisions");
    expect(frame).toContain("F10 Menu");
    expect(frame.trimEnd().split("\n").length).toBeLessThanOrEqual(14);
  } finally {
    await f.close();
  }
});

test("minimum Squash places its heading above history and keeps destination and actions complete", async () => {
  const f = await createTestOperationHistory(28, 14);
  try {
    await f.key("S");
    const ready = await f.key("down");
    const lines = ready.split("\n");
    expect(ready).toContain("↑↓ Destination");
    expect(lines.some((line) => line.includes("Enter Squash · Esc Cancel"))).toBe(true);
    expect(lines.findIndex((line) => line.trim() === "Squash")).toBeLessThan(
      lines.findIndex((line) => line.includes("Into ")),
    );
    expect(ready).toContain("22222222");
  } finally {
    await f.close();
  }
});

for (const width of [28, 80])
  test(`ordinary search retains its prompt, applied query and navigation at ${width} columns`, async () => {
    const f = await createTestOperationHistory(width, 14, 3);
    try {
      expect(await f.key("/")).toContain("/ search commits");
      await act(async () => {
        f.setup.mockInput.typeText("History subject");
      });
      expect(await f.key("enter")).toContain("/History subject");
      const selected = f.controller.getSnapshot().selected;
      await f.key("n");
      expect(f.controller.getSnapshot().selected).not.toBe(selected);
      await f.key("/");
      // The existing prompt clears its draft before a second Escape cancels it.
      expect(await f.key("escape")).toContain("/ search commits");
      expect(await f.key("escape")).toContain("/History subject");
      await f.key("m");
      await act(async () => {
        await f.controller.search("History".repeat(100));
      });
      const frame = await f.frame();
      expect(frame).toContain("M Clear selected revisions");
      expect(frame).toContain("F10 Menu");
      expect(frame).toContain(f.controller.getSelectedRow()!.commit.displayId!);
      expect(
        f.setup
          .captureSpans()
          .lines.every((line) => line.spans.reduce((n, span) => n + span.width, 0) <= width),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });

test("minimum footer retains a long effective clear chord and each physical line activates once", async () => {
  const f = await createTestOperationHistory(28, 14, 3, false, 0, {
    keybindings: { "hunk.history.clearRevisionSelection": "ctrl+alt+shift+m" },
  });
  try {
    let frame = await f.key("m");
    expect(frame.replace(/\s+/g, " ")).toContain("Ctrl+Alt+M Clear selected revisions");
    expect(frame).not.toContain("…");
    expect(frame).toContain("11111111");
    expect(
      f.setup
        .captureSpans()
        .lines.every((line) => line.spans.reduce((n, span) => n + span.width, 0) <= 28),
    ).toBe(true);
    await f.click("Ctrl+Alt+M");
    expect(f.controller.getSnapshot().marks).toHaveLength(0);
    frame = await f.key("m");
    expect(frame).toContain("Clear selected revisions");
    await f.click("Clear selected revisions");
    expect(f.controller.getSnapshot().marks).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("minimum footer reflows a supported named-key chord wider than its content row", async () => {
  const f = await createTestOperationHistory(28, 14, 3, false, 0, {
    keybindings: { "hunk.history.clearRevisionSelection": "ctrl+meta+alt+shift+backspace" },
  });
  const clear = f.controller.clearRevisionMarks.bind(f.controller);
  let clears = 0;
  f.controller.clearRevisionMarks = () => {
    clears++;
    return clear();
  };
  try {
    const frame = await f.key("m");
    expect(frame.replace(/\s+/g, "")).toContain(
      "Ctrl+Cmd+Alt+Shift+BackspaceClearselectedrevisions",
    );
    expect(frame).toContain("11111111");
    expect(frame).toContain("F10 Menu");
    expect(
      f.setup
        .captureSpans()
        .lines.every((line) => line.spans.reduce((n, span) => n + span.width, 0) <= 28),
    ).toBe(true);
    for (const part of ["Ctrl+Cmd+Alt+Shift+Backsp", "ace", "Clear selected revisions"]) {
      if (!f.controller.getSnapshot().marks.length) await f.key("m");
      await f.click(part);
      expect(f.controller.getSnapshot().marks).toHaveLength(0);
    }
    expect(clears).toBe(3);
  } finally {
    await f.close();
  }
});

for (const width of [28, 42, 80])
  for (const [theme, color] of [
    ["nord", true],
    ["github-light-default", true],
    ["nord", false],
  ] as const)
    test(`ordinary four-state selection preserves IDs with hidden metadata at ${width}, ${theme}, color ${color}`, async () => {
      const f = await createTestOperationHistory(width, 24, 4, false, 20, {
        theme,
        color,
        editableQuery: true,
      });
      const background = (id: string) => {
        const row = f.setup
          .captureSpans()
          .lines.find((line) => line.spans.some((span) => span.text.includes(id)))!;
        return capturedTestColorToHex(row.spans.find((span) => span.text.includes(id))!.bg);
      };
      try {
        await act(async () => {
          f.controller.togglePresentation("author");
          f.controller.togglePresentation("date");
        });
        let frame = await f.frame();
        const focused = background("11111111");
        const ordinary = background("33333333");
        expect(focused).not.toBe(ordinary);
        frame = await f.key("m");
        expect(frame).toContain("Selected");
        expect(background("11111111")).toBe(focused);
        frame = await f.key("down");
        const selected = background("11111111");
        expect(background("22222222")).toBe(focused);
        expect(background("33333333")).toBe(ordinary);
        if (color) {
          expect(selected).not.toBe(ordinary);
          expect(selected).not.toBe(focused);
        } else expect(selected).toBe(ordinary);
        for (const id of ["11111111", "22222222", "33333333", "44444444"])
          expect(frame).toContain(id);
        for (const id of ["11111111", "22222222", "33333333", "44444444"]) {
          const lines = frame.split("\n");
          const row = lines.findIndex((line) => line.includes(id));
          expect(lines[row + 1]).not.toContain("Test");
          expect(lines[row + 1]).not.toContain("ago");
        }
        expect(
          f.setup
            .captureSpans()
            .lines.every((line) => line.spans.reduce((n, span) => n + span.width, 0) <= width),
        ).toBe(true);
        await f.key("m");
        expect(f.controller.getSnapshot().marks).toHaveLength(2);
        await f.key("M");
        expect(f.controller.getSnapshot().marks).toHaveLength(0);
        expect(background("22222222")).toBe(focused);
      } finally {
        await f.close();
      }
    });

for (const [width, height] of [
  [80, 24],
  [42, 24],
  [28, 14],
])
  test(`clean Squash notice allows ordinary review and optional dismissal at ${width}x${height}`, async () => {
    const f = await createTestOperationHistory(width, height, 12, false, 0, {
      boundedScope: width === 28,
      keybindings:
        width === 28
          ? { "hunk.history.clearRevisionSelection": "ctrl+meta+alt+shift+backspace" }
          : {},
    });
    try {
      let prepared!: ExtensionVcsMutationPrepared;
      const prepare = f.runtime.mutations!.prepare;
      f.runtime.mutations!.prepare = async (request, signal) => {
        const result = await prepare(request, signal);
        if (result.kind === "ready") prepared = result.prepared;
        return result;
      };
      f.runtime.mutations!.apply = async (handle) => {
        f.applied.push(handle);
        const result = createTestCleanSquashResult(prepared);
        result.verdict.notes.push("1 other revision rebased.");
        return result;
      };
      await f.key("S");
      await f.key("down");
      await f.key("enter");
      let text = await f.frame();
      expect(text.replace(/\s+/g, " ")).toContain("1 revision was squashed.");
      // The generic refresh acknowledgment remains outside this bounded copy change.
      expect(f.controller.getSnapshot().notice).toBe("History refreshed.");
      if (width === 42 || width === 80) expect(text).toContain("History refreshed.");
      expect(text).not.toContain("other revision rebased.");
      expect(text).not.toContain("Recorded as operation");
      expect(text).toContain("Esc Dismiss");
      expect(text).not.toContain("jj op revert");
      expect(text).toContain(width === 28 ? "22222222" : "History subject 1");
      expect(f.flow.getSnapshot().modal).toBeNull();
      const before = f.controller.getSnapshot().selected;
      await f.key("down");
      expect(f.controller.getSnapshot().selected).toBe(before + 1);
      await f.key("m");
      expect(f.controller.getSnapshot().marks).toHaveLength(1);
      await f.key("f10");
      await f.key("escape");
      expect(f.flow.getSnapshot().resultNotice).not.toBeNull();
      await f.key("shift+down");
      const range = f.controller.getSelection();
      text = await f.frame();
      expect(text).toContain(f.controller.getSelectedRow()!.commit.displayId!);
      expect(text).toContain("Esc Dismiss");
      if (width === 28) {
        expect(text).toContain("Clear selected revisions");
        expect(text.replace(/\s+/g, "")).toContain(formatKeyChord("ctrl+meta+alt+shift+backspace"));
      }
      await f.click("Esc Dismiss", undefined, MouseButton.RIGHT);
      expect(f.flow.getSnapshot().resultNotice).not.toBeNull();
      if (width === 42) await f.click("Esc Dismiss");
      else await f.key("escape");
      expect(f.flow.getSnapshot().resultNotice).toBeNull();
      expect(f.controller.getSelection()).toEqual(range);
      expect(f.controller.getSnapshot().marks).toHaveLength(1);
      await act(async () => f.flow.openResult());
      text = await f.frame();
      expect(text).toContain("Operation result");
      expect(text).not.toContain("Squash error output");
      await f.key("end");
      text = await f.frame();
      expect(text).toContain("Esc Close");
      await f.key("escape");
      expect(f.flow.getSnapshot().modal).toBeNull();
      expect(f.flow.getSnapshot().resultNotice).toBeNull();
      expect(f.applied).toHaveLength(1);
      await f.key("enter");
      expect(f.outcomes.at(-1)?.kind).toBe("open-review");
    } finally {
      await f.close();
    }
  });

/** Require a real query header before comparing task context against visible history. */
function expectTestUpperContext(frame: string, context: string, header = true) {
  const lines = frame.split("\n");
  const policy = lines.findIndex((line) => line.includes("Launch policy"));
  const revset = lines.findIndex((line) => line.includes("Revset:"));
  const task = lines.findIndex((line) => line.includes(context));
  const body = lines.findIndex(
    (line) =>
      line.includes("Commits on") || line.includes("No commits") || /History subject \d/.test(line),
  );
  expect(task).toBeGreaterThanOrEqual(0);
  expect(body).toBeGreaterThanOrEqual(0);
  if (header) {
    expect(revset).toBeGreaterThanOrEqual(0);
    expect(policy).toBeGreaterThanOrEqual(0);
    expect(task).toBeGreaterThan(policy);
  } else {
    expect(revset).toBe(-1);
    expect(policy).toBe(-1);
  }
  expect(task).toBeLessThan(body);
  return { lines, task, body };
}

for (const width of [42, 80]) {
  test(`upper selection context follows launch policy through clear and refresh at ${width}`, async () => {
    const f = await createTestOperationHistory(width, 24, 3, false, 0, { editableQuery: true });
    try {
      expect(await f.frame()).not.toMatch(/0 selected/);
      await f.key("m");
      await f.key("down");
      await f.key("down");
      await f.key("m");
      const selected = await f.key("up");
      expectTestUpperContext(selected, "2 selected");
      expect(f.controller.getSnapshot().marks).toHaveLength(2);
      const focus = f.controller.getSnapshot().selected;
      await act(async () => {
        f.controller.setNotice("History refresh failed.");
      });
      const noticed = await f.frame();
      const view = expectTestUpperContext(noticed, "2 selected");
      expect(
        view.lines.findIndex((line) => line.includes("History refresh failed.")),
      ).toBeGreaterThan(view.body);
      await f.key("M");
      expect(f.controller.getSnapshot().selected).toBe(focus);
      expect(await f.frame()).not.toContain("2 selected");
      await act(async () => {
        f.controller.setNotice("");
      });
      await f.key("m");
      const reopen = f.runtime.reopenSource;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.runtime.reopenSource = async (...args) => {
        await gate;
        return reopen(...args);
      };
      let refreshing!: Promise<unknown>;
      await act(async () => {
        refreshing = f.controller.refresh();
        await Bun.sleep(0);
      });
      expectTestUpperContext(await f.frame(), "1 selected · checking");
      await f.key("M");
      release();
      await act(async () => {
        await refreshing;
      });
      expect(f.controller.getSnapshot().marks).toHaveLength(0);
      f.runtime.reopenSource = reopen;
      await f.key("m");
      f.failRefresh();
      await act(async () => {
        await f.controller.refresh();
      });
      expectTestUpperContext(await f.frame(), "1 selected · refresh failed");
    } finally {
      await f.close();
    }
  });
  test(`upper Squash stays before history through quiet checking ready and refusal at ${width}`, async () => {
    const f = await createTestOperationHistory(width, 24, 3, false, 0, { editableQuery: true });
    const prepare = f.runtime.mutations!.prepare;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.runtime.mutations!.prepare = async (request, signal) => {
      await gate;
      return prepare(request, signal);
    };
    try {
      const initial = await f.key("S");
      expectTestUpperContext(initial, "Squash");
      expect(initial).toContain(" From ");
      expect(initial).not.toContain(" Into ");
      expect(initial).not.toContain("will be squashed.");
      expect(initial).not.toContain("Enter Squash");
      const quiet = await f.key("down");
      expectTestUpperContext(quiet, "Squash");
      expect(quiet).not.toContain("Checking squash");
      expect(quiet).not.toContain("Enter Squash");
      await act(async () => {
        await Bun.sleep(420);
      });
      const checking = await f.frame();
      const { lines, body } = expectTestUpperContext(checking, "Squash");
      expect(lines.findIndex((line) => line.includes("Checking squash"))).toBeGreaterThan(body);
      expect(checking).not.toContain("Enter Squash");
      release();
      const ready = await f.frame();
      expectTestUpperContext(ready, "Squash");
      expect(ready).toContain("Enter Squash");
      expect(ready.split("\n").filter((line) => line.trim() === "Squash")).toHaveLength(1);
      const refused = await f.key("up");
      expectTestUpperContext(refused, "Squash");
      expect(refused).not.toContain("Enter Squash");
      expect(refused).toContain("This is the source.");
      await f.key("escape");
      expect(await f.frame()).not.toMatch(/^\s*Squash\s*$/m);
    } finally {
      release();
      await f.close();
    }
  });
}

for (const [width, height] of [
  [42, 24],
  [42, 14],
  [80, 24],
])
  test(`upper context has no fabricated launch policy at ${width}x${height}`, async () => {
    const f = await createTestOperationHistory(width, height, 3);
    try {
      const marked = await f.key("m");
      expectTestUpperContext(marked, "1 selected", false);
      expectTestUpperContext(await f.key("S"), "Squash", false);
      const ready = await f.key("down");
      expectTestUpperContext(ready, "Squash", false);
      expect(ready).toContain("22222222");
      expect(ready).toContain("Enter Squash");
    } finally {
      await f.close();
    }
  });

test("upper context preserves focused entry with custom query and scrolling warnings at42x15", async () => {
  const f = await createTestOperationHistory(42, 15, 3, false, 0, { editableQuery: true });
  const prepare = f.runtime.mutations!.prepare;
  f.runtime.mutations!.prepare = async (request, signal) => {
    const result = await prepare(request, signal);
    if (result.kind === "ready")
      result.prepared.projection.warnings = Array.from(
        { length: 8 },
        (_, i) => `Warning ${i} with a long explanation.`,
      );
    return result;
  };
  try {
    await act(async () => {
      await f.controller.replaceQuery({
        kind: "apply",
        expression: 'description("long enough expression to wrap the revset header")',
      });
    });
    await f.key("S");
    const ready = await f.key("down");
    const lines = ready.split("\n");
    expect(ready).toContain("long enough");
    const mode = lines.findIndex((line) => line.includes("Custom revset · Limit:"));
    const task = lines.findIndex((line) => line.trim() === "Squash");
    const body = lines.findIndex((line) => /History subject \d/.test(line));
    expect(mode, ready).toBeGreaterThanOrEqual(0);
    expect(task, ready).toBeGreaterThan(mode);
    expect(body, ready).toBeGreaterThan(task);
    const focused = lines.findIndex((line) => line.includes("22222222"));
    expect(focused, ready).toBeGreaterThanOrEqual(0);
    expect(lines[focused + 1], ready).toContain("Test");
    expect(lines[focused + 2], ready).not.toContain("PgUp/PgDn");
    expect(ready).toContain("Enter Squash");
    expect(ready).toContain("PgUp/PgDn");
    expect(lines.length).toBeLessThanOrEqual(16);
  } finally {
    await f.close();
  }
});
