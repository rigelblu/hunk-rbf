import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPtyHarness } from "./harness";
import { contrastRatio } from "../../packages/hunk/src/ui/lib/color";

const harness = createPtyHarness();

/** Give source loading and asynchronous Shiki highlighting enough headroom in CI. */
setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

/** Create contiguous added TypeScript lines for main-thread or worker highlighting. */
function createHighlightTestFiles(lineCount: number) {
  const dir = mkdtempSync(join(tmpdir(), "hunk-highlight-worker-"));
  const before = join(dir, "before.ts");
  const after = join(dir, "after.ts");
  const contents = Array.from(
    { length: lineCount },
    (_, index) => `export const workerLine${index} = ${index};`,
  ).join("\n");
  writeFileSync(before, "");
  writeFileSync(after, `${contents}\n`);
  return { after, before, dir };
}

/** Return generated worker-line indexes visible in one PTY snapshot. */
function visibleWorkerLineIndexes(snapshot: string) {
  return Array.from(snapshot.matchAll(/workerLine(\d+)/g), (match) => Number(match[1]));
}

describe("PTY syntax highlighting", () => {
  test("highlights a small diff using the main-thread WASM engine", async () => {
    const fixture = createHighlightTestFiles(2);
    try {
      const session = await harness.launchHunk({
        args: ["diff", "--files", fixture.before, fixture.after, "--mode", "unified"],
        cwd: fixture.dir,
        cols: 100,
        rows: 24,
      });
      await session.waitForText("export const workerLine0 = 0;");
      let keywords = "";
      for (let iteration = 0; iteration < 200; iteration += 1) {
        await session.waitIdle({ timeout: 50 });
        keywords = await session.text({ immediate: true, only: { foreground: "#ff7b72" } });
        if (keywords.includes("export")) break;
      }
      expect(keywords).toContain("export");
      session.close();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("keeps key input responsive while a large added file highlights", async () => {
    const fixture = createHighlightTestFiles(8_000);
    const session = await harness.launchHunk({
      args: ["diff", "--files", fixture.before, fixture.after, "--fast", "--mode", "unified"],
      cwd: fixture.dir,
      cols: 120,
      rows: 24,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      const initial = await session.waitForText(/export const workerLine\d+ = \d+;/, {
        timeout: 15_000,
      });
      const lastInitialLineIndex = Math.max(...visibleWorkerLineIndexes(initial));
      expect(lastInitialLineIndex).toBeGreaterThanOrEqual(0);

      // Effects schedule highlighting after the first plain-text paint. Inject input as soon as
      // source rows make that paint observable, then require Hunk to process the navigation.
      // Tuistory's press() waits up to 500ms for idleness, so observe the viewport instead.
      session.sendKey("pagedown");
      await harness.waitForSnapshot(
        session,
        (snapshot) =>
          visibleWorkerLineIndexes(snapshot).some((index) => index > lastInitialLineIndex),
        1_000,
      );

      let colored = "";
      for (let iteration = 0; iteration < 200; iteration += 1) {
        await session.waitIdle({ timeout: 50 });
        colored = await session.text({ immediate: true, only: { foreground: "#ff7b72" } });
        if (colored.includes("export")) {
          break;
        }
      }
      expect(colored).toContain("export");
    } finally {
      session.close();
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("keeps code after a hidden Elixir heredoc opener out of the string token state", async () => {
    const fixture = harness.createElixirHeredocRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "unified"],
      cwd: fixture.dir,
      cols: 100,
      rows: 24,
    });

    try {
      await session.waitForText(/Line five, edited/, { timeout: 15_000 });

      let keywords = "";
      let comments = "";
      let editedCommentLine = session.getTerminalData().lines.find((line) =>
        line.spans
          .map((span) => span.text)
          .join("")
          .includes("Line five, edited."),
      );
      for (let iteration = 0; iteration < 200; iteration += 1) {
        await session.waitIdle({ timeout: 50 });
        keywords = await session.text({ immediate: true, only: { foreground: "#ff7b72" } });
        comments = await session.text({ immediate: true, only: { foreground: "#8b949e" } });
        editedCommentLine = session.getTerminalData().lines.find((line) =>
          line.spans
            .map((span) => span.text)
            .join("")
            .includes("Line five, edited."),
        );
        if (keywords.includes("def") && editedCommentLine) {
          break;
        }
      }

      expect(keywords).toContain("def");
      expect(editedCommentLine).toBeDefined();
      expect(
        editedCommentLine?.spans.some(
          (span) =>
            span.text.includes("Line five") && span.fg === "#8b949e" && span.bg === "#12251d",
        ),
      ).toBe(true);
      expect(
        editedCommentLine?.spans.some(
          (span) =>
            span.text.includes(", edited") && span.fg === "#939ba5" && span.bg === "#163923",
        ),
      ).toBe(true);
      // Upstream moved github-dark's added row and word highlight; both pinned pairs clear 4.5:1.
      expect(contrastRatio("#8b949e", "#12251d")).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio("#939ba5", "#163923")).toBeGreaterThanOrEqual(4.5);
      expect(comments).toContain('"""');
      expect(
        await session.text({ immediate: true, only: { foreground: "#a5d6ff" } }),
      ).not.toContain("def hello");
    } finally {
      session.close();
    }
  });
});
