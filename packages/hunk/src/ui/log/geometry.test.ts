import { describe, expect, test } from "bun:test";
import { planHistoryPage } from "../../core/history/lanePlanner";
import type { HistoryCommit } from "../../core/history/types";
import { planLogViewportGeometry } from "./geometry";

/** Build one deterministic commit for day-group viewport tests. */
function commit(id: string, authoredAt: string): HistoryCommit {
  return {
    revisionId: id.repeat(40),
    displayId: id.repeat(8),
    parentRevisionIds: [],
    subject: id,
    authorName: "Test Author",
    authorEmail: "tester@example.com",
    authoredAt,
    decorations: [],
  };
}

const rows = planHistoryPage([
  commit("a", new Date(2026, 8, 6, 12).toISOString()),
  commit("b", new Date(2026, 8, 6, 11).toISOString()),
  commit("c", new Date(2026, 8, 5, 12).toISOString()),
  commit("d", new Date(2026, 8, 5, 11).toISOString()),
]).rows;

describe("log viewport geometry", () => {
  test("accounts for one heading per visible day and never exceeds the body", () => {
    const geometry = planLogViewportGeometry({
      rows,
      selected: 0,
      requestedTop: 0,
      bodyHeight: 11,
      groupByDay: true,
    });
    expect(geometry.entries.map((entry) => [entry.index, entry.showDayHeader])).toEqual([
      [0, true],
      [1, false],
      [2, true],
    ]);
    expect(geometry.usedHeight).toBe(10);
  });

  test("repeats the current day heading while backfilling near EOF", () => {
    const geometry = planLogViewportGeometry({
      rows,
      selected: 3,
      requestedTop: 3,
      bodyHeight: 8,
      groupByDay: true,
    });
    expect(geometry.top).toBe(2);
    expect(geometry.entries[0]).toMatchObject({ index: 2, showDayHeader: true });
  });

  test("omits day headings in graph view", () => {
    const geometry = planLogViewportGeometry({
      rows,
      selected: 0,
      requestedTop: 0,
      bodyHeight: 9,
      groupByDay: false,
    });
    expect(geometry.entries.map((entry) => [entry.index, entry.showDayHeader])).toEqual([
      [0, false],
      [1, false],
      [2, false],
      [3, false],
    ]);
    expect(geometry.usedHeight).toBe(8);
  });

  test("bounds planning work when jumping deep into a large history", () => {
    let indexedReads = 0;
    const manyRows = new Proxy(
      Array.from({ length: 10_000 }, (_, index) => rows[index % rows.length]!),
      {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/.test(property)) indexedReads += 1;
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const geometry = planLogViewportGeometry({
      rows: manyRows,
      selected: 9_999,
      requestedTop: 0,
      bodyHeight: 17,
      groupByDay: false,
    });
    expect(geometry.top).toBe(9_992);
    expect(geometry.entries).toHaveLength(8);
    expect(indexedReads).toBeLessThan(100);
  });

  test("advances the commit-index top until the selection fits", () => {
    const geometry = planLogViewportGeometry({
      rows,
      selected: 2,
      requestedTop: 0,
      bodyHeight: 8,
      groupByDay: true,
    });
    expect(geometry.top).toBe(1);
    expect(geometry.entries.at(-1)?.index).toBe(2);
    expect(geometry.usedHeight).toBeLessThanOrEqual(8);
  });

  test("preserves a physical selection row across rewritten day groups", () => {
    const rewritten = planHistoryPage(
      Array.from({ length: 50 }, (_, index) =>
        commit(String(index), new Date(2026, 8, 20 - index, 12).toISOString()),
      ),
    ).rows;
    const geometry = planLogViewportGeometry({
      rows: rewritten,
      selected: 8,
      requestedTop: 2,
      bodyHeight: 40,
      groupByDay: true,
      requestedSelectedRowOffset: 22,
    });
    expect(geometry.top).toBe(3);
    expect(geometry.selectedRowOffset).toBe(22);
    expect(geometry.backfilled).toBeFalse();
  });

  test("keeps the requested physical row ahead of EOF backfill", () => {
    const geometry = planLogViewportGeometry({
      rows,
      selected: 3,
      requestedTop: 3,
      bodyHeight: 8,
      groupByDay: true,
      requestedSelectedRowOffset: 2,
    });
    expect(geometry.top).toBe(3);
    expect(geometry.selectedRowOffset).toBe(2);
    expect(geometry.backfilled).toBeFalse();
  });

  test("bounds physical-position planning by the viewport in a deep history", () => {
    let indexedReads = 0;
    const manyRows = new Proxy(
      Array.from({ length: 10_000 }, (_, index) => rows[index % rows.length]!),
      {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/.test(property)) indexedReads += 1;
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const geometry = planLogViewportGeometry({
      rows: manyRows,
      selected: 9_990,
      requestedTop: 0,
      bodyHeight: 17,
      groupByDay: true,
      requestedSelectedRowOffset: 7,
    });
    expect(geometry.selectedRowOffset).toBe(8);
    expect(indexedReads).toBeLessThan(150);
  });
});

test("HK-93 cutoff topology measures stub heights without turning them into commits or day headings", () => {
  const first = {
    ...commit("x", "2026-10-10T00:00:00Z"),
    parentRevisionIds: ["hidden-a", "hidden-b"],
    graphCutoffParentRevisionIds: ["hidden-a", "hidden-b"],
  };
  const planned = planHistoryPage([first, commit("y", first.authoredAt)]).rows;
  for (const groupByDay of [false, true]) {
    const geometry = planLogViewportGeometry({
      rows: planned,
      selected: 0,
      requestedTop: 0,
      bodyHeight: groupByDay ? 10 : 8,
      groupByDay,
    });
    expect(geometry.entries.map((entry) => entry.index)).toEqual([0, 1]);
    expect(geometry.entries.map((entry) => entry.showDayHeader)).toEqual([groupByDay, false]);
    expect(geometry.usedHeight).toBe(groupByDay ? 8 : 6);
  }
});

test("HK-93 short grouped view retains a cutoff commit by omitting its day heading", () => {
  const row = planHistoryPage([
    {
      ...commit("x", "2026-10-10T00:00:00Z"),
      parentRevisionIds: ["hidden"],
      graphCutoffParentRevisionIds: ["hidden"],
    },
  ]).rows;
  const view = planLogViewportGeometry({
    rows: row,
    selected: 0,
    requestedTop: 0,
    bodyHeight: 4,
    groupByDay: true,
  });
  expect(view.entries).toHaveLength(1);
  expect(view.entries[0]?.showDayHeader).toBe(false);
  expect(view.usedHeight).toBe(3);
});
