import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();
const fixture = fileURLToPath(new URL("./fixtures/revision-source-panel.tsx", import.meta.url));
setDefaultTimeout(20_000);
afterEach(async () => {
  await harness.cleanup();
});

/** Launch a labeled test harness, leaving all staged human candidates untouched. */
async function launchSourcePanelTest(cols: number) {
  const session = await harness.launchShellCommand({
    command: `exec ${harness.shellQuote(process.execPath)} ${harness.shellQuote(fixture)}`,
    cols,
    rows: 12,
  });
  await session.waitForText(/1 selected/, { timeout: 10_000 });
  return session;
}

describe("prepared source panel PTY", () => {
  for (const cols of [80, 120]) {
    test(`Space and nested mark clicks preserve focus; lock retains marks at ${cols} columns`, async () => {
      const session = await launchSourcePanelTest(cols);
      try {
        await session.press("down");
        await session.press("space");
        let frame = await harness.waitForSnapshot(
          session,
          (text) => text.includes("2 selected"),
          5_000,
        );
        expect(frame).toMatch(/^> ✓   Revision B/m);
        // Tuistory text adds one presentation newline before the first terminal row.
        const y = frame
          .replace(/^\n/, "")
          .split("\n")
          .findIndex((line) => line.includes("Revision C"));
        session.writeRaw(`\x1b[<0;3;${y + 1}M\x1b[<0;3;${y + 1}m`);
        frame = await harness.waitForSnapshot(
          session,
          (text) => text.includes("3 selected"),
          5_000,
        );
        expect(frame).toMatch(/^> ✓   Revision B/m);
        await session.click("Enter Continue");
        frame = await harness.waitForSnapshot(
          session,
          (text) => text.includes("Sources locked (test harness)"),
          5_000,
        );
        expect(frame).toMatch(/^  ✓   Revision A/m);
        expect(frame).toMatch(/^  ✓   Revision C/m);
        expect(frame).not.toContain("Select/unselect");
      } finally {
        session.close();
      }
    });
  }

  test("empty sources refuse Enter and show Cancel after a narrow resize", async () => {
    const session = await launchSourcePanelTest(80);
    try {
      await session.press("space");
      await session.waitForText(/0 selected/);
      await session.press("enter");
      let frame = await harness.waitForSnapshot(
        session,
        (text) => text.includes("Select at least one revision"),
        5_000,
      );
      expect(frame).not.toContain("Sources locked");
      session.resize({ cols: 28, rows: 12 });
      frame = await harness.waitForSnapshot(
        session,
        (text) => text.includes("Esc Cancel") && text.includes("0 selected"),
        5_000,
      );
      expect(frame).toContain("Space Select/unselect");
      await session.press("escape");
      frame = await harness.waitForSnapshot(
        session,
        (text) => text.includes("Source selection cancelled"),
        5_000,
      );
      expect(frame).not.toContain("✓");
      expect(frame).toMatch(/^>     Revision A/m);
    } finally {
      session.close();
    }
  });
});
