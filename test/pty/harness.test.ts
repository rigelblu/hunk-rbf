import { describe, expect, test } from "bun:test";
import type { Session } from "tuistory";
import {
  createPtyHarness,
  measureKeyScroll,
  measureMouseWheelScroll,
  revealAddNoteOnRow,
} from "./harness";

/** Keep old output visible after input idles, then deliver unrelated paint and anchor movement. */
function createTestScrollSession(screens: string[]) {
  const inputs: string[] = [];
  let frame = 0;
  const session: Pick<Session, "press" | "scrollDown" | "scrollUp" | "text"> = {
    async press(key) {
      inputs.push(String(key));
    },
    async scrollDown() {
      inputs.push("wheel down");
    },
    async scrollUp() {
      inputs.push("wheel up");
    },
    async text(options) {
      if (typeof options?.waitFor === "function") {
        while (frame < screens.length) {
          const text = screens[frame]!;
          if (options.waitFor(text)) return text;
          frame += 1;
        }
        throw new Error("No delayed frame matched the destination");
      }
      return screens[frame]!;
    },
  };
  return { inputs, session };
}

/** Simulate a key whose first output-idle cycle ends before its destination is painted. */
function createTestTransitionSession(screens: string[]) {
  const inputs: Parameters<Session["sendKey"]>[0][] = [];
  let frame = 0;
  const session: Pick<Session, "sendKey" | "text" | "waitForText" | "waitIdle"> = {
    sendKey(key) {
      inputs.push(key);
    },
    async text() {
      return screens[frame]!;
    },
    async waitForText() {
      frame = screens.length - 1;
      return screens[frame]!;
    },
    async waitIdle() {
      frame = Math.min(frame + 1, screens.length - 1);
    },
  };
  return { inputs, session };
}

/** Simulate a stale badge disappearing only after the current mouse move produces output. */
function createTestHoverSession() {
  const inputs: string[] = [];
  let screen = "stale [+]";
  let resolveData: (() => void) | undefined;
  const session: Pick<Session, "waitForData" | "writeRaw" | "waitIdle" | "getTerminalData"> = {
    waitForData() {
      return new Promise<void>((resolve) => {
        resolveData = resolve;
      });
    },
    writeRaw(input) {
      inputs.push(input);
      screen = inputs.length === 1 ? "current row without badge" : "current row [+]";
      resolveData?.();
      resolveData = undefined;
    },
    async waitIdle() {},
    getTerminalData() {
      const lines: Array<{ spans: Array<{ text: string }> }> = Array.from({ length: 7 }, () => ({
        spans: [],
      }));
      lines[6] = { spans: [{ text: screen }] };
      return { lines } as unknown as ReturnType<Session["getTerminalData"]>;
    },
  };
  return { inputs, session };
}

describe("PTY transition synchronization", () => {
  test("measures key movement after idle and ignores unrelated text repaint", async () => {
    const { session, inputs } = createTestScrollSession([
      "heading\nanchor\nlast",
      "new heading\nanchor\nlast",
      "anchor\nlast\nnext",
    ]);
    expect(await measureKeyScroll(session, "j", 1, { waitForMovement: true })).toBe(1);
    expect(inputs).toEqual(["j"]);
  });

  for (const direction of ["down", "up"] as const) {
    test(`measures delayed wheel ${direction} movement from one event`, async () => {
      const { session, inputs } = createTestScrollSession([
        "heading\nanchor\nlast",
        direction === "down" ? "anchor\nlast\nnext" : "next\nheading\nanchor",
      ]);
      expect(await measureMouseWheelScroll(session, direction, 1, { waitForMovement: true })).toBe(
        direction === "down" ? 1 : -1,
      );
      expect(inputs).toEqual([`wheel ${direction}`]);
    });
  }

  test("keeps zero movement observable for cursor-only callers", async () => {
    const { session, inputs } = createTestScrollSession(["heading\nanchor\nlast"]);
    expect(await measureKeyScroll(session, "j", 1)).toBe(0);
    expect(inputs).toEqual(["j"]);
  });

  test("reports missing movement without retrying input", async () => {
    const { session, inputs } = createTestScrollSession(["heading\nanchor\nlast"]);
    await expect(measureKeyScroll(session, "j", 1, { waitForMovement: true })).rejects.toThrow(
      "No delayed frame matched the destination",
    );
    expect(inputs).toEqual(["j"]);
  });

  test("waits past shared content until the destination is visible", async () => {
    const { session, inputs } = createTestTransitionSession([
      "Second history commit — review",
      "Second history commit — Enter open",
    ]);
    const harness = createPtyHarness();
    const snapshot = await harness.pressAndWaitForSnapshot(session, "q", (text) =>
      text.includes("Enter open"),
    );
    expect(snapshot).toBe("Second history commit — Enter open");
    expect(inputs).toEqual(["q"]);
  });

  test("reports a missing destination without retrying the key", async () => {
    const { session, inputs } = createTestTransitionSession(["Draft note — body"]);
    const harness = createPtyHarness();
    await expect(
      harness.pressAndWaitForSnapshot(
        session,
        ["ctrl", "s"],
        (text) => !text.includes("Draft note") && text.includes("Your note"),
        1,
      ),
    ).rejects.toThrow("Last snapshot:\nDraft note — body");
    expect(inputs).toEqual([["ctrl", "s"]]);
  });

  test("rejects a predicate that cannot distinguish the destination", async () => {
    const { session, inputs } = createTestTransitionSession(["Shared content"]);
    const harness = createPtyHarness();
    await expect(
      harness.pressAndWaitForSnapshot(session, "q", (text) => text.includes("Shared content")),
    ).rejects.toThrow("destination was visible before the keypress");
    expect(inputs).toEqual([]);
  });

  test("waits directly for text produced by a key transition", async () => {
    const { session, inputs } = createTestTransitionSession(["Review", "Theme selector"]);
    const harness = createPtyHarness();
    await expect(harness.pressAndWaitForText(session, "t", /Theme selector/)).resolves.toBe(
      "Theme selector",
    );
    expect(inputs).toEqual(["t"]);
  });

  test("rejects text already visible before the key transition", async () => {
    const { session, inputs } = createTestTransitionSession(["Draft note — body"]);
    const harness = createPtyHarness();
    await expect(harness.pressAndWaitForText(session, ["ctrl", "s"], /Draft note/)).rejects.toThrow(
      "destination was visible before the keypress",
    );
    expect(inputs).toEqual([]);
  });

  test("does not accept a hover badge left by the preceding mouse position", async () => {
    const { session, inputs } = createTestHoverSession();
    await revealAddNoteOnRow(session as Session, 6);
    expect(inputs).toHaveLength(2);
  });
});
