import { describe, expect, test } from "bun:test";
import { KeyEvent } from "@opentui/core";
import { MouseButtons } from "@opentui/core/testing";
import { testRender as renderTestSourcePanel } from "@opentui/react/test-utils";
import { act } from "react";
import {
  createTestRevisionSourcePanelController,
  TestRevisionSourcePanel,
} from "../../../../../test/helpers/revision-source-panel";
import { measureTextWidth } from "../lib/text";
import { resolveTheme } from "../themes";
import { RevisionSourceSelection } from "./revisionSourceSelection";
import {
  RevisionSourcePanel,
  handleRevisionSourcePanelKey,
  revisionSourcePanelLayout,
  type RevisionSourcePanelState,
} from "./RevisionSourcePanel";

/** Mount the real renderer inside React act so the initial frame has settled. */
async function testRender(...args: Parameters<typeof renderTestSourcePanel>) {
  let setup: Awaited<ReturnType<typeof renderTestSourcePanel>>;
  await act(async () => {
    setup = await renderTestSourcePanel(...args);
  });
  return setup!;
}

const ready: RevisionSourcePanelState = {
  selectedCount: 2,
  targets: { kind: "ready", source: "marks", generation: 0, revisionIds: ["A", "C"] },
};
const states: Record<string, RevisionSourcePanelState> = {
  ready,
  empty: { selectedCount: 0, targets: { kind: "empty" } },
  checking: { selectedCount: 2, targets: { kind: "blocked", reason: "checking", unresolved: [] } },
  unresolved: {
    selectedCount: 3,
    targets: { kind: "blocked", reason: "unresolved", unresolved: [] },
  },
  failed: {
    selectedCount: 2,
    targets: { kind: "blocked", reason: "refresh-failed", unresolved: [] },
  },
  refused: { ...ready, continueRefusal: "Squash requires exactly one source revision." },
};
const theme = resolveTheme("github-dark-default", null);

/** Record which shared callback each source gesture invokes. */
function createTestSourceActions() {
  const calls: string[] = [];
  return {
    calls,
    actions: {
      toggle: () => calls.push("toggle"),
      continue: () => calls.push("continue"),
      cancel: () => calls.push("cancel"),
      reviewMarks: () => calls.push("review"),
    },
  };
}

/** Construct a parsed key without bypassing release/modifier fields. */
function createTestSourceKey(name: string, extras: Partial<KeyEvent> = {}) {
  return new KeyEvent({
    name,
    ctrl: false,
    meta: false,
    option: false,
    shift: false,
    sequence: "",
    raw: "",
    number: false,
    eventType: "press",
    source: "raw",
    ...extras,
  });
}

