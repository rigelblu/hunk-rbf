import { describe, expect, test } from "bun:test";
import {
  buildHistoryHelpSections,
  buildHistoryCommands,
  isHistoryCommandEnabled,
} from "./commands";
import type { LogSnapshot } from "./controller";

const snapshot = (query: LogSnapshot["query"]): LogSnapshot => ({
  marks: [],
  markStatus: "ready",
  rows: [],
  selected: 0,
  selectionAnchor: null,
  visualSelectionActive: false,
  top: 0,
  entryScroll: 0,
  search: "",
  historyDone: true,
  loading: false,
  notice: "",
  presentation: { graph: false, unicode: true, author: true, date: true, decorations: true },
  ...(query ? { query } : {}),
});

describe("hunk.history.editRevset", () => {
  test("is enabled only for a provider whose query can be edited", () => {
    const query = { editable: true, mode: "launch", generation: 0 } as const;
    expect(isHistoryCommandEnabled("hunk.history.editRevset", snapshot(query))).toBeTrue();
    expect(
      isHistoryCommandEnabled("hunk.history.editRevset", snapshot({ ...query, editable: false })),
    ).toBeFalse();
    expect(isHistoryCommandEnabled("hunk.history.editRevset", snapshot(undefined))).toBeFalse();
  });

  test("binds L by default and appears in the help's Application section", () => {
    const commands = buildHistoryCommands({
      getSnapshot: () => snapshot({ editable: true, mode: "launch", generation: 0 }),
      handlers: new Proxy({}, { get: () => () => undefined }) as never,
    });
    const command = commands.find((entry) => entry.id === "hunk.history.editRevset")!;
    expect(command.keyLabels).toEqual(["L"]);
    expect(command.title).toBe("Edit revset…");
    const application = buildHistoryHelpSections(commands).find(
      (section) => section.title === "Application",
    )!;
    expect(application.rows).toContainEqual({ keys: "L", description: "edit revset…" });
    const without = buildHistoryHelpSections(
      commands.filter((entry) => entry.id !== "hunk.history.editRevset"),
    );
    expect(JSON.stringify(without)).not.toContain("edit revset");
  });
});
