import { describe, expect, test } from "bun:test";
import { measureTextWidth } from "../lib/text";
import { planHistoryPage } from "../../core/history/lanePlanner";
import { resolveHistoryTitlePalette } from "./titlePalette";
import type { HistoryCommit } from "../../core/history/types";
import {
  formatHistoryDecorations,
  foreground,
  getHistoryCommitIdBounds,
  projectHistoryRecord,
  projectHistoryRow,
  renderHistoryContinuation,
  renderHistoryConvergence,
  renderHistoryGraph,
  resolveHistoryColor,
  resolveHistoryTheme,
} from "./staticProjection";

const commit: HistoryCommit = {
  revisionId: "a".repeat(40),
  displayId: "aaaaaaaa",
  parentRevisionIds: ["b".repeat(40), "c".repeat(40)],
  subject: "Improve 日本語 rendering\x1b]52;c;cHdu\x07\nspoof",
  body: "First paragraph.\n\nSecond paragraph.",
  authorName: "Ada\rLovelace",
  authoredAt: "2026-01-02T03:04:05Z",
  decorations: [
    { kind: "head", label: "HEAD\x1b[2J", attachedLocalBranch: "main" },
    { kind: "local-branch", label: "main" },
    { kind: "remote-branch", label: "origin/main" },
    { kind: "tag", label: "v1.0.0" },
  ],
};
const row = planHistoryPage([commit]).rows[0]!;

describe("static history projection", () => {
  test("renders portable graph palettes", () => {
    expect(renderHistoryGraph(row, false)).toBe("●─┬");
    expect(renderHistoryGraph(row, true)).toBe("*-+");

    const octopus = planHistoryPage([{ ...commit, parentRevisionIds: ["b", "c", "d"] }]).rows[0]!;
    expect(renderHistoryGraph(octopus, false)).toBe("●─┬─┬");
    expect(renderHistoryGraph(octopus, true)).toBe("*-+-+");
  });

  test("sanitizes metadata and fits narrow output by display cells", () => {
    const text = projectHistoryRow(row, { ascii: false, color: false, width: 40 });
    expect(text).not.toContain("\x1b");
    expect(text).not.toContain("\n");
    expect(text).toContain("aaaaaaaa");
  });

  test("reports the compact commit-id hit target in display cells", () => {
    const bounds = getHistoryCommitIdBounds(row);
    const text = projectHistoryRow(row, { ascii: false, color: false });
    expect(text.slice(bounds.start, bounds.end)).toBe("aaaaaaaa");
    expect(bounds.end - bounds.start).toBe(8);
  });

  test("honors actual sub-20-column terminal widths", () => {
    for (const width of [1, 8, 19]) {
      const lines = projectHistoryRecord(row, { ascii: false, color: false, width });
      expect(lines.every((line) => measureTextWidth(line) <= width)).toBe(true);
    }
  });

  test("keeps complete logical rows when width is omitted", () => {
    const text = projectHistoryRow(row, { ascii: true, color: false });
    expect(text).toContain("Improve 日本語 rendering");
    expect(text).toContain("AdaLovelace");
    expect(text).toContain("2026-01-02");
  });

  test("renders Git-like medium records with full metadata, bodies, and typed decorations", () => {
    const lines = projectHistoryRecord(row, { ascii: false, color: false });
    expect(lines.join("\n")).toContain(`commit ${"a".repeat(40)}`);
    expect(lines.join("\n")).toContain("Author: AdaLovelace");
    expect(lines.join("\n")).toContain("Date:   2026-01-02 03:04:05Z");
    expect(lines.join("\n")).toContain("First paragraph.");
    const continuation = renderHistoryContinuation(row, false);
    expect(lines[3]).toBe(continuation);
    expect(lines[4]).toBe(`${continuation}      Improve 日本語 renderingspoof`);
    expect(lines[5]).toBe(continuation);
    expect(lines[6]).toBe(`${continuation}      First paragraph.`);
    expect(lines.at(-1)).toBe(continuation);
    expect(formatHistoryDecorations(row)).toBe(" (HEAD -> main, origin/main, tag: v1.0.0)");
  });

  test("renders the golden no-fast-forward merge convergence", () => {
    const planned = planHistoryPage([
      { ...commit, revisionId: "merge", parentRevisionIds: ["main", "side"] },
      { ...commit, revisionId: "side", parentRevisionIds: ["main"], decorations: [] },
      { ...commit, revisionId: "main", parentRevisionIds: [], decorations: [] },
    ]);
    expect(renderHistoryConvergence(planned.rows[1]!, false)).toBe("│╯");
    expect(renderHistoryConvergence(planned.rows[1]!, true)).toBe("|/");
  });

  test("resolves colors through the shared Hunk theme catalog", () => {
    expect(resolveHistoryTheme("catppuccin-mocha").id).toBe("catppuccin-mocha");
  });

  test("honors explicit color over terminal conventions", () => {
    expect(
      resolveHistoryColor({ mode: "always", stdoutIsTTY: false, env: { NO_COLOR: "1" } }),
    ).toBe(true);
    expect(resolveHistoryColor({ mode: "auto", stdoutIsTTY: true, env: { NO_COLOR: "1" } })).toBe(
      false,
    );
    expect(resolveHistoryColor({ mode: "auto", stdoutIsTTY: true, env: { NO_COLOR: "" } })).toBe(
      false,
    );
    expect(resolveHistoryColor({ mode: "auto", stdoutIsTTY: true, env: { TERM: "dumb" } })).toBe(
      false,
    );
  });
});

