import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import type { UserKeyBinding } from "../../core/run/config";
import { createTestExtensionSession } from "../../../../../test/helpers/extension-session";
import type { HistoryQueryTarget } from "../../core/history/queryReplacement";
import type { VcsHistorySource } from "../../core/vcs/types";
import { persistedViewPreferencesFromOptions } from "../../core/run/config";
import { createInteractiveSessionInitialization } from "../../core/session/initialization";
import type { InteractiveHistoryRuntime } from "../history/types";
import { PreviousInputs } from "../session/previousInputs";
import { ThemeController } from "../theme/controller";
import { LogApp } from "./LogApp";
import { LogController } from "./controller";

type TestHarness = Awaited<ReturnType<typeof testRender>>;

const LAUNCH = "(((trunk()..visible_heads()) | trunk()) ~ root())";

async function flush(setup: TestHarness) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
    await Bun.sleep(5);
    await setup.renderOnce();
  });
  return setup.captureCharFrame();
}

/** Commits named after their revision, so a frame shows which query produced the rows. */
function commitsFor(names: string[]) {
  return names.map((name) => ({
    revisionId: `${name}${"0".repeat(40 - name.length)}`,
    displayId: name,
    parentRevisionIds: [],
    subject: `Subject ${name}`,
    authorName: "Ada",
    authoredAt: "2026-10-11T00:00:00Z",
    decorations: [],
  }));
}

/** Render history over a fake provider whose queries are named tables of commits. */
async function createTestEditorHistory({
  width = 100,
  height = 30,
  editable = true,
  maxCount = 100,
  launchExpression = LAUNCH,
  queries = {},
  previousInputs = new PreviousInputs(),
  watch = false,
  autoRefresh = watch,
  keybindings = {},
}: {
  width?: number;
  height?: number;
  editable?: boolean;
  maxCount?: number;
  launchExpression?: string;
  queries?: Record<string, { names: string[]; error?: string; gate?: Promise<void> }>;
  previousInputs?: PreviousInputs;
  /** Run history auto-refresh as if returning from a review, and record refresh and watch calls. */
  watch?: boolean;
  /** Whether auto-refresh starts on; defaults to `watch`. */
  autoRefresh?: boolean;
  keybindings?: Record<string, UserKeyBinding>;
} = {}) {
  const launchNames = ["aaa", "bbb", "ccc"];
  const opened: string[] = [];
  const makeSource = (key: string, names: string[], expression: string): VcsHistorySource => ({
    expression,
    read: async () => ({ commits: commitsFor(names), done: true }),
    close: async () => {},
  });
  const preferences = persistedViewPreferencesFromOptions({});
  let acceptedKey = "launch";
  const reopens: string[] = [];
  const signatures: string[] = [];
  let signatureSuffix = "";
  const runtime: InteractiveHistoryRuntime = {
    input: {
      kind: "history",
      maxCount,
      color: "never",
      format: "compact",
      ascii: false,
      static: false,
      extensionsEnabled: false,
      extensionPaths: [],
    },
    source: makeSource("launch", launchNames, launchExpression),
    providerId: "test",
    providerName: "Jujutsu",
    repoRoot: "test-repo",
    notices: [],
    customThemes: [],
    keybindings,
    initialViewPreferences: preferences,
    promptSaveViewPreferences: false,
    extensionSession: createTestExtensionSession(),
    initialization: createInteractiveSessionInitialization({
      theme: {},
      viewPreferences: preferences,
    }),
    planReview: async (commit) => ({ kind: "revision-show", revisionId: commit.revisionId }),
    reopenSource: async () => {
      reopens.push(acceptedKey);
      return makeSource(acceptedKey, launchNames, launchExpression);
    },
    ...(watch && {
      historyWatchPlan: { coverage: "poll-only" as const, targets: [] },
      historyWatchSignature: async () => {
        signatures.push(acceptedKey);
        return `${acceptedKey}${signatureSuffix}`;
      },
    }),
    close: async () => {},
    ...(editable && {
      queryReplacement: {
        async open(target: HistoryQueryTarget) {
          const key = target.kind === "launch" ? "launch" : target.expression;
          opened.push(key);
          const query = queries[key];
          await query?.gate;
          if (query?.error) throw new Error(query.error);
          return makeSource(
            key,
            key === "launch" ? launchNames : (query?.names ?? []),
            key === "launch" ? launchExpression : key,
          );
        },
        async accept(target: HistoryQueryTarget) {
          acceptedKey = target.kind === "launch" ? "launch" : target.expression;
        },
      },
    }),
  };
  const controller = new LogController(runtime);
  await controller.loadMore();
  const outcomes: unknown[] = [];
  const claims: Array<() => boolean> = [];
  let setAutoRefresh: (enabled: boolean) => void = () => {};
  function Harness() {
    const [auto, setAuto] = useState(autoRefresh);
    setAutoRefresh = setAuto;
    return (
      <LogApp
        controller={controller}
        runtime={runtime}
        onOutcome={(outcome) => {
          outcomes.push(outcome);
        }}
        sessionViewPreferences={preferences}
        autoRefreshEnabled={auto}
        onAutoRefreshEnabledChange={setAuto}
        refreshOnMountGeneration={watch ? 1 : 0}
        themeController={new ThemeController({})}
        useColor={false}
        previousInputs={previousInputs}
        claimInterrupt={(claim) => {
          claims.push(claim);
          return () => void claims.splice(claims.indexOf(claim), 1);
        }}
      />
    );
  }
  // Production sessions leave Ctrl+C to the app; the test renderer would otherwise exit on it.
  const setup = await testRender(<Harness />, { width, height, exitOnCtrlC: false });
  await flush(setup);
  return {
    setup,
    controller,
    opened,
    reopens,
    signatures,
    outcomes,
    /** Raw-mode Ctrl+C as the session delivers it: the newest claim first, true when one took it. */
    interrupt: async () => {
      let claimed = false;
      await act(async () => {
        for (const claim of claims.toReversed()) if ((claimed = claim())) break;
      });
      await flush(setup);
      return claimed;
    },
    setAutoRefresh: async (enabled: boolean) => {
      await act(async () => setAutoRefresh(enabled));
      await flush(setup);
    },
    changeSignature: () => {
      signatureSuffix = "-changed";
    },
    previousInputs,
    press: async (...args: Parameters<TestHarness["mockInput"]["pressKey"]>) => {
      // A lone escape byte waits for a possible sequence; pressEscape delivers it as a key.
      if (args[0] === "ESCAPE") {
        await act(async () => setup.mockInput.pressEscape());
        await Bun.sleep(80);
      } else await act(async () => setup.mockInput.pressKey(...args));
      return flush(setup);
    },
    type: async (text: string) => {
      await act(async () => setup.mockInput.typeText(text));
      return flush(setup);
    },
    close: async () => {
      await controller.close();
      await act(async () => setup.renderer.destroy());
      await runtime.extensionSession.shutdown();
    },
  };
}

