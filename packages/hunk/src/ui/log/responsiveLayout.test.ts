import { describe, expect, test } from "bun:test";
import { planHistoryPage } from "../../core/history/lanePlanner";
import type { HistoryCommit } from "../../core/history/types";
import { measureTextWidth } from "../lib/text";
import type { LogPresentation } from "./controller";
import {
  formatHistoryDay,
  formatHistoryRelativeTime,
  historyDayKey,
  resolveHistoryAuthorLabel,
} from "./formatting";
import { projectResponsiveLogRow, resolveLogResponsiveLayout } from "./responsiveLayout";

const commitDate = new Date(2026, 8, 5, 12).toISOString();
const commit: HistoryCommit = {
  revisionId: "a".repeat(40),
  displayId: "日本語a1",
  parentRevisionIds: ["b".repeat(40), "c".repeat(40)],
  subject: "Responsive history title",
  body: "A useful description of the selected change.\n\nMore detail.",
  authorName: "Ada Lovelace",
  authorEmail: "2153+adalovelace@users.noreply.github.com",
  authoredAt: commitDate,
  decorations: [
    { kind: "head", label: "HEAD", attachedLocalBranch: "main" },
    { kind: "local-branch", label: "main" },
    { kind: "tag", label: "v1.0.0" },
  ],
};
const row = planHistoryPage([commit]).rows[0]!;
const presentation: LogPresentation = {
  graph: true,
  unicode: true,
  author: true,
  date: true,
  decorations: true,
};
const now = new Date(2026, 8, 6, 12, 5).getTime();