describe("known-empty static history titles", () => {
  test("colors only surviving labels and preserves compact/medium text at every width", () => {
    const theme = resolveHistoryTheme("github-dark-default");
    const palette = resolveHistoryTitlePalette(theme);
    for (const subject of [
      "(no description set)",
      "A described revision",
      "Title (no description set)",
    ]) {
      const input = planHistoryPage([
        { ...commit, subject, isEmpty: true, decorations: [], parentRevisionIds: [] },
      ]).rows[0]!;
      for (const width of [1, 8, 14, 20, 40, 80, undefined]) {
        const options = { ascii: true, color: false, width, theme };
        const plain = projectHistoryRow(input, options);
        const colored = projectHistoryRow(input, { ...options, color: true });
        expect(colored.replace(/\x1b\[[0-9;]*m/g, "")).toBe(plain);
        const records = projectHistoryRecord(input, options);
        const coloredRecords = projectHistoryRecord(input, { ...options, color: true });
        expect(coloredRecords.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""))).toEqual(records);
      }
      const full = projectHistoryRow(input, { ascii: true, color: true, theme });
      expect(full).toContain(`${foreground(palette.empty)}(empty)\x1b[0m`);
      if (subject === "(no description set)") {
        expect(full).toContain(`${foreground(palette.undescribed)}(no description set)\x1b[0m`);
      } else {
        expect(full).not.toContain(`${foreground(palette.undescribed)}(no description set)`);
      }
    }
  });
  test("preserves whole-line clipping for false and unknown facts", () => {
    for (const isEmpty of [false, undefined]) {
      const ordinary = planHistoryPage([
        { ...commit, parentRevisionIds: [], decorations: [], subject: "Title", isEmpty },
      ]).rows[0]!;
      expect(projectHistoryRecord(ordinary, { ascii: true, color: false, width: 7 })[4]).toBe(
        "      …",
      );
      const merge = planHistoryPage([{ ...commit, decorations: [], subject: "Title", isEmpty }])
        .rows[0]!;
      expect(projectHistoryRecord(merge, { ascii: true, color: false, width: 9 })[4]).toBe(
        "| |     …",
      );
      const combining = planHistoryPage([
        { ...commit, parentRevisionIds: [], decorations: [], subject: "\u0301Title", isEmpty },
      ]).rows[0]!;
      expect(projectHistoryRecord(combining, { ascii: true, color: false, width: 9 })[4]).toBe(
        "       \u0301T…",
      );
    }
  });

  test("keeps the complete marker at seven and eight title cells in both formats", () => {
    for (const parentRevisionIds of [[], ["b", "c"]]) {
      const emptyRow = planHistoryPage([
        { ...commit, parentRevisionIds, isEmpty: true, subject: "123456789" },
      ]).rows[0]!;
      const compactPrefix = `${renderHistoryGraph(emptyRow, true)}  ${commit.displayId}  `;
      const continuation = renderHistoryContinuation(emptyRow, true);
      const mediumPrefix = `${continuation ? `${continuation}  ` : "   "}    `;
      for (const [budget, expected] of [
        [6, "(empt…"],
        [7, "(empty)"],
        [8, "(empty)"],
        [9, "(empty) …"],
      ] as const) {
        const compact = projectHistoryRow(emptyRow, {
          ascii: true,
          color: false,
          width: measureTextWidth(compactPrefix) + budget,
        });
        expect(compact.slice(compactPrefix.length)).toBe(expected);
        const medium = projectHistoryRecord(emptyRow, {
          ascii: true,
          color: false,
          width: measureTextWidth(mediumPrefix) + budget,
        });
        expect(medium[4]).toBe(mediumPrefix + expected);
        expect(
          medium.every((line) => measureTextWidth(line) <= measureTextWidth(mediumPrefix) + budget),
        ).toBe(true);
      }
    }
  });

  test("labels only known true across widths, palettes, refs, and described or undescribed revisions", () => {
    for (const subject of [
      "(no description set)",
      "日本語 👨‍👩‍👧‍👦 " + "long ".repeat(25) + "\x1b[2J\tend",
    ]) {
      for (const isEmpty of [true, false, undefined]) {
        for (const decorations of [commit.decorations, []]) {
          const input = { ...commit, subject, isEmpty, decorations };
          const inputRow = planHistoryPage([input]).rows[0]!;
          for (const ascii of [true, false]) {
            for (const width of [40, 80, 120, undefined]) {
              const options = { ascii, width, color: false };
              const compact = projectHistoryRow(inputRow, options);
              const medium = projectHistoryRecord(inputRow, options);
              expect(compact.includes("(empty)")).toBe(isEmpty === true);
              expect(medium[4]!.includes("(empty)")).toBe(isEmpty === true);
              if (width !== undefined) {
                expect(measureTextWidth(compact)).toBeLessThanOrEqual(width);
                expect(medium.every((line) => measureTextWidth(line) <= width)).toBe(true);
              }
              expect(compact).not.toContain("\x1b");
              expect(compact).not.toContain("\t");
              const colored = projectHistoryRecord(inputRow, { ...options, color: true });
              expect(colored[4]!.includes("(empty)")).toBe(isEmpty === true);
            }
          }
          expect(input.subject).toBe(subject);
          expect(input.body).toBe(commit.body);
          expect(getHistoryCommitIdBounds(inputRow)).toEqual(getHistoryCommitIdBounds(row));
        }
      }
    }
  });
});
