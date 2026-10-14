import { describe, expect, test } from "bun:test";
import { planHistoryPage } from "../../core/history/lanePlanner";
import type { HistoryCommit } from "../../core/history/types";
import { measureTextWidth } from "../lib/text";
import type { LogPresentation } from "./presentation";
import { formatHistoryRelativeTime } from "./formatting";
import { projectResponsiveLogRow } from "./responsiveLayout";

const commit: HistoryCommit = {
  revisionId: "a".repeat(40),
  displayId: "abcdefgh",
  parentRevisionIds: [],
  subject: "Keep current workspace visible",
  authorName: "Tom",
  authorEmail: "tom@example.com",
  authoredAt: "2026-10-13T12:00:00Z",
  decorations: [
    { kind: "head", label: "@" },
    { kind: "ref", label: "@default", workspaceName: "default" },
    { kind: "ref", label: "@feature", workspaceName: "feature" },
    { kind: "local-branch", label: "main" },
  ],
};
const presentation: LogPresentation = {
  graph: true,
  unicode: true,
  author: true,
  date: true,
  decorations: true,
  workspaceNames: true,
};
/** Project a real planned entry at a fixed documentary clock. */
function project(
  width: number,
  input = commit,
  preferences = presentation,
  now = Date.parse("2026-10-14T12:00:00Z"),
) {
  return projectResponsiveLogRow({
    row: planHistoryPage([input]).rows[0]!,
    width,
    presentation: preferences,
    now,
  });
}

describe("compact history entries", () => {
  test("fits short workspace names and current bookmark together in two rows", () => {
    const result = project(70);
    expect(result.inlineRefLine).toBe("@default, @feature");
    expect(result.secondary).toBe("(@, main)");
    expect(result.refLine).toBe("");
    expect(result.textRowCount).toBe(2);
    expect(result.commitHeight).toBe(2);
  });
  test("spills the whole name group without reducing the subject budget", () => {
    const visible = project(45);
    const hidden = project(45, commit, { ...presentation, workspaceNames: false });
    expect(visible.inlineRefLine).toBe("");
    expect(visible.refLine).toBe("@default, @feature");
    expect(visible.textRowCount).toBe(3);
    expect(hidden.textRowCount).toBe(2);
    expect(hidden.secondary).toBe("(@, main)");
    expect(visible.title).toBe(hidden.title);
    expect(visible.leftWidth).toBe(hidden.leftWidth);
  });
  test("retains a real join when names fit inline or are hidden", () => {
    const row = {
      ...planHistoryPage([commit]).rows[0]!,
      convergences: [{ from: 1, to: 0 }],
      lanesBefore: ["one", "two"],
      lanesAfter: ["one"],
    };
    for (const workspaceNames of [true, false]) {
      const result = projectResponsiveLogRow({
        row,
        width: 80,
        presentation: { ...presentation, workspaceNames },
      });
      expect(result.textRowCount).toBe(3);
      expect(result.convergence).toContain("╯");
    }
    expect(project(80, { ...commit, decorations: [] }).textRowCount).toBe(2);
  });
  test("changes placement only at an actual measured fit boundary", () => {
    const long = {
      ...commit,
      decorations: [
        ...commit.decorations,
        { kind: "ref" as const, label: "@long-workspace-".repeat(3), workspaceName: "long" },
      ],
    };
    const before = project(95, long),
      after = project(96, long);
    expect(before.inlineRefLine).toBe(after.inlineRefLine);
    expect(before.textRowCount).toBe(after.textRowCount);
    const widths = Array.from({ length: 150 }, (_, i) => i + 30);
    const firstFit = widths.find((width) => project(width, long).inlineRefLine !== "");
    expect(firstFit).toBeDefined();
    expect(project(firstFit! - 1, long).textRowCount).toBe(3);
    expect(project(firstFit!, long).textRowCount).toBe(2);
  });
  test("marks long name and bookmark omissions while retaining current identity", () => {
    const long = {
      ...commit,
      decorations: [
        commit.decorations[0]!,
        { kind: "ref" as const, label: "@作業".repeat(40), workspaceName: "作業" },
        { kind: "local-branch" as const, label: "long-bookmark-".repeat(30) },
      ],
    };
    const result = project(45, long);
    expect(result.refLine).toEndWith("…");
    expect(result.secondary).toStartWith("(@");
    expect(result.secondary).toEndWith("…)");
    expect(measureTextWidth(result.refLine)).toBeLessThanOrEqual(result.textWidth);
  });
  test("relative-time ticks cannot add a row even across a unit boundary", () => {
    for (const width of [45, 70, 80, 95, 96, 120]) {
      const origin = Date.parse(commit.authoredAt);
      const samples = [59, 60, 3599, 3600, 86399, 86400, 2591999, 2592000].map((seconds) =>
        project(width, commit, presentation, origin + seconds * 1000),
      );
      expect(new Set(samples.map((value) => value.textRowCount)).size).toBe(1);
      expect(new Set(samples.map((value) => value.inlineRefLine)).size).toBe(1);
    }
    const earliest = new Date(-8640000000000000).toISOString();
    expect(
      measureTextWidth(formatHistoryRelativeTime(earliest, 8640000000000000)),
    ).toBeLessThanOrEqual(16);
  });
  test("reserves cutoff rows in addition to the two base rows", () => {
    const result = project(80, {
      ...commit,
      decorations: [],
      graphCutoffParentRevisionIds: ["hidden-a", "hidden-b"],
    });
    expect(result.cutoffs).toHaveLength(2);
    expect(result.commitHeight).toBe(4);
  });
});

test("attached Git summaries stay stable across95/96 and cannot add a spill row on growth", () => {
  const git = {
    ...commit,
    decorations: [
      { kind: "head" as const, label: "HEAD", attachedLocalBranch: "main" },
      { kind: "local-branch" as const, label: "main" },
      { kind: "ref" as const, label: "x".repeat(54) },
    ],
  };
  const before = project(95, git),
    after = project(96, git);
  expect(before.secondary).toBe("(main)");
  expect(after.secondary).toBe(before.secondary);
  expect(before.inlineRefLine).toBe(git.decorations[2]!.label);
  expect(after.inlineRefLine).toBe(before.inlineRefLine);
  expect(after.textRowCount).toBe(before.textRowCount);
});