describe("responsive log layout", () => {
  test("keeps a three-line entry at every responsive density", () => {
    expect(resolveLogResponsiveLayout(120, 30)).toMatchObject({ density: "wide", rowHeight: 3 });
    expect(resolveLogResponsiveLayout(80, 24)).toMatchObject({ density: "medium", rowHeight: 3 });
    expect(resolveLogResponsiveLayout(42, 18)).toMatchObject({ density: "narrow", rowHeight: 3 });
  });

  test("uses offline account handles and relative dates", () => {
    expect(resolveHistoryAuthorLabel(commit)).toBe("adalovelace");
    expect(
      resolveHistoryAuthorLabel({
        ...commit,
        authorEmail: "grace@example.com",
      }),
    ).toBe("grace");
    expect(resolveHistoryAuthorLabel({ ...commit, authorEmail: undefined })).toBe("Ada Lovelace");
    expect(formatHistoryRelativeTime(new Date(2026, 8, 6, 12).toISOString(), now)).toBe(
      "5 minutes ago",
    );
    expect(formatHistoryRelativeTime(new Date(2026, 8, 4, 12, 5).toISOString(), now)).toBe(
      "2 days ago",
    );
  });

  test("formats local-calendar day groups", () => {
    expect(formatHistoryDay(commit.authoredAt)).toMatch(/^Commits on Sep 5, 2026$/);
    expect(historyDayKey(new Date(2026, 8, 5, 12).toISOString())).toBe(
      historyDayKey(new Date(2026, 8, 5, 20).toISOString()),
    );
  });

  test("projects title, username, relative time, and right-aligned actions", () => {
    const wide = projectResponsiveLogRow({
      row,
      presentation,
      layout: resolveLogResponsiveLayout(120, 30),
      width: 120,
      now,
    });
    expect(wide.title).toBe("Responsive history title");
    expect(wide.author).toBe("adalovelace");
    expect(wide.relativeTime).toBe("1 day ago");
    expect(wide.metadata).toBe("adalovelace · 1 day ago");
    expect(wide.secondary).toContain("HEAD -> main");
    expect(wide.secondary).toContain("tag: v1.0.0");
    expect(wide.convergence).toBe(wide.continuation);
    expect(measureTextWidth(wide.displayId)).toBe(8);
    expect(wide.copyIcon).toBe("⧉");
    expect(wide.graphWidth + wide.leftWidth + wide.rightWidth + 2).toBeLessThanOrEqual(116);

    const longDecoration = projectResponsiveLogRow({
      row: {
        ...row,
        commit: {
          ...row.commit,
          decorations: [{ kind: "tag", label: "release-".repeat(40) }],
        },
      },
      presentation,
      layout: resolveLogResponsiveLayout(120, 30),
      width: 120,
      now,
    });
    expect(longDecoration.secondary).toEndWith("…)");
    expect(
      longDecoration.graphWidth +
        longDecoration.leftWidth +
        longDecoration.rightWidth +
        longDecoration.columnGap,
    ).toBeLessThanOrEqual(116);
  });

  test("uses a quiet timeline rail instead of topology in grouped view", () => {
    const grouped = projectResponsiveLogRow({
      row,
      presentation: { ...presentation, graph: false },
      layout: resolveLogResponsiveLayout(120, 30),
      width: 120,
      now,
    });
    expect(grouped.graph).toBe("│");
    expect(grouped.continuation).toBe("│");
    expect(grouped.convergence).toBe("│");
    expect(grouped.graphWidth).toBe(3);
  });

  test("shows compact refs below the wide breakpoint when decorations are enabled", () => {
    const medium = projectResponsiveLogRow({
      row,
      presentation,
      layout: resolveLogResponsiveLayout(80, 24),
      width: 80,
      now,
    });
    expect(medium.secondary).toBe("(main)");
    const unsafe = projectResponsiveLogRow({
      row: {
        ...row,
        commit: {
          ...row.commit,
          decorations: [
            {
              kind: "head",
              label: "HEAD\u001b[31m",
              attachedLocalBranch: "main\nforged",
            },
          ],
        },
      },
      presentation,
      layout: resolveLogResponsiveLayout(80, 24),
      width: 80,
      now,
    });
    expect(unsafe.secondary).not.toMatch(/[\u001b\n]/);
    expect(
      projectResponsiveLogRow({
        row,
        presentation: { ...presentation, decorations: false },
        layout: resolveLogResponsiveLayout(80, 24),
        width: 80,
        now,
      }).secondary,
    ).toBe("");
  });

  test("renders lane convergence in graph view", () => {
    const converging = projectResponsiveLogRow({
      row: {
        ...row,
        lanesBefore: ["main", "branch"],
        lanesAfter: ["main"],
        convergences: [{ from: 1, to: 0 }],
      },
      presentation,
      layout: resolveLogResponsiveLayout(80, 24),
      width: 80,
      now,
    });
    expect(converging.convergence).toContain("╯");
  });

  test("keeps the grouped rail and every column inside narrow terminal bounds", () => {
    const narrow = projectResponsiveLogRow({
      row,
      presentation: { ...presentation, graph: false },
      layout: resolveLogResponsiveLayout(20, 18),
      width: 20,
      now,
    });
    expect(narrow.graph).toBe("│");
    expect(narrow.graphWidth).toBe(3);
    expect(
      narrow.graphWidth + narrow.leftWidth + narrow.rightWidth + narrow.columnGap,
    ).toBeLessThanOrEqual(16);
    expect(measureTextWidth(narrow.displayId)).toBeLessThan(narrow.rightWidth);
  });

  test("bounds many graph lanes while reserving title and commit actions", () => {
    const manyLanes = Array.from({ length: 24 }, (_, index) => `lane-${index}`);
    const crowdedRow = {
      ...row,
      cells: manyLanes.map((_, index) => ({
        kind: index === 0 ? ("node" as const) : ("vertical" as const),
      })),
      lanesBefore: manyLanes,
      lanesAfter: manyLanes,
    };
    const projected = projectResponsiveLogRow({
      row: crowdedRow,
      presentation,
      layout: resolveLogResponsiveLayout(42, 18),
      width: 42,
      now,
    });
    expect(projected.graph).toEndWith("…");
    expect(projected.leftWidth).toBeGreaterThanOrEqual(12);
    expect(
      projected.graphWidth + projected.leftWidth + projected.rightWidth + projected.columnGap,
    ).toBeLessThanOrEqual(38);
    expect(projected.metadata).toContain("adalovelace");
    expect(projected.metadata).toStartWith("adalovelace");
  });
});

