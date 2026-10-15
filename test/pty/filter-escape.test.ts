import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

/** PTY launches slow down as the suite mounts many renderers in one process; give startup headroom. */
setDefaultTimeout(45_000);

afterEach(() => {
  harness.cleanup();
});

describe("filter escape clearing (PTY)", () => {
  test("a second Escape clears a re-typed no-match filter query", async () => {
    const fixture = harness.createSidebarJumpRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 12,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });

      // Open filter, type a no-match query.
      await session.press("tab");
      await harness.waitForSnapshot(
        session,
        (t) => t.includes("filter: text; !text excludes"),
        5_000,
      );
      await session.type("zzz");
      await harness.waitForSnapshot(session, (t) => t.includes("No files match"), 5_000);

      // First Escape clears the text (keeps the input focused / placeholder shown).
      await harness.pressAndWaitForSnapshot(
        session,
        "escape",
        (t) => t.includes("filter: text; !text excludes"),
        5_000,
      );

      // Re-type a no-match query.
      await session.type("zzz");
      await harness.waitForSnapshot(session, (t) => t.includes("No files match"), 5_000);

      // Second Escape must clear again, just like the first.
      const cleared = await harness.pressAndWaitForSnapshot(
        session,
        "escape",
        (t) => t.includes("filter: text; !text excludes") && t.includes("alphaOnly = true"),
        5_000,
      );

      expect(cleared).toContain("filter: text; !text excludes");
      expect(cleared).toContain("alphaOnly = true");
      expect(cleared).not.toContain("No files match");
    } finally {
      session.close();
    }
  });

  test("filter exclusion at 120x30: typing, backspacing, visible-hunk navigation, mouse jumps, and hidden note recovery (PTY Scenario 4)", async () => {
    const fixture = harness.createFilterScenarioRepoFixtureTest();
    const session = await harness.launchHunk({
      args: [
        "diff",
        "HEAD~1",
        "--mode",
        "split",
        "--agent-context",
        fixture.sidecarPath,
        "--agent-notes",
      ],
      cwd: fixture.dir,
      cols: 120,
      rows: 30,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });

      // Initially files are present in the review stream and summary-match.ts note is visible
      let snapshot = await session.text({ immediate: true });
      expect(snapshot).toContain("README.md");
      expect(snapshot).toContain("summary-match.ts");
      expect(snapshot).toContain("Note on summary match");
      expect(snapshot).not.toContain("mainDestination");

      // Focus filter with Tab
      await session.press("tab");
      await harness.waitForSnapshot(
        session,
        (t) => t.includes("filter: text; !text excludes") || t.includes("filter:"),
        5_000,
      );

      // Type !doc: excludes docs/README.md and renamed-note.md; keeps summary-match.ts and main.ts
      await session.type("!doc");
      const excludedDoc = await harness.waitForSnapshot(
        session,
        (t) => t.includes("filter: !doc") && !t.includes("docs/README.md"),
        5_000,
      );
      expect(excludedDoc).not.toContain("docs/README.md");
      expect(excludedDoc).not.toContain("renamed-note.md");
      expect(excludedDoc).toContain("summary-match.ts");
      expect(excludedDoc).toContain("!foo.ts");

      // Genuine backspace: remove 'doc' -> query becomes '!'
      await session.press(["backspace", "backspace", "backspace"]);
      const bareBang = await harness.waitForSnapshot(
        session,
        (t) => t.includes("filter: !") && t.includes("docs/README.md"),
        5_000,
      );
      expect(bareBang).toContain("docs/README.md");
      expect(bareBang).toContain("renamed-note.md");

      // Type !foo -> !!foo excludes literal !foo:
      await session.type("!foo");
      const excludedBang120 = await harness.waitForSnapshot(
        session,
        (t) => t.includes("filter: !!foo") && !t.includes("!foo.ts"),
        5_000,
      );
      expect(excludedBang120).not.toContain("!foo.ts");
      expect(excludedBang120).toContain("summary-match.ts");

      // Escape clears to empty
      await session.press("escape");
      await harness.waitForSnapshot(
        session,
        (t) => t.includes("filter: text; !text excludes") && t.includes("README.md"),
        5_000,
      );

      // Type \!foo to search for literal !foo:
      await session.type("\\!foo");
      const escapedBang120 = await harness.waitForSnapshot(
        session,
        (t) => t.includes("filter: \\!foo") && t.includes("!foo.ts"),
        5_000,
      );
      expect(escapedBang120).toContain("!foo.ts");
      expect(escapedBang120).not.toContain("README.md");

      // Clear filter with Escape to prepare for non-monotonic !R test
      await session.press("escape");
      await harness.waitForSnapshot(
        session,
        (t) => t.includes("filter: text; !text excludes") && t.includes("README.md"),
        5_000,
      );

      // Non-monotonic typing: type 'R' -> query is !R.
      // Every file contains 'r' in path, renamed origin, or agent summary, so all are excluded.
      await session.type("!R");
      await harness.waitForSnapshot(
        session,
        (t) => t.includes("filter: !R") && t.includes("No files match the current filter"),
        5_000,
      );

      // Type 'EADME.md' -> query is !README.md: narrowing the exclusion operand makes main.ts and !foo.ts reappear
      await session.type("EADME.md");
      const excludedReadme = await harness.waitForSnapshot(
        session,
        (t) =>
          t.includes("filter: !README.md") &&
          t.includes("main.ts") &&
          !t.includes("renamed-note.md"),
        5_000,
      );
      expect(excludedReadme).toContain("filter: !README.md");
      expect(excludedReadme).toContain("main.ts");
      expect(excludedReadme).toContain("!foo.ts");
      expect(excludedReadme).not.toContain("renamed-note.md");
      expect(excludedReadme).not.toContain("summary-match.ts");
      expect(excludedReadme).not.toContain("Note on summary match");
      expect(excludedReadme).not.toContain("mainDestination");

      // Non-monotonic backspace: backspacing to !R makes files disappear again
      await session.press(Array.from({ length: 8 }, () => "backspace"));
      await harness.waitForSnapshot(
        session,
        (t) => t.includes("filter: !R") && t.includes("No files match the current filter"),
        5_000,
      );

      // Re-type EADME.md -> !README.md
      await session.type("EADME.md");
      await harness.waitForSnapshot(
        session,
        (t) => t.includes("filter: !README.md") && t.includes("main.ts"),
        5_000,
      );

      // Enter retains the filter in review navigation mode
      await session.press("return");
      const retained = await harness.waitForSnapshot(
        session,
        (t) => t.includes("filter=!README.md"),
        5_000,
      );
      expect(retained).toContain("filter=!README.md");
      expect(retained).toContain("main.ts");
      expect(retained).toContain("!foo.ts");

      // Separate hidden-selection preservation before explicit navigation changes it:
      // Tab to edit filter, Escape clears filter text, restoring summary-match.ts and its note
      await session.press("tab");
      await harness.waitForSnapshot(session, (t) => t.includes("filter: !README.md"), 5_000);
      await session.press("escape");
      const recoveredHidden = await harness.waitForSnapshot(
        session,
        (t) => t.includes("Note on summary match") && t.includes("summary-match.ts"),
        5_000,
      );
      expect(recoveredHidden).toContain("Note on summary match");
      expect(recoveredHidden).toContain("summary-match.ts");

      // Re-apply filter !README.md to test explicit navigation and mouse jump
      await session.type("!README.md");
      await session.press("return");
      await harness.waitForSnapshot(
        session,
        (t) => t.includes("filter=!README.md") && t.includes("main.ts"),
        5_000,
      );

      // Visible-hunk navigation: [ and ] step through visible files only.
      // Destination content mainDestination is currently below the viewport.
      expect(await session.text({ immediate: true })).not.toContain("mainDestination");

      // Advance from hidden selection to first visible file src/!foo.ts
      await session.press("]");
      // Advance to next visible file src/main.ts, revealing mainDestination
      const steppedForward = await harness.pressAndWaitForSnapshot(
        session,
        "]",
        (t) => t.includes("mainDestination"),
        5_000,
      );
      expect(steppedForward).toContain("mainDestination");

      // Stepping back with [ returns to !foo.ts, hiding mainDestination
      await session.press("[");
      const steppedBack = await harness.waitForSnapshot(
        session,
        (t) => !t.includes("mainDestination") && t.includes("export const bangFoo"),
        5_000,
      );
      expect(steppedBack).toContain("export const bangFoo");
      expect(steppedBack).not.toContain("mainDestination");

      // Mouse jump: click on visible main.ts file header to scroll down to main.ts
      await session.click(/main\.ts/, { first: true });
      const mouseJumped = await harness.waitForSnapshot(
        session,
        (t) => t.includes("mainDestination"),
        5_000,
      );
      expect(mouseJumped).toContain("mainDestination");

      // Reload with disk mutation: replace in-view mainDestination in main.ts, press r, and verify new marker appears
      const currentMain = readFileSync(join(fixture.dir, "src", "main.ts"), "utf-8");
      writeFileSync(
        join(fixture.dir, "src", "main.ts"),
        currentMain.replace(
          "export const mainDestination = 9999;",
          "export const reloadMarker120 = 7777;",
        ),
      );
      await harness.pressAndWaitForSnapshot(
        session,
        "r",
        (t) => t.includes("reloadMarker120") && t.includes("filter=!README.md"),
        15_000,
      );
      const reloadedText = await session.text({ immediate: true });
      expect(reloadedText).toContain("reloadMarker120");
      expect(reloadedText).toContain("filter=!README.md");

      // Tab back to edit the filter and clear
      await session.press("tab");
      await harness.waitForSnapshot(session, (t) => t.includes("filter: !README.md"), 5_000);
      await session.press("escape");
      await harness.waitForSnapshot(
        session,
        (t) => t.includes("filter: text; !text excludes") && t.includes("README.md"),
        5_000,
      );

      // Second Escape returns to review
      await session.press("escape");
      await harness.waitForSnapshot(session, (t) => !t.includes("filter:"), 5_000);
    } finally {
      session.close();
    }
  });

  test("filter exclusion at 80x24: exclusion, backspacing, !!foo, \\!foo, zero-match resize, and recovery (PTY Scenario 4)", async () => {
    const fixture = harness.createFilterScenarioRepoFixtureTest();
    const session = await harness.launchHunk({
      args: [
        "diff",
        "HEAD~1",
        "--mode",
        "split",
        "--agent-context",
        fixture.sidecarPath,
        "--agent-notes",
      ],
      cwd: fixture.dir,
      cols: 80,
      rows: 24,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });

      // Initially files are present in the review stream and summary-match.ts note is visible
      const initial80 = await session.text({ immediate: true });
      expect(initial80).toContain("README.md");
      expect(initial80).toContain("summary-match.ts");
      expect(initial80).toContain("Note on summary match");
      expect(initial80).not.toContain("mainDestination");

      // Focus filter with Tab at 80x24
      await session.press("tab");
      await harness.waitForSnapshot(
        session,
        (t) => t.includes("filter: text; !text excludes") || t.includes("filter:"),
        5_000,
      );

      // Non-monotonic typing: type '!R' -> all files excluded
      await session.type("!R");
      await harness.waitForSnapshot(
        session,
        (t) => t.includes("filter: !R") && t.includes("No files match the current filter"),
        5_000,
      );

      // Narrowing operand by typing 'EADME.md' makes !foo.ts reappear
      await session.type("EADME.md");
      const excluded80 = await harness.waitForSnapshot(
        session,
        (t) =>
          t.includes("filter: !README.md") &&
          t.includes("!foo.ts") &&
          !t.includes("renamed-note.md"),
        5_000,
      );
      expect(excluded80).toContain("filter: !README.md");
      expect(excluded80).toContain("!foo.ts");
      expect(excluded80).not.toContain("renamed-note.md");
      expect(excluded80).not.toContain("summary-match.ts");
      expect(excluded80).not.toContain("Note on summary match");
      expect(excluded80).not.toContain("mainDestination");

      // Backspace 'EADME.md' back to !R -> files disappear again
      await session.press(Array.from({ length: 8 }, () => "backspace"));
      await harness.waitForSnapshot(
        session,
        (t) => t.includes("filter: !R") && t.includes("No files match"),
        5_000,
      );

      // Backspace 'R' -> bare ! keeps all files visible
      await session.press("backspace");
      const bang80 = await harness.waitForSnapshot(
        session,
        (t) => t.includes("filter: !") && t.includes("renamed-note.md"),
        5_000,
      );
      expect(bang80).toContain("renamed-note.md");

      // Type !foo -> !!foo excludes literal !foo:
      await session.type("!foo");
      const excludedBang = await harness.waitForSnapshot(
        session,
        (t) => t.includes("filter: !!foo") && !t.includes("!foo.ts"),
        5_000,
      );
      expect(excludedBang).not.toContain("!foo.ts");
      expect(excludedBang).toContain("summary-match.ts");

      // Escape clears to empty
      await session.press("escape");
      await harness.waitForSnapshot(
        session,
        (t) => t.includes("filter: text; !text excludes") && t.includes("README.md"),
        5_000,
      );

      // Type \!foo to search for literal !foo:
      await session.type("\\!foo");
      const escapedBang = await harness.waitForSnapshot(
        session,
        (t) => t.includes("filter: \\!foo") && t.includes("!foo.ts"),
        5_000,
      );
      expect(escapedBang).toContain("!foo.ts");
      expect(escapedBang).not.toContain("README.md");

      // Clear filter to prepare for hidden note recovery test
      await session.press("escape");
      await harness.waitForSnapshot(
        session,
        (t) => t.includes("filter: text; !text excludes") && t.includes("README.md"),
        5_000,
      );

      // Type !README.md to hide summary-match.ts and its note
      await session.type("!README.md");
      await session.press("return");
      const retained80 = await harness.waitForSnapshot(
        session,
        (t) => t.includes("filter=!README.md") && t.includes("!foo.ts"),
        5_000,
      );
      expect(retained80).toContain("filter=!README.md");
      expect(retained80).toContain("!foo.ts");

      // Hidden note recovery BEFORE explicit navigation changes selection:
      // Tab to edit filter, Escape clears filter text, restoring summary-match.ts and its note
      await session.press("tab");
      await harness.waitForSnapshot(session, (t) => t.includes("filter: !README.md"), 5_000);
      await session.press("escape");
      const recoveredHidden80 = await harness.waitForSnapshot(
        session,
        (t) => t.includes("Note on summary match") && t.includes("summary-match.ts"),
        5_000,
      );
      expect(recoveredHidden80).toContain("Note on summary match");
      expect(recoveredHidden80).toContain("summary-match.ts");

      // Re-apply filter !README.md to test visible-hunk navigation and mouse jumps
      await session.type("!README.md");
      await session.press("return");
      await harness.waitForSnapshot(
        session,
        (t) => t.includes("filter=!README.md") && t.includes("!foo.ts"),
        5_000,
      );

      // Visible-hunk navigation at 80x24: [ and ] step between visible files.
      // Destination content mainDestination is currently below the fold.
      expect(await session.text({ immediate: true })).not.toContain("mainDestination");

      // Advance from hidden selection to first visible file src/!foo.ts
      await session.press("]");
      // Advance to next visible file src/main.ts, revealing mainDestination
      const steppedForward80 = await harness.pressAndWaitForSnapshot(
        session,
        "]",
        (t) => t.includes("mainDestination"),
        5_000,
      );
      expect(steppedForward80).toContain("mainDestination");

      // Stepping back with [ returns to !foo.ts, hiding mainDestination
      const steppedBack80 = await harness.pressAndWaitForSnapshot(
        session,
        "[",
        (t) => !t.includes("mainDestination") && t.includes("export const bangFoo"),
        5_000,
      );
      expect(steppedBack80).toContain("export const bangFoo");
      expect(steppedBack80).not.toContain("mainDestination");

      // Mouse jump at 80x24: click on visible main.ts file header to scroll down to main.ts
      await session.click(/main\.ts/, { first: true });
      const mouseJumped80 = await harness.waitForSnapshot(
        session,
        (t) => t.includes("mainDestination"),
        5_000,
      );
      expect(mouseJumped80).toContain("mainDestination");

      // Reload with disk mutation: replace in-view mainDestination in main.ts, press r, and verify new marker appears
      const currentMain80 = readFileSync(join(fixture.dir, "src", "main.ts"), "utf-8");
      writeFileSync(
        join(fixture.dir, "src", "main.ts"),
        currentMain80.replace(
          "export const mainDestination = 9999;",
          "export const reloadMarker80 = 888;",
        ),
      );
      await harness.pressAndWaitForSnapshot(
        session,
        "r",
        (t) => t.includes("reloadMarker80") && t.includes("filter=!README.md"),
        15_000,
      );
      const reloaded80 = await session.text({ immediate: true });
      expect(reloaded80).toContain("reloadMarker80");
      expect(reloaded80).toContain("filter=!README.md");

      // Tab back to edit the filter and clear
      await session.press("tab");
      await harness.waitForSnapshot(session, (t) => t.includes("filter: !README.md"), 5_000);
      await session.press("escape");
      await harness.waitForSnapshot(
        session,
        (t) => t.includes("filter: text; !text excludes") && t.includes("!foo.ts"),
        5_000,
      );

      // Type zero match query: 'zzz'
      await session.type("zzz");
      await harness.waitForSnapshot(
        session,
        (t) => t.includes("No files match the current filter") || t.includes("No files match"),
        5_000,
      );

      // Resize terminal to short height 80x12: does not trap input
      session.resize({ cols: 80, rows: 12 });
      await harness.waitForSnapshot(session, (t) => t.includes("No files match"), 5_000);

      // Escape clears zero match, restoring files
      await session.press("escape");
      const recovered = await harness.waitForSnapshot(
        session,
        (t) =>
          (t.includes("summary-match.ts") || t.includes("!foo.ts")) &&
          t.includes("filter: text; !text excludes"),
        5_000,
      );
      expect(recovered).toContain("filter: text; !text excludes");

      // Second Escape leaves filter and returns to review
      await session.press("escape");
      await harness.waitForSnapshot(session, (t) => !t.includes("filter:"), 5_000);
    } finally {
      session.close();
    }
  });
});