describe("prepared source panel", () => {
  for (const width of [28, 42, 60, 80, 120])
    for (const [name, state] of Object.entries(states)) {
      test(`${name} renders every enabled control at ${width} columns`, async () => {
        const { actions } = createTestSourceActions();
        const layout = revisionSourcePanelLayout({
          operationLabel: name === "refused" ? "squash" : "rebase",
          width,
          state,
          actions,
        });
        const setup = await testRender(
          <RevisionSourcePanel
            operationLabel={name === "refused" ? "squash" : "rebase"}
            width={width}
            state={state}
            actions={actions}
            theme={theme}
          />,
          { width, height: 12 },
        );
        try {
          await act(async () => setup.renderOnce());
          const frame = setup.captureCharFrame();
          const lines = frame.trimEnd().split("\n");
          expect(lines.length).toBe(layout.rows);
          expect(frame).toContain("Esc Cancel");
          expect(frame.includes("Enter Continue")).toBe(name === "ready");
          expect(frame.includes("Space Select/unselect")).toBe(
            !["checking", "failed"].includes(name),
          );
          expect(frame.includes("R Review marks")).toBe(["failed", "unresolved"].includes(name));
          for (const line of lines) expect(measureTextWidth(line)).toBeLessThanOrEqual(width);
          if (width >= 80) expect(layout.rows).toBe(3);
          if (name === "failed" && width < 60) expect(frame).toContain("cancel.");
        } finally {
          await act(async () => {
            setup.renderer.destroy();
          });
        }
      });
    }

  test("blocked Enter/Space cannot fall through to history and modified/navigation keys remain host-owned", () => {
    for (const [name, state] of Object.entries(states)) {
      const { calls, actions } = createTestSourceActions();
      expect(handleRevisionSourcePanelKey(createTestSourceKey("space"), state, actions)).toBe(true);
      expect(handleRevisionSourcePanelKey(createTestSourceKey("return"), state, actions)).toBe(
        true,
      );
      expect(calls).toEqual(
        name === "ready"
          ? ["toggle", "continue"]
          : ["checking", "failed"].includes(name)
            ? []
            : ["toggle"],
      );
      for (const key of ["up", "down", "pageup", "pagedown", "x"])
        expect(handleRevisionSourcePanelKey(createTestSourceKey(key), state, actions)).toBe(false);
      for (const modifier of ["ctrl", "shift", "meta", "option", "super", "hyper"] as const)
        expect(
          handleRevisionSourcePanelKey(
            createTestSourceKey("space", { [modifier]: true }),
            state,
            actions,
          ),
        ).toBe(false);
      expect(
        handleRevisionSourcePanelKey(
          createTestSourceKey("space", { eventType: "release" }),
          state,
          actions,
        ),
      ).toBe(false);
      expect(handleRevisionSourcePanelKey(createTestSourceKey("escape"), state, actions)).toBe(
        true,
      );
      expect(calls.at(-1)).toBe("cancel");
    }
    const { calls, actions } = createTestSourceActions();
    expect(
      handleRevisionSourcePanelKey(
        createTestSourceKey("return"),
        {
          ...ready,
          targets: {
            ...(ready.targets as Extract<RevisionSourcePanelState["targets"], { kind: "ready" }>),
            source: "highlight",
          },
        },
        actions,
      ),
    ).toBe(true);
    expect(calls).toEqual([]);
    expect(
      handleRevisionSourcePanelKey(createTestSourceKey("r"), states.unresolved!, actions),
    ).toBe(true);
    expect(calls).toEqual(["review"]);
  });

  test("held source keys are consumed once without repeating actions", () => {
    const { calls, actions } = createTestSourceActions();
    for (const name of ["space", "return", "enter", "escape"]) {
      expect(
        handleRevisionSourcePanelKey(
          createTestSourceKey(name, { eventType: "repeat" }),
          ready,
          actions,
        ),
      ).toBe(true);
      expect(
        handleRevisionSourcePanelKey(createTestSourceKey(name, { repeated: true }), ready, actions),
      ).toBe(true);
    }
    expect(
      handleRevisionSourcePanelKey(
        createTestSourceKey("r", { eventType: "repeat" }),
        states.unresolved!,
        actions,
      ),
    ).toBe(true);
    expect(calls).toEqual([]);
  });

  test("every footer action ignores secondary clicks and invokes its shared callback once", async () => {
    for (const [state, label, expected] of [
      [ready, "Space Select/unselect", "toggle"],
      [ready, "Enter Continue", "continue"],
      [ready, "Esc Cancel", "cancel"],
      [states.unresolved!, "R Review marks", "review"],
    ] as const) {
      const { calls, actions } = createTestSourceActions();
      const setup = await testRender(
        <RevisionSourcePanel
          operationLabel="rebase"
          width={80}
          state={state}
          actions={actions}
          theme={theme}
        />,
        { width: 80, height: 8 },
      );
      try {
        await act(async () => setup.renderOnce());
        const lines = setup.captureCharFrame().split("\n");
        const y = lines.findIndex((line) => line.includes(label));
        expect(y).toBeGreaterThanOrEqual(0);
        const x = lines[y]!.indexOf(label);
        await act(async () => setup.mockMouse.click(x, y, MouseButtons.RIGHT));
        expect(calls).toEqual([]);
        await act(async () => setup.mockMouse.click(x, y, MouseButtons.LEFT));
        expect(calls).toEqual([expected]);
      } finally {
        await act(async () => {
          setup.renderer.destroy();
        });
      }
    }
  });

  test("sanitizes refusal text and marks truncation while preserving Cancel", async () => {
    const { actions } = createTestSourceActions();
    const state = { ...ready, continueRefusal: "\x1b[31mDenied\x1b[0m\n" + "修正 ".repeat(40) };
    const layout = revisionSourcePanelLayout({
      operationLabel: "squash",
      width: 28,
      state,
      actions,
    });
    expect(layout.status).toHaveLength(2);
    expect(layout.status.join(" ")).not.toContain("\x1b");
    expect(layout.status[1]).toEndWith("…");
    const setup = await testRender(
      <RevisionSourcePanel
        operationLabel="squash"
        width={28}
        state={state}
        actions={actions}
        theme={theme}
      />,
      { width: 28, height: 12 },
    );
    try {
      await act(async () => setup.renderOnce());
      expect(setup.captureCharFrame()).toContain("Esc Cancel");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("real core preserves focus on Space/nested mark clicks and retains locked membership", async () => {
    const controller = await createTestRevisionSourcePanelController();
    const selection = new RevisionSourceSelection(controller, () => ({ eligible: true }));
    const visit = Symbol("test source visit");
    expect(selection.begin(visit).kind).toBe("changed");
    let continued = 0;
    const setup = await testRender(
      <TestRevisionSourcePanel
        controller={controller}
        selection={selection}
        visit={visit}
        width={80}
        onContinue={() => {
          continued++;
        }}
      />,
      { width: 80, height: 12 },
    );
    try {
      await act(async () => setup.renderOnce());
      await act(async () => {
        setup.mockInput.pressKey("ARROW_DOWN");
        await controller.settleNavigation();
      });
      await act(async () => {
        setup.mockInput.pressKey(" ");
        await Bun.sleep(0);
        await setup.renderOnce();
      });
      expect(controller.getSnapshot().selected).toBe(1);
      expect(selection.targets(visit)).toMatchObject({ revisionIds: ["A", "B"] });
      await act(async () => {
        await setup.mockMouse.click(2, 3, MouseButtons.LEFT);
        await setup.renderOnce();
      });
      expect(controller.getSnapshot().selected).toBe(1);
      expect(selection.targets(visit)).toMatchObject({ revisionIds: ["A", "B", "C"] });
      await act(async () => {
        await setup.mockMouse.click(2, 3, MouseButtons.RIGHT);
        await setup.renderOnce();
      });
      expect(selection.targets(visit)).toMatchObject({ revisionIds: ["A", "B", "C"] });
      await act(async () => {
        setup.mockInput.pressKey("RETURN");
        await Bun.sleep(0);
        await setup.renderOnce();
      });
      await act(async () => setup.renderOnce());
      expect(continued).toBe(1);
      expect(setup.captureCharFrame()).toContain("Sources locked (test harness)");
      expect(setup.captureCharFrame()).not.toContain("Select/unselect");
      await act(async () => {
        await setup.mockMouse.click(2, 3, MouseButtons.LEFT);
        await setup.renderOnce();
      });
      expect(controller.getSnapshot().selected).toBe(1);
      expect(selection.indicator("C")).toBe("✓");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
      await controller.close();
    }
  });

  test("empty set blocks keyboard/mouse Continue; Cancel removes indicators", async () => {
    const controller = await createTestRevisionSourcePanelController();
    const selection = new RevisionSourceSelection(controller, () => ({ eligible: true }));
    const visit = Symbol("empty test visit");
    selection.begin(visit);
    let continued = 0;
    const setup = await testRender(
      <TestRevisionSourcePanel
        controller={controller}
        selection={selection}
        visit={visit}
        width={80}
        onContinue={() => {
          continued++;
        }}
      />,
      { width: 80, height: 12 },
    );
    try {
      await act(async () => setup.renderOnce());
      await act(async () => {
        await setup.mockMouse.click(2, 1);
        await setup.renderOnce();
      });
      expect(selection.targets(visit)).toEqual({ kind: "empty" });
      expect(setup.captureCharFrame()).toContain("Select at least one revision");
      expect(setup.captureCharFrame()).not.toContain("Enter Continue");
      await act(async () => {
        setup.mockInput.pressKey("RETURN");
        await Bun.sleep(0);
        await setup.renderOnce();
      });
      expect(continued).toBe(0);
      await act(async () => {
        setup.mockInput.pressKey("ESCAPE");
        // The raw parser waits before interpreting a lone Escape as a key.
        await Bun.sleep(60);
        await setup.renderOnce();
      });
      await act(async () => setup.renderOnce());
      expect(setup.captureCharFrame()).toContain("Source selection cancelled");
      expect(selection.indicator("A")).toBe(" ");
      expect(controller.getSnapshot().selected).toBe(0);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
      await controller.close();
    }
  });
});