describe("known-empty responsive titles", () => {
  test("preserves the whole marker at actual six, seven, eight, and nine-cell consumer budgets", () => {
    const emptyRow = planHistoryPage([
      {
        ...commit,
        displayId: "x",
        parentRevisionIds: [],
        decorations: [],
        isEmpty: true,
        subject: "123456789",
      },
    ]).rows[0]!;
    const actual = new Map<number, string>();
    for (let width = 5; width <= 80; width += 1) {
      const projected = projectResponsiveLogRow({
        row: emptyRow,
        presentation: { ...presentation, unicode: false, decorations: false },
        layout: resolveLogResponsiveLayout(width, 24),
        width,
        now,
      });
      actual.set(projected.leftWidth, projected.title);
    }
    expect(actual.get(6)).toBe("(empt.");
    expect(actual.get(7)).toBe("(empty)");
    expect(actual.get(8)).toBe("(empty)");
    expect(actual.get(9)).toBe("(empty) .");
  });

  test("keeps labels independent of presentation controls and leaves semantic fields unchanged", () => {
    for (const subject of [
      "(no description set)",
      "日本語 👨‍👩‍👧‍👦 " + "long ".repeat(25) + "\x1b[2J\tend",
    ]) {
      for (const isEmpty of [true, false, undefined]) {
        const input = { ...commit, subject, isEmpty };
        const inputRow = planHistoryPage([input]).rows[0]!;
        for (const width of [40, 80, 120]) {
          for (const graph of [true, false]) {
            for (const unicode of [true, false]) {
              for (const decorations of [true, false]) {
                const projected = projectResponsiveLogRow({
                  row: inputRow,
                  presentation: { ...presentation, graph, unicode, decorations },
                  layout: resolveLogResponsiveLayout(width, 24),
                  width,
                  now,
                });
                expect(projected.title.startsWith("(empty) ")).toBe(isEmpty === true);
                expect(measureTextWidth(projected.title)).toBeLessThanOrEqual(projected.leftWidth);
                expect(projected.title).not.toContain("\x1b");
                expect(projected.title).not.toContain("\t");
                expect(projected.displayId).toBe(commit.displayId);
                expect(resolveLogResponsiveLayout(width, 24).rowHeight).toBe(3);
              }
            }
          }
        }
        expect(input.subject).toBe(subject);
        expect(input.body).toBe(commit.body);
        expect(input.revisionId).toBe(commit.revisionId);
      }
    }
  });
});

test("HK-93 cutoff topology reserves one nonselectable row per edge in every presentation", () => {
  const cut = planHistoryPage([
    {
      ...commit,
      graphParentRevisionIds: [],
      graphCutoffParentRevisionIds: commit.parentRevisionIds,
    },
  ]).rows[0]!;
  for (const width of [40, 80, 120]) {
    for (const graph of [false, true]) {
      const projected = projectResponsiveLogRow({
        row: cut,
        width,
        layout: resolveLogResponsiveLayout(width, 24),
        presentation: { ...presentation, graph },
        now,
      });
      expect(projected.cutoffs).toHaveLength(2);
      expect(
        projected.cutoffs.every((line) => line.includes("~") && measureTextWidth(line) <= width),
      ).toBe(true);
      if (!graph) expect(projected.cutoffs).toEqual(["~", "~"]);
    }
  }
  const crowded = { ...cut, cutoffLanes: [40, 41] };
  expect(
    projectResponsiveLogRow({
      row: crowded,
      width: 40,
      layout: resolveLogResponsiveLayout(40, 24),
      presentation,
      now,
    }).cutoffs,
  ).toEqual(["~", "~"]);
});
