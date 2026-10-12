import { describe, expect, test } from "bun:test";
import type { LogQueryState } from "./controller";
import { measureTextWidth } from "../lib/text";
import { historyQueryViewRows, planHistoryQueryView } from "./historyQueryView";

const launch: LogQueryState = {
  editable: true,
  mode: "launch",
  expression: "(((trunk()..visible_heads()) | trunk()) ~ root())",
  limit: 100,
  generation: 0,
};
const custom: LogQueryState = { ...launch, mode: "custom", expression: "@", generation: 1 };

describe("planHistoryQueryView", () => {
  test("adds nothing for a provider that cannot edit its query", () => {
    for (const height of [8, 12, 15, 32]) {
      expect(planHistoryQueryView({ ...launch, editable: false }, { width: 80, height })).toEqual({
        top: [],
        bottom: [],
        replacesScopeLine: false,
      });
      expect(planHistoryQueryView(undefined, { width: 80, height })).toEqual({
        top: [],
        bottom: [],
        replacesScopeLine: false,
      });
    }
  });

  test("puts the revset, mode, limit and a blank row above the list from 15 rows", () => {
    const view = planHistoryQueryView(launch, { width: 80, height: 32 });
    expect(view.top).toEqual([
      { kind: "revset", text: "Revset: (((trunk()..visible_heads()) | trunk()) ~ root())" },
      { kind: "mode", text: "Launch policy · Limit: 100" },
      { kind: "blank" },
    ]);
    expect(view.bottom).toEqual([]);
    expect(view.replacesScopeLine).toBeFalse();
    // 28 list rows today become 25: the three added rows come out of the list.
    expect(historyQueryViewRows(view)).toBe(3);
  });

  test("fills the first row to the box width, indents the second one cell, and clips it with an ellipsis", () => {
    const wrapped = planHistoryQueryView(launch, { width: 40, height: 24 });
    const rows = wrapped.top.filter((row) => row.kind === "revset") as Array<{ text: string }>;
    expect(rows.map((row) => row.text)).toEqual([
      "Revset: (((trunk()..visible_heads()) |",
      "  trunk()) ~ root())",
    ]);
    const long = planHistoryQueryView(
      { ...custom, expression: "mine() & description(substring:'x') ".repeat(5).trim() },
      { width: 40, height: 24 },
    );
    const longRows = long.top.filter((row) => row.kind === "revset") as Array<{ text: string }>;
    expect(longRows).toHaveLength(2);
    expect(longRows[0]!.text).toHaveLength(38);
    expect(longRows[1]!.text).toHaveLength(38);
    expect(longRows[1]!.text.startsWith(" ")).toBeTrue();
    expect(longRows[1]!.text.endsWith("…")).toBeTrue();
  });

  test("a revset exactly one row wide stays on one row, and one cell more keeps its indent", () => {
    const exact = "x".repeat(38 - "Revset: ".length);
    const one = planHistoryQueryView({ ...custom, expression: exact }, { width: 40, height: 24 });
    expect(one.top.filter((row) => row.kind === "revset")).toHaveLength(1);
    const over = planHistoryQueryView(
      { ...custom, expression: `${exact}y` },
      { width: 40, height: 24 },
    );
    const rows = over.top.filter((row) => row.kind === "revset") as Array<{ text: string }>;
    expect(rows.map((row) => row.text)).toEqual([`Revset: ${exact}`, " y"]);
  });

  test("no added row is wider than the box at any width", () => {
    for (let width = 4; width <= 130; width += 1) {
      for (const query of [launch, custom, { ...launch, expression: undefined }]) {
        const view = planHistoryQueryView(query, { width, height: 24 });
        for (const row of view.top)
          if (row.kind !== "blank")
            expect(measureTextWidth(row.text)).toBeLessThanOrEqual(width - 2);
        for (const line of view.bottom)
          expect(measureTextWidth(line)).toBeLessThanOrEqual(width - 2);
        const short = planHistoryQueryView(query, { width, height: 12 });
        for (const row of short.top)
          if (row.kind !== "blank")
            expect(measureTextWidth(row.text)).toBeLessThanOrEqual(width - 2);
      }
    }
  });

  test("the mode line is clipped with an ellipsis on a narrow terminal, never wrapped", () => {
    const view = planHistoryQueryView(launch, { width: 24, height: 24 });
    const mode = view.top.find((row) => row.kind === "mode") as { text: string };
    expect(mode.text).toHaveLength(22);
    expect(mode.text.endsWith("…")).toBeTrue();
  });

  test("the 14-versus-15-row switch", () => {
    expect(planHistoryQueryView(launch, { width: 80, height: 14 }).top).toEqual([]);
    expect(planHistoryQueryView(launch, { width: 80, height: 15 }).top).toHaveLength(3);
    expect(planHistoryQueryView(custom, { width: 80, height: 14 }).top).toEqual([
      { kind: "custom", text: "Custom revset: @" },
    ]);
    expect(planHistoryQueryView(custom, { width: 80, height: 15 }).top).toHaveLength(3);
    expect(planHistoryQueryView(custom, { width: 80, height: 14 }).bottom).toEqual([]);
    expect(planHistoryQueryView(custom, { width: 80, height: 15 }).bottom).toHaveLength(1);
  });

  test("a custom query adds the restriction line and drops the scope line", () => {
    const view = planHistoryQueryView(custom, { width: 80, height: 32 });
    expect(view.top[1]).toEqual({ kind: "mode", text: "Custom revset · Limit: 100" });
    expect(view.bottom).toEqual(["Custom revset: graph links and range review unavailable."]);
    expect(view.replacesScopeLine).toBeTrue();
    expect(planHistoryQueryView(custom, { width: 40, height: 24 }).bottom).toEqual([
      "Custom revset: graph links and range",
      "review unavailable.",
    ]);
  });

  test("reads Limit: none when there is no row limit", () => {
    const view = planHistoryQueryView({ ...custom, limit: undefined }, { width: 80, height: 32 });
    expect(view.top[1]).toEqual({ kind: "mode", text: "Custom revset · Limit: none" });
  });

  test("under 15 rows launch policy adds nothing and a custom query adds one row", () => {
    expect(planHistoryQueryView(launch, { width: 40, height: 12 })).toEqual({
      top: [],
      bottom: [],
      replacesScopeLine: false,
    });
    const view = planHistoryQueryView(custom, { width: 40, height: 12 });
    expect(view).toEqual({
      top: [{ kind: "custom", text: "Custom revset: @" }],
      bottom: [],
      replacesScopeLine: true,
    });
    const clipped = planHistoryQueryView(
      { ...custom, expression: "x".repeat(120) },
      { width: 40, height: 14 },
    );
    expect(clipped.top).toHaveLength(1);
    expect((clipped.top[0] as { text: string }).text).toHaveLength(38);
    expect((clipped.top[0] as { text: string }).text.endsWith("…")).toBeTrue();
  });

  test("a source with no expression shows the unavailable sentence in the revset slot", () => {
    const view = planHistoryQueryView(
      { editable: true, mode: "launch", limit: 100, generation: 0 },
      { width: 80, height: 32 },
    );
    expect(view.top).toEqual([
      { kind: "revset", text: "Active revset unavailable. Enter a new revset or Reset." },
      { kind: "mode", text: "Launch policy · Limit: 100" },
      { kind: "blank" },
    ]);
    expect(historyQueryViewRows(view)).toBe(3);
    // Under 15 rows nothing is added in launch mode, as today.
    expect(
      planHistoryQueryView(
        { editable: true, mode: "launch", limit: 100, generation: 0 },
        { width: 80, height: 14 },
      ).top,
    ).toEqual([]);
  });
});