test("a provider that cannot edit its query shows and does nothing new", async () => {
  const fixture = await createTestEditorHistory({ editable: false });
  try {
    const frame = await fixture.press("L");
    expect(frame).not.toContain("Edit revset");
    expect(frame).not.toContain("Revset:");
    expect(frame).not.toContain("Launch policy");
    expect(frame).not.toContain("edit revset");
  } finally {
    await fixture.close();
  }
});

test("history shows the complete revset, mode and limit, and the key hint", async () => {
  const fixture = await createTestEditorHistory();
  try {
    const frame = await flush(fixture.setup);
    expect(frame).toContain(`Revset: ${LAUNCH}`);
    expect(frame).toContain("Launch policy · Limit: 100");
    expect(frame).toContain("L edit revset · v select · Enter open · F10 menu");
    expect(frame).not.toContain("Custom revset");
  } finally {
    await fixture.close();
  }
});

test("L opens the editor on the accepted revset, F2 on it is a no-op, Esc cancels", async () => {
  const fixture = await createTestEditorHistory();
  try {
    let frame = await fixture.press("L");
    expect(frame).toContain("Edit revset");
    expect(frame).toContain("[F2] Apply  [F3] Reset  [Esc] Cancel");
    expect(frame).toContain("No previous inputs yet.");
    expect(frame).toContain("Enter apply");
    expect(frame).toContain(`Revset: ${LAUNCH}`);
    frame = await fixture.press("F2");
    expect(frame).not.toContain("Edit revset");
    expect(fixture.opened).toEqual([]);
    expect(frame).toContain("Launch policy · Limit: 100");

    await fixture.press("L");
    frame = await fixture.press("ESCAPE");
    expect(frame).not.toContain("Edit revset");
    expect(fixture.opened).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("untouched padded legacy expression preserves launch policy through F2 and Enter", async () => {
  const fixture = await createTestEditorHistory({ launchExpression: "  all()  " });
  try {
    for (const key of ["F2", "RETURN"]) {
      let frame = await fixture.press("L");
      expect(frame).toContain("Launch policy · Limit: 100");
      frame = await fixture.press(key);
      expect(frame).not.toContain("Edit revset");
      expect(frame).toContain("Launch policy · Limit: 100");
      expect(fixture.opened).toEqual([]);
      expect(fixture.controller.getSnapshot().query).toMatchObject({
        mode: "launch",
        expression: "  all()  ",
      });
    }
  } finally {
    await fixture.close();
  }
});

test("typing a revset and pressing F2 applies it: custom row, restriction, rows, previous input", async () => {
  const fixture = await createTestEditorHistory({ queries: { "@-": { names: ["pa", "pb"] } } });
  try {
    await fixture.press("L");
    await fixture.press("u", { ctrl: true });
    let frame = await fixture.type("@-");
    expect(frame).toContain("Custom revset · Limit: 100");
    frame = await fixture.press("F2");
    expect(frame).not.toContain("Edit revset");
    expect(frame).toContain("Revset: @-");
    expect(frame).toContain("Custom revset · Limit: 100");
    expect(frame).toContain("Custom revset: graph links and range review unavailable.");
    expect(frame).toContain("Subject pa");
    expect(frame).not.toContain("Subject aaa");
    expect(fixture.previousInputs.list()).toEqual(["@-"]);
    expect(fixture.opened).toEqual(["@-"]);

    // Range selection is refused while the custom revset is accepted.
    await fixture.press("v");
    expect(await flush(fixture.setup)).toContain("Multi-commit selection is unavailable");
  } finally {
    await fixture.close();
  }
});

test("a previous input is chosen with Tab, inserted by Enter without applying, then applied", async () => {
  const previousInputs = new PreviousInputs();
  previousInputs.record("mine()");
  previousInputs.record("@-");
  const fixture = await createTestEditorHistory({
    previousInputs,
    queries: { "mine()": { names: ["mm"] } },
  });
  try {
    let frame = await fixture.press("L");
    expect(frame).toContain("Previous inputs");
    expect(frame).toContain("Tab/↑↓ choose · Enter apply");
    frame = await fixture.press("TAB");
    expect(frame).toContain("> @-");
    expect(frame).toContain("Tab/↑↓ choose · Enter insert");
    frame = await fixture.press("ARROW_DOWN");
    expect(frame).toContain("> mine()");
    frame = await fixture.press("RETURN");
    // Inserting fills the field, keeps the editor open and applies nothing.
    expect(frame).toContain("Edit revset");
    expect(frame).toContain("Revset: mine()");
    expect(frame).toContain("Custom revset · Limit: 100");
    expect(fixture.opened).toEqual([]);
    frame = await fixture.press("RETURN");
    expect(frame).not.toContain("Edit revset");
    expect(frame).toContain("Subject mm");
    expect(fixture.previousInputs.list()).toEqual(["mine()", "@-"]);
  } finally {
    await fixture.close();
  }
});

test("a failing revset keeps the editor and the draft, names the reason, and records nothing", async () => {
  const fixture = await createTestEditorHistory({
    queries: { "bad()": { names: [], error: "Function `bad` doesn't exist\nCaused by:  --> 1:1" } },
  });
  try {
    await fixture.press("L");
    await fixture.press("u", { ctrl: true });
    await fixture.type("bad()");
    const frame = await fixture.press("F2");
    expect(frame).toContain("Edit revset");
    expect(frame).toContain("Revset: bad()");
    expect(frame).toContain("Revset not applied: Function `bad` doesn't exist");
    expect(frame).toContain("Caused by:  --> 1:1");
    expect(fixture.previousInputs.list()).toEqual([]);
    // Behind the editor the accepted view is unchanged.
    expect(fixture.controller.getSnapshot().rows.map((row) => row.commit.displayId)).toEqual([
      "aaa",
      "bbb",
      "ccc",
    ]);
    // Editing the draft clears the notice.
    expect(await fixture.type("x")).not.toContain("Revset not applied");
  } finally {
    await fixture.close();
  }
});

test("an empty draft is refused with the empty-input sentence", async () => {
  const fixture = await createTestEditorHistory();
  try {
    await fixture.press("L");
    await fixture.press("u", { ctrl: true });
    const frame = await fixture.press("F2");
    expect(frame).toContain("Enter a revset, or choose Reset.");
    expect(frame).toContain("Edit revset");
    expect(fixture.opened).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("Reset restores launch policy and adds no previous input", async () => {
  const fixture = await createTestEditorHistory({ queries: { "@-": { names: ["pa"] } } });
  try {
    await fixture.press("L");
    await fixture.press("u", { ctrl: true });
    await fixture.type("@-");
    await fixture.press("F2");
    expect(await flush(fixture.setup)).toContain("Subject pa");
    await fixture.press("L");
    const frame = await fixture.press("F3");
    expect(frame).not.toContain("Edit revset");
    expect(frame).toContain(`Revset: ${LAUNCH}`);
    expect(frame).toContain("Launch policy · Limit: 100");
    expect(frame).toContain("Subject aaa");
    expect(frame).not.toContain("graph links and range review unavailable");
    expect(fixture.previousInputs.list()).toEqual(["@-"]);
  } finally {
    await fixture.close();
  }
});

test("Esc while applying aborts the candidate and returns to the editor with the draft", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await createTestEditorHistory({ queries: { slow: { names: ["ss"], gate } } });
  try {
    await fixture.press("L");
    await fixture.press("u", { ctrl: true });
    await fixture.type("slow");
    let frame = await fixture.press("F2");
    expect(frame).toContain("Applying revset…");
    expect(frame).toContain("[F2] Apply (busy)  [F3] Reset (busy)  [Esc] Cancel");
    expect(frame).not.toContain("Previous inputs");
    frame = await fixture.press("ESCAPE");
    expect(frame).toContain("Edit revset");
    expect(frame).toContain("Revset: slow");
    expect(frame).not.toContain("Applying revset…");
    release();
    frame = await flush(fixture.setup);
    expect(frame).toContain("Edit revset");
    expect(frame).toContain("Subject aaa");
    expect(fixture.previousInputs.list()).toEqual([]);
    // A second Esc closes the editor.
    expect(await fixture.press("ESCAPE")).not.toContain("Edit revset");
  } finally {
    await fixture.close();
  }
});

test("Escape closes the editor before it clears a selection, and the selection survives", async () => {
  const fixture = await createTestEditorHistory();
  try {
    await fixture.press("v");
    await fixture.press("ARROW_DOWN");
    expect(await flush(fixture.setup)).toContain("2 in review range");
    await fixture.press("L");
    const frame = await fixture.press("ESCAPE");
    expect(frame).not.toContain("Edit revset");
    expect(frame).toContain("2 in review range");
  } finally {
    await fixture.close();
  }
});

test("under 15 rows launch policy adds nothing and the compact editor fills 11 rows", async () => {
  const fixture = await createTestEditorHistory({
    width: 40,
    height: 12,
    queries: { "@-": { names: ["pa"] } },
  });
  try {
    let frame = await flush(fixture.setup);
    expect(frame).not.toContain("Revset:");
    expect(frame).not.toContain("Launch policy");
    frame = await fixture.press("L");
    expect(frame).toContain("Edit revset");
    expect(frame).toContain("Launch policy · Limit: 100");
    expect(frame).toContain("[F2] Apply  [F3] Reset");
    await fixture.press("u", { ctrl: true });
    await fixture.type("@-");
    frame = await fixture.press("F2");
    expect(frame).toContain("Custom revset: @-");
    expect(frame).not.toContain("graph links");
    expect(frame).not.toContain("Limit:");
  } finally {
    await fixture.close();
  }
});

test("too small a terminal shows the message and still cancels", async () => {
  const fixture = await createTestEditorHistory({ width: 24, height: 8 });
  try {
    const frame = await fixture.press("L");
    expect(frame).toContain("Terminal too small for");
    expect(frame).toContain("[Esc] Cancel");
    expect(await fixture.press("ESCAPE")).not.toContain("Terminal too small");
  } finally {
    await fixture.close();
  }
});

test("clicking Apply, Cancel, Reset and a previous input works with the mouse", async () => {
  const previousInputs = new PreviousInputs();
  previousInputs.record("@-");
  const fixture = await createTestEditorHistory({
    previousInputs,
    queries: { "@-": { names: ["pa"] } },
  });
  try {
    const click = async (text: string) => {
      const lines = (await flush(fixture.setup)).split("\n");
      const y = lines.findIndex((line) => line.includes(text));
      if (y < 0) throw new Error(`Missing ${text}`);
      await act(async () => fixture.setup.mockMouse.click(lines[y]!.indexOf(text), y));
      return flush(fixture.setup);
    };
    await fixture.press("L");
    let frame = await click("@-");
    expect(frame).toContain("Revset: @-");
    expect(frame).toContain("Edit revset");
    frame = await click("[F2] Apply");
    expect(frame).not.toContain("Edit revset");
    expect(frame).toContain("Subject pa");
    await fixture.press("L");
    frame = await click("[Esc] Cancel");
    expect(frame).not.toContain("Edit revset");
    await fixture.press("L");
    frame = await click("[F3] Reset");
    expect(frame).toContain("Subject aaa");
  } finally {
    await fixture.close();
  }
});

test("the View menu offers Edit revset… only to a provider that can edit", async () => {
  for (const editable of [true, false]) {
    const fixture = await createTestEditorHistory({ editable });
    try {
      await fixture.press("F10");
      const frame = await fixture.press("ARROW_RIGHT");
      expect(frame.includes("Edit revset…")).toBe(editable);
      expect(frame).toContain("Choose theme");
    } finally {
      await fixture.close();
    }
  }
});

test("an Apply restarts the watch on the accepted query without an extra refresh", async () => {
  const fixture = await createTestEditorHistory({
    watch: true,
    queries: { "@-": { names: ["pa"] } },
  });
  try {
    await flush(fixture.setup);
    // Returning from a review refreshes once when the watch starts.
    expect(fixture.reopens).toEqual(["launch"]);
    expect(fixture.signatures).toEqual(["launch"]);
    await fixture.press("L");
    await fixture.press("u", { ctrl: true });
    await fixture.type("@-");
    await fixture.press("F2");
    await flush(fixture.setup);
    expect(fixture.controller.getSnapshot().query).toMatchObject({ mode: "custom", generation: 1 });
    // The restarted watch fingerprints the accepted query and does not refresh again.
    expect(fixture.signatures.at(-1)).toBe("@-");
    expect(fixture.reopens).toEqual(["launch"]);
  } finally {
    await fixture.close();
  }
});

test("auto-refresh waits while the editor is open and runs once after it closes", async () => {
  const fixture = await createTestEditorHistory({ watch: true });
  try {
    await flush(fixture.setup);
    expect(fixture.reopens).toEqual(["launch"]);
    await fixture.press("L");
    // The provider reports a change while the editor is open.
    fixture.changeSignature();
    let frame = await flush(fixture.setup);
    const deadline = Date.now() + 14_000;
    while (
      !frame.includes("refresh will run when the current interaction ends") &&
      Date.now() < deadline
    ) {
      await Bun.sleep(250);
      frame = await flush(fixture.setup);
    }
    // The change is held back, with a notice, while the editor is open.
    expect(frame).toContain("History changed; refresh will run when the current interaction ends.");
    expect(frame).toContain("Edit revset");
    expect(fixture.reopens).toEqual(["launch"]);
    await fixture.press("ESCAPE");
    await Bun.sleep(300);
    await flush(fixture.setup);
    expect(fixture.reopens).toEqual(["launch", "launch"]);
  } finally {
    await fixture.close();
  }
}, 40_000);

test("an applied revset with no revisions says so and keeps the status line quiet", async () => {
  const fixture = await createTestEditorHistory({ queries: { "none()": { names: [] } } });
  try {
    await fixture.press("L");
    await fixture.press("u", { ctrl: true });
    await fixture.type("none()");
    const frame = await fixture.press("F2");
    expect(frame).toContain("Revset: none()");
    expect(frame).toContain("No revisions match this revset.");
    expect(frame).toContain("Jujutsu · 0 commits");
    expect(frame).toContain("Custom revset: graph links and range review unavailable.");
  } finally {
    await fixture.close();
  }
});

const F2 = "\x1bOQ";
const F3 = "\x1bOR";
const ENTER = "\r";
const DOWN = "\x1b[B";
const CTRL_U = "\x15";
const PAGE_DOWN = "\x1b[6~";

type Fixture = Awaited<ReturnType<typeof createTestEditorHistory>>;

/** Deliver several keys in one stdin chunk, as a terminal does for typed-ahead or pasted keys. */
async function chunk(fixture: Fixture, keys: string) {
  await act(async () => fixture.setup.mockInput.pressKey(keys));
  return flush(fixture.setup);
}

/** Find the first rendered text input, wherever it sits in the renderable tree. */
function findInput(fixture: Fixture) {
  const visit = (
    node: unknown,
  ): { maxLength: number; focused: boolean; value: string } | undefined => {
    const candidate = node as {
      maxLength?: unknown;
      focused?: boolean;
      value?: string;
      getChildren?: () => unknown[];
    };
    if (typeof candidate.maxLength === "number" && typeof candidate.value === "string")
      return candidate as { maxLength: number; focused: boolean; value: string };
    for (const child of candidate.getChildren?.() ?? []) {
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  return visit(fixture.setup.renderer.root);
}

async function clickFirst(fixture: Fixture, text: string) {
  const lines = (await flush(fixture.setup)).split("\n");
  const y = lines.findIndex((line) => line.includes(text));
  if (y < 0) throw new Error(`Missing ${text}:\n${lines.join("\n")}`);
  await act(async () => fixture.setup.mockMouse.click(lines[y]!.indexOf(text), y));
  return flush(fixture.setup);
}

describe("keys that arrive together each see the previous key's result", () => {
  test("opening, Ctrl+U, text and F2 in one chunk apply only the new text", async () => {
    const fixture = await createTestEditorHistory({ queries: { "@-": { names: ["pa"] } } });
    try {
      await chunk(fixture, `L${CTRL_U}@-${F2}`);
      expect(fixture.opened).toEqual(["@-"]);
      expect(fixture.controller.getSnapshot().query).toMatchObject({
        mode: "custom",
        expression: "@-",
      });
    } finally {
      await fixture.close();
    }
  });

  test("opening and native caret keys in one chunk edit at the requested position", async () => {
    const fixture = await createTestEditorHistory();
    try {
      await chunk(fixture, `L\x01x\x05${F2}`);
      expect(fixture.opened).toEqual([`x${LAUNCH}`]);
    } finally {
      await fixture.close();
    }
  });

  test("opening, cancelling and reopening in one chunk starts with a fresh native caret", async () => {
    const fixture = await createTestEditorHistory();
    try {
      await fixture.press("L");
      await fixture.press("a", { ctrl: true });
      await chunk(fixture, `\x1b[27uLx${F2}`);
      expect(fixture.opened).toEqual([`${LAUNCH}x`]);
    } finally {
      await fixture.close();
    }
  });

  test("opening and Unicode deletion in one chunk use the native editing rules", async () => {
    const fixture = await createTestEditorHistory();
    try {
      await chunk(fixture, `L${CTRL_U}a🙂\x7fz${F2}`);
      expect(fixture.opened).toEqual(["az"]);
    } finally {
      await fixture.close();
    }
  });

  test("a character and F2 in one chunk apply the character", async () => {
    const fixture = await createTestEditorHistory({ queries: { "@-": { names: ["pa"] } } });
    try {
      await fixture.press("L");
      await fixture.press("u", { ctrl: true });
      await fixture.type("@");
      await chunk(fixture, `-${F2}`);
      expect(fixture.opened).toEqual(["@-"]);
      expect(await flush(fixture.setup)).toContain("Revset: @-");
    } finally {
      await fixture.close();
    }
  });

  test("Ctrl+U, text and Enter in one chunk apply the text instead of closing as a no-op", async () => {
    const fixture = await createTestEditorHistory({ queries: { "@-": { names: ["pa"] } } });
    try {
      await fixture.press("L");
      await chunk(fixture, `${CTRL_U}@-${ENTER}`);
      expect(fixture.opened).toEqual(["@-"]);
      expect(fixture.controller.getSnapshot().query).toMatchObject({
        mode: "custom",
        expression: "@-",
      });
    } finally {
      await fixture.close();
    }
  });

  test("Down then Enter in one chunk insert the highlighted input and apply nothing", async () => {
    const previousInputs = new PreviousInputs();
    previousInputs.record("mine()");
    const fixture = await createTestEditorHistory({ previousInputs });
    try {
      await fixture.press("L");
      const frame = await chunk(fixture, `${DOWN}${ENTER}`);
      expect(frame).toContain("Edit revset");
      expect(frame).toContain("Revset: mine()");
      expect(fixture.opened).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("F2 twice in one chunk start one candidate", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await createTestEditorHistory({ queries: { "@-": { names: ["pa"], gate } } });
    try {
      await fixture.press("L");
      await fixture.press("u", { ctrl: true });
      await fixture.type("@-");
      await chunk(fixture, `${F2}${F2}${F3}`);
      expect(fixture.opened).toEqual(["@-"]);
      release();
      await flush(fixture.setup);
    } finally {
      await fixture.close();
    }
  });

  test("L and a mark key in one chunk open the editor and mark nothing", async () => {
    const fixture = await createTestEditorHistory();
    try {
      const frame = await chunk(fixture, "Lx");
      expect(frame).toContain("Edit revset");
      expect(fixture.controller.getSnapshot().marks).toEqual([]);
      expect(frame).not.toContain("1 marked");
    } finally {
      await fixture.close();
    }
  });
});

describe("editor rules each pinned by a test", () => {
  test("Ctrl+C cancels the editor and does not quit history", async () => {
    const fixture = await createTestEditorHistory();
    try {
      await fixture.press("L");
      const frame = await fixture.press("c", { ctrl: true });
      expect(frame).toContain("Launch policy");
      expect(frame).not.toContain("Edit revset");
      expect(fixture.outcomes).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("the session's raw-mode Ctrl+C is claimed by an open editor and by nothing else", async () => {
    const fixture = await createTestEditorHistory();
    try {
      expect(await fixture.interrupt()).toBeFalse();
      await fixture.press("L");
      expect(await fixture.interrupt()).toBeTrue();
      expect(await flush(fixture.setup)).not.toContain("Edit revset");
      expect(fixture.outcomes).toEqual([]);
      // With the editor closed the claim lets go, so the session quits as it did before.
      expect(await fixture.interrupt()).toBeFalse();
    } finally {
      await fixture.close();
    }
  });

  test("a claimed Ctrl+C while applying cancels the request and keeps the draft; a second closes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await createTestEditorHistory({ queries: { slow: { names: ["ss"], gate } } });
    try {
      await fixture.press("L");
      await fixture.press("u", { ctrl: true });
      await fixture.type("slow");
      expect(await fixture.press("F2")).toContain("Applying revset…");
      expect(await fixture.interrupt()).toBeTrue();
      const frame = await flush(fixture.setup);
      expect(frame).toContain("Edit revset");
      expect(frame).toContain("Revset: slow");
      expect(frame).not.toContain("Applying revset…");
      expect(await fixture.interrupt()).toBeTrue();
      expect(await flush(fixture.setup)).not.toContain("Edit revset");
      release();
      await flush(fixture.setup);
      expect(fixture.previousInputs.list()).toEqual([]);
      expect(fixture.outcomes).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("while busy: Enter, F2 and F3 start nothing, and the field is not focused", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await createTestEditorHistory({ queries: { slow: { names: ["ss"], gate } } });
    try {
      await fixture.press("L");
      expect(findInput(fixture)?.focused).toBeTrue();
      await fixture.press("u", { ctrl: true });
      await fixture.type("slow");
      await fixture.press("F2");
      expect(findInput(fixture)?.focused).toBeFalse();
      await fixture.press("RETURN");
      await fixture.press("F2");
      const frame = await fixture.press("F3");
      expect(fixture.opened).toEqual(["slow"]);
      expect(frame).toContain("Applying revset…");
      release();
      await flush(fixture.setup);
    } finally {
      await fixture.close();
    }
  });

  test("the field is given the 65,536-unit limit, not the input's default of 1,000", async () => {
    const fixture = await createTestEditorHistory();
    try {
      await fixture.press("L");
      expect(findInput(fixture)?.maxLength).toBe(65_536);
    } finally {
      await fixture.close();
    }
  });

  test("an outside click and a click on [Esc] close the editor", async () => {
    const fixture = await createTestEditorHistory();
    try {
      await fixture.press("L");
      await flush(fixture.setup);
      await act(async () => fixture.setup.mockMouse.click(1, 28));
      expect(await flush(fixture.setup)).not.toContain("Edit revset");
      await fixture.press("L");
      expect(await clickFirst(fixture, "[Esc]")).not.toContain("Edit revset");
    } finally {
      await fixture.close();
    }
  });

  test("Ctrl+C and an outside click while applying abort first and close second", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await createTestEditorHistory({ queries: { slow: { names: ["ss"], gate } } });
    try {
      await fixture.press("L");
      await fixture.press("u", { ctrl: true });
      await fixture.type("slow");
      await fixture.press("F2");
      let frame = await fixture.press("c", { ctrl: true });
      expect(frame).toContain("Edit revset");
      expect(frame).toContain("Revset: slow");
      expect(frame).not.toContain("Applying revset…");
      expect(fixture.outcomes).toEqual([]);

      await fixture.press("F2");
      await act(async () => fixture.setup.mockMouse.click(1, 28));
      frame = await flush(fixture.setup);
      expect(frame).toContain("Revset: slow");
      await act(async () => fixture.setup.mockMouse.click(1, 28));
      expect(await flush(fixture.setup)).not.toContain("Edit revset");
      release();
      await flush(fixture.setup);
      expect(fixture.previousInputs.list()).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("a pasted line break never acts as Enter", async () => {
    const fixture = await createTestEditorHistory();
    try {
      await fixture.press("L");
      await fixture.press("u", { ctrl: true });
      await act(async () => fixture.setup.mockInput.pasteBracketedText("mine()\n& bookmarks()"));
      const frame = await flush(fixture.setup);
      expect(frame).toContain("Edit revset");
      expect(frame).toContain("Revset: mine()& bookmarks()");
      expect(fixture.opened).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("an expression over 1,000 characters is applied whole", async () => {
    const long = `mine() & ${"description(substring:'x') | ".repeat(40)}none()`;
    expect(long.length).toBeGreaterThan(1_000);
    const fixture = await createTestEditorHistory({ queries: { [long]: { names: ["pa"] } } });
    try {
      await fixture.press("L");
      await fixture.press("u", { ctrl: true });
      await act(async () => fixture.setup.mockInput.pasteBracketedText(long));
      await flush(fixture.setup);
      await fixture.press("F2");
      expect(fixture.opened).toEqual([long]);
      expect(fixture.controller.getSnapshot().query?.expression).toBe(long);
    } finally {
      await fixture.close();
    }
  });

  test("a long error scrolls with PageDown and the wheel", async () => {
    const reason = Array.from({ length: 80 }, (_, index) => `reason line ${index}`).join("\n");
    const fixture = await createTestEditorHistory({
      queries: { bad: { names: [], error: reason } },
    });
    try {
      await fixture.press("L");
      await fixture.press("u", { ctrl: true });
      await fixture.type("bad");
      let frame = await fixture.press("F2");
      expect(frame).toContain("Revset not applied: reason line 0");
      expect(frame).toMatch(/PgUp\/PgDn scroll · \d+\/80 lines/);
      expect(frame).not.toContain("reason line 79");
      frame = await fixture.press(PAGE_DOWN);
      expect(frame).not.toContain("Revset not applied: reason line 0");
      expect(frame).toContain("reason line 20");
      const lines = frame.split("\n");
      const y = lines.findIndex((line) => line.includes("reason line 20"));
      await act(async () => fixture.setup.mockMouse.scroll(20, y, "down"));
      const wheeled = await flush(fixture.setup);
      expect(wheeled).not.toContain("reason line 20\n");
      expect(wheeled).toContain("reason line 21");
    } finally {
      await fixture.close();
    }
  });

  test("a failed Reset names the reason, keeps the draft and the custom view", async () => {
    const queries: Record<string, { names: string[]; error?: string }> = {
      "@-": { names: ["pa"] },
    };
    const fixture = await createTestEditorHistory({ queries });
    try {
      await fixture.press("L");
      await fixture.press("u", { ctrl: true });
      await fixture.type("@-");
      await fixture.press("F2");
      queries.launch = { names: [], error: "Could not run jj." };
      await fixture.press("L");
      await fixture.type("x");
      const frame = await fixture.press("F3");
      expect(frame).toContain("Reset failed: Could not run jj.");
      expect(frame).toContain("Revset: @-x");
      expect(fixture.controller.getSnapshot().query?.mode).toBe("custom");
      expect(fixture.previousInputs.list()).toEqual(["@-"]);
    } finally {
      await fixture.close();
    }
  });

  test("resizing with the editor open goes normal, compact, too small and back with the draft kept", async () => {
    const fixture = await createTestEditorHistory();
    try {
      await fixture.press("L");
      await fixture.press("u", { ctrl: true });
      await fixture.type("@-");
      const resize = async (width: number, height: number) => {
        await act(async () => fixture.setup.resize(width, height));
        return flush(fixture.setup);
      };
      expect(await resize(40, 24)).toContain("Edit revset");
      let frame = await resize(40, 12);
      expect(frame).toContain("Edit revset");
      expect(frame).toContain("Revset: @-");
      frame = await resize(20, 7);
      expect(frame).toContain("Terminal too small");
      frame = await resize(100, 30);
      expect(frame).toContain("Edit revset");
      expect(frame).toContain("Revset: @-");
      expect(findInput(fixture)?.value).toBe("@-");
    } finally {
      await fixture.close();
    }
  });

  test("a remapped key opens the editor and shows in the hint; an unbound one is dropped from the hint", async () => {
    const remapped = await createTestEditorHistory({
      keybindings: { "hunk.history.editRevset": "e" },
    });
    try {
      expect(await flush(remapped.setup)).toContain("e edit revset · v select");
      expect(await remapped.press("L")).not.toContain("Edit revset");
      expect(await remapped.press("e")).toContain("Edit revset");
    } finally {
      await remapped.close();
    }
    const unbound = await createTestEditorHistory({
      keybindings: { "hunk.history.editRevset": false },
    });
    try {
      const frame = await flush(unbound.setup);
      expect(frame).not.toContain("edit revset");
      expect(await unbound.press("L")).not.toContain("Edit revset");
      // The View menu still names the action and opens the editor.
      await unbound.press("F10");
      await unbound.press("ARROW_RIGHT");
      expect(await clickFirst(unbound, "Edit revset…")).toContain("Edit revset");
      expect(unbound.controller.getSnapshot().query?.mode).toBe("launch");
    } finally {
      await unbound.close();
    }
  });

  test("the View menu entry opens the editor", async () => {
    const fixture = await createTestEditorHistory();
    try {
      await fixture.press("F10");
      await fixture.press("ARROW_RIGHT");
      const frame = await clickFirst(fixture, "Edit revset…");
      expect(frame).toContain("[F2] Apply");
      expect(frame).toContain("Revset:");
    } finally {
      await fixture.close();
    }
  });

  test("help lists the key only for a provider that can edit", async () => {
    for (const editable of [true, false]) {
      const fixture = await createTestEditorHistory({ editable, height: 40 });
      try {
        const frame = await fixture.press("?");
        expect(frame.includes("edit revset…")).toBe(editable);
        expect(frame).toContain("refresh");
      } finally {
        await fixture.close();
      }
    }
  });

  test("an Apply while auto-refresh is off does not swallow the return-from-review refresh when it is turned on", async () => {
    const fixture = await createTestEditorHistory({
      watch: true,
      autoRefresh: false,
      queries: { "@-": { names: ["pa"] } },
    });
    try {
      await fixture.press("L");
      await fixture.press("u", { ctrl: true });
      await fixture.type("@-");
      await fixture.press("F2");
      expect(fixture.reopens).toEqual([]);
      await fixture.setAutoRefresh(true);
      expect(fixture.reopens).toEqual(["@-"]);
    } finally {
      await fixture.close();
    }
  });
});

describe("a programmatic field change reaches the field before the next key in the chunk", () => {
  const withInputs = () => {
    const previousInputs = new PreviousInputs();
    previousInputs.record("b-second");
    previousInputs.record("@--");
    return previousInputs;
  };

  test("Tab Tab Enter, text and F2 in one chunk apply the inserted input plus the text", async () => {
    const fixture = await createTestEditorHistory({ previousInputs: withInputs() });
    try {
      await fixture.press("L");
      await chunk(fixture, `\t\t${ENTER}-${F2}`);
      expect(fixture.opened).toEqual(["b-second-"]);
    } finally {
      await fixture.close();
    }
  });

  test("Tab Enter, text and Enter in one chunk insert, extend, then apply", async () => {
    const fixture = await createTestEditorHistory({ previousInputs: withInputs() });
    try {
      await fixture.press("L");
      await chunk(fixture, `\t${ENTER}-${ENTER}`);
      expect(fixture.opened).toEqual(["@---"]);
    } finally {
      await fixture.close();
    }
  });

  test("L and a bracketed paste in one chunk keep the paste in the draft, without its line breaks", async () => {
    const fixture = await createTestEditorHistory();
    try {
      await chunk(fixture, "L\x1b[200~ & mine()\n& bookmarks()\x1b[201~");
      expect(findInput(fixture)?.value).toBe(`${LAUNCH} & mine()& bookmarks()`);
    } finally {
      await fixture.close();
    }
  });

  test("L and a character in one chunk keep the character in the draft", async () => {
    const fixture = await createTestEditorHistory();
    try {
      await chunk(fixture, "L-");
      const frame = await flush(fixture.setup);
      expect(frame).toContain("Edit revset");
      expect(frame).toContain(`Revset: ${LAUNCH}-`);
      expect(findInput(fixture)?.value).toBe(`${LAUNCH}-`);
      await fixture.press("F2");
      expect(fixture.opened).toEqual([`${LAUNCH}-`]);
    } finally {
      await fixture.close();
    }
  });

  test("text typed after Apply in the same chunk does not edit the field while busy", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await createTestEditorHistory({ queries: { "@": { names: ["ss"], gate } } });
    try {
      await fixture.press("L");
      await fixture.press("u", { ctrl: true });
      await fixture.type("@");
      await chunk(fixture, `${F2}xyz`);
      expect(fixture.opened).toEqual(["@"]);
      const frame = await fixture.press("ESCAPE");
      expect(frame).toContain("Revset: @");
      expect(frame).not.toContain("@xyz");
      expect(findInput(fixture)?.value).toBe("@");
      release();
      await flush(fixture.setup);
    } finally {
      await fixture.close();
    }
  });
});

describe("the draft and its caret survive what the editor cannot show", () => {
  test("a resize before React commits prevents hidden keys and Apply", async () => {
    const fixture = await createTestEditorHistory({ width: 80, height: 24 });
    try {
      await fixture.press("L");
      await chunk(fixture, CTRL_U);
      await fixture.type("abcdef");
      await act(async () => {
        fixture.setup.resize(80, 7);
        fixture.setup.mockInput.pressKey(`${CTRL_U}@-${F2}${F3}${ENTER}`);
      });
      expect(fixture.opened).toEqual([]);
      await act(async () => fixture.setup.resize(80, 24));
      await flush(fixture.setup);
      expect(findInput(fixture)?.value).toBe("abcdef");
    } finally {
      await fixture.close();
    }
  });

  test("a resize before React commits prevents hidden paste", async () => {
    const fixture = await createTestEditorHistory({ width: 80, height: 24 });
    try {
      await fixture.press("L");
      await chunk(fixture, CTRL_U);
      await fixture.type("abcdef");
      await act(async () => {
        fixture.setup.resize(80, 7);
        fixture.setup.mockInput.pasteBracketedText("XYZ");
      });
      await act(async () => fixture.setup.resize(80, 24));
      await flush(fixture.setup);
      expect(findInput(fixture)?.value).toBe("abcdef");
      expect(fixture.opened).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("clicking an unchanged previous input puts the native caret at its end", async () => {
    const previousInputs = new PreviousInputs();
    previousInputs.record("mine()");
    const fixture = await createTestEditorHistory({ previousInputs });
    try {
      await fixture.press("L");
      await chunk(fixture, CTRL_U);
      await fixture.type("mine()");
      await fixture.press("a", { ctrl: true });
      await clickFirst(fixture, "  mine()");
      await chunk(fixture, `Z${F2}`);
      expect(fixture.opened).toEqual(["mine()Z"]);
    } finally {
      await fixture.close();
    }
  });

  test("reinserting unchanged text puts the native caret at its end", async () => {
    const previousInputs = new PreviousInputs();
    previousInputs.record("mine()");
    const fixture = await createTestEditorHistory({ previousInputs });
    try {
      await fixture.press("L");
      await chunk(fixture, CTRL_U);
      await fixture.type("mine()");
      await fixture.press("a", { ctrl: true });
      await chunk(fixture, `\t${ENTER}Z${F2}`);
      expect(fixture.opened).toEqual(["mine()Z"]);
    } finally {
      await fixture.close();
    }
  });

  const LEFT = "\x1b[D";
  const BACKSPACE = "\x7f";
  const resize = async (fixture: Fixture, width: number, height: number) => {
    await act(async () => fixture.setup.resize(width, height));
    return flush(fixture.setup);
  };

  test("on the too-small screen no key edits or applies the draft, and a resize back finds it as it was", async () => {
    const fixture = await createTestEditorHistory({ width: 80, height: 24 });
    try {
      await fixture.press("L");
      await chunk(fixture, CTRL_U);
      await fixture.type("abcdef");
      await chunk(fixture, LEFT + LEFT + LEFT);
      expect(await resize(fixture, 80, 7)).toContain("Terminal too small");
      await fixture.type("XY");
      await chunk(fixture, BACKSPACE);
      await chunk(fixture, ENTER);
      await chunk(fixture, F2);
      await chunk(fixture, F3);
      expect(await flush(fixture.setup)).toContain("Terminal too small");
      expect(fixture.opened).toEqual([]);
      const frame = await resize(fixture, 80, 24);
      expect(frame).toContain("Edit revset");
      expect(findInput(fixture)?.value).toBe("abcdef");
    } finally {
      await fixture.close();
    }
  });

  test("Esc on the too-small screen still closes the editor", async () => {
    const fixture = await createTestEditorHistory({ width: 80, height: 24 });
    try {
      await fixture.press("L");
      await resize(fixture, 80, 7);
      expect(await fixture.press("ESCAPE")).not.toContain("Terminal too small");
      await resize(fixture, 80, 24);
      expect(await flush(fixture.setup)).not.toContain("Edit revset");
    } finally {
      await fixture.close();
    }
  });

  test("typing in the middle of the field keeps the caret where it is", async () => {
    const fixture = await createTestEditorHistory();
    try {
      await fixture.press("L");
      await chunk(fixture, CTRL_U);
      await fixture.type("abcdef");
      await chunk(fixture, LEFT + LEFT + LEFT);
      await fixture.type("Z");
      await fixture.type("Y");
      expect(findInput(fixture)?.value).toBe("abcZYdef");
    } finally {
      await fixture.close();
    }
  });

  test("an inserted previous input replaces the text and leaves the caret at its end", async () => {
    const previousInputs = new PreviousInputs();
    previousInputs.recordOutcome({ kind: "apply", expression: "mine()" }, {
      status: "applied",
    } as never);
    const fixture = await createTestEditorHistory({ previousInputs });
    try {
      await fixture.press("L");
      await chunk(fixture, CTRL_U);
      await fixture.type("abcdef");
      await chunk(fixture, LEFT + LEFT + LEFT);
      await fixture.press("TAB");
      await chunk(fixture, ENTER);
      expect(findInput(fixture)?.value).toBe("mine()");
      await fixture.type("Z");
      expect(findInput(fixture)?.value).toBe("mine()Z");
    } finally {
      await fixture.close();
    }
  });

  test("a frame that went compact for the list stays compact while it applies", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previousInputs = new PreviousInputs();
    previousInputs.recordOutcome({ kind: "apply", expression: "@-" }, {
      status: "applied",
    } as never);
    const fixture = await createTestEditorHistory({
      width: 40,
      height: 15,
      previousInputs,
      queries: { x: { names: ["xx"], gate } },
    });
    try {
      await fixture.press("L");
      await chunk(fixture, CTRL_U);
      await fixture.type("x");
      const titleRow = (frame: string) =>
        frame.split("\n").findIndex((l) => l.includes("Edit revset"));
      const idle = await flush(fixture.setup);
      const busy = await fixture.press("F2");
      expect(busy).toContain("Applying revset…");
      expect(titleRow(busy)).toBe(titleRow(idle));
      release();
      await flush(fixture.setup);
    } finally {
      await fixture.close();
    }
  });
});
