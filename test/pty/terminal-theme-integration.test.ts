import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { setDetectedTerminalColors } from "../../packages/hunk/src/core/theme/terminalColors";
import {
  createTestTerminalResponder,
  deriveAddedRowColorsTest as deriveAddedRowColors,
  TEST_TERMINAL_PALETTE_A as PALETTE_A,
  TEST_TERMINAL_PALETTE_B as PALETTE_B,
  waitForForegroundTest as waitForForeground,
} from "../helpers/terminalResponderTest";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
  setDetectedTerminalColors(undefined);
});

describe("PTY terminal theme", () => {
  test("repaints from a fresh terminal palette after a dark-to-dark color-scheme notification", async () => {
    const fixture = harness.createAgentFilePair();
    const expectedA = deriveAddedRowColors(PALETTE_A);
    const expectedB = deriveAddedRowColors(PALETTE_B);
    const terminal = createTestTerminalResponder(PALETTE_A);
    const session = await harness.launchHunk({
      args: [
        "diff",
        "--files",
        fixture.before,
        fixture.after,
        "--mode",
        "unified",
        "--theme",
        "terminal",
      ],
      cwd: fixture.dir,
      cols: 100,
      rows: 24,
      testTerminalResponder: terminal.respond,
    });

    try {
      await session.waitForText("export const answer = 42;");
      expect(await waitForForeground(session, expectedA.keyword, "export")).toContain("const");
      expect(await waitForForeground(session, expectedA.text, "answer")).toContain("added");

      terminal.setPalette(PALETTE_B);
      session.writeRaw("\x1b[?997;1n");

      expect(await waitForForeground(session, expectedB.keyword, "export")).toContain("const");
      expect(await waitForForeground(session, expectedB.text, "answer")).toContain("added");
      expect(
        await session.text({ immediate: true, only: { foreground: expectedA.keyword } }),
      ).not.toContain("export");
    } finally {
      session.close();
    }
  });
});
