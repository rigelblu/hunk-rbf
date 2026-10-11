import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import type { LogSnapshot } from "./controller";
import { resolveCommandKeys } from "../lib/keymap";
import {
  buildHistoryCommands,
  buildHistoryHelpSections,
  historyCommand,
  historyCommandKeyDefaults,
  isHistoryCommandEnabled,
  type HistoryCommandHandlers,
  type HistoryCommandId,
} from "./commands";

const key = (name: string, sequence = name, ctrl = false, shift = false) =>
  ({ name, sequence, ctrl, shift }) as KeyEvent;

const snapshot = (parents: string[] = []): LogSnapshot => ({
  rows: [
    {
      commit: {
        revisionId: "commit",
        displayId: "commit",
        parentRevisionIds: parents,
        subject: "subject",
        authorName: "Ada",
        authoredAt: "2026-01-01T00:00:00Z",
        decorations: [],
      },
      lane: 0,
      lanesBefore: [],
      lanesAfter: [],
      cells: [],
      parentLanes: [],
      convergences: [],
    },
  ],
  marks: [],
  markStatus: "ready",
  selected: 0,
  selectionAnchor: null,
  visualSelectionActive: false,
  top: 0,
  entryScroll: 0,
  search: "",
  historyDone: true,
  loading: false,
  notice: "",
  presentation: {
    graph: true,
    unicode: true,
    author: true,
    date: true,
    decorations: true,
  },
});

const noopHandlers = Object.fromEntries(
  historyCommandKeyDefaults().map(({ id }) => [id, () => {}]),
) as unknown as HistoryCommandHandlers;

/** Return the first canonical command matched by one synthetic terminal key. */
function matchCommand(
  event: KeyEvent,
  userBindings?: Readonly<Record<string, string | readonly string[] | false>>,
  value = snapshot(),
) {
  const { keys } = resolveCommandKeys({
    defaults: historyCommandKeyDefaults(),
    userBindings,
  });
  return buildHistoryCommands({
    getSnapshot: () => value,
    handlers: noopHandlers,
    resolvedKeys: keys,
  }).find((command) => command.match(event))?.id;
}

describe("history command authority", () => {
  test("drives keyboard dispatch, canonical menu identity, and help from resolved bindings", () => {
    expect(matchCommand(key("down", ""))).toBe("hunk.history.nextCommit");
    expect(matchCommand(key("down", "", false, true))).toBe("hunk.history.extendNext");
    expect(matchCommand(key("letter", "J"))).toBe("hunk.history.extendNext");
    expect(matchCommand(key("up", "", false, true))).toBe("hunk.history.extendPrevious");
    expect(matchCommand(key("letter", "K"))).toBe("hunk.history.extendPrevious");
    expect(matchCommand(key("letter", "j"))).toBe("hunk.history.nextCommit");
    expect(matchCommand(key("letter", "v"))).toBe("hunk.history.startVisualSelection");
    expect(
      matchCommand(key("escape", ""), undefined, {
        ...snapshot(),
        visualSelectionActive: true,
      }),
    ).toBe("hunk.history.clearSelection");
    expect(matchCommand(key("space", " "))).toBe("hunk.history.pageDown");
    expect(matchCommand(key("letter", "f"))).toBe("hunk.history.pageDown");
    expect(matchCommand(key("letter", "b"))).toBe("hunk.history.pageUp");
    expect(matchCommand(key("space", " ", false, true))).toBe("hunk.history.pageUp");
    expect(matchCommand(key("letter", "d"))).toBe("hunk.history.halfPageDown");
    expect(matchCommand(key("d", "", true))).toBe("hunk.history.halfPageDown");
    expect(matchCommand(key("letter", "u"))).toBe("hunk.history.halfPageUp");
    expect(matchCommand(key("u", "", true))).toBe("hunk.history.halfPageUp");
    expect(matchCommand(key("c", "\x03", true))).toBe("hunk.app.quit");
    expect(matchCommand(key("t"))).toBe("hunk.view.openThemeSelector");
    expect(historyCommand("hunk.history.openFirstParent").title).toBe("Compare with first parent");

    const { keys } = resolveCommandKeys({
      defaults: historyCommandKeyDefaults(),
      userBindings: { "hunk.history.nextCommit": "ctrl+n" },
    });
    const commands = buildHistoryCommands({
      getSnapshot: snapshot,
      handlers: noopHandlers,
      resolvedKeys: keys,
    });
    const helpRows = buildHistoryHelpSections(commands).flatMap((section) => section.rows);
    expect(helpRows).toContainEqual({ keys: "Ctrl+N", description: "next commit" });
    expect(helpRows).toContainEqual({ keys: "v", description: "start visual selection" });
    expect(helpRows).toContainEqual({ keys: "Esc", description: "clear selection" });
    expect(helpRows).toContainEqual({
      keys: "PageUp / b / Shift+Space",
      description: "page up",
    });
    expect(helpRows).toContainEqual({
      keys: "Shift+Up / K",
      description: "extend selection up",
    });
    expect(helpRows).toContainEqual({ keys: "t", description: "choose theme" });
  });

  test("remaps and unbinds history independently through the shared keymap", () => {
    expect(
      matchCommand(key("n", "", true), {
        "hunk.history.nextCommit": "ctrl+n",
        "hunk.history.previousCommit": false,
      }),
    ).toBe("hunk.history.nextCommit");
    expect(
      matchCommand(key("down", ""), {
        "hunk.history.nextCommit": "ctrl+n",
      }),
    ).toBeUndefined();
    expect(
      matchCommand(key("up", ""), {
        "hunk.history.previousCommit": false,
      }),
    ).toBeUndefined();
    expect(
      matchCommand(key("c", "\x03", true), {
        "hunk.history.nextCommit": "ctrl+c",
      }),
    ).toBe("hunk.history.nextCommit");
    expect(
      matchCommand(key("c", "\x03", true), {
        "hunk.app.quit": false,
      }),
    ).toBeUndefined();
    expect(
      matchCommand(key("x"), {
        "hunk.history.startVisualSelection": "x",
      }),
    ).toBe("hunk.history.startVisualSelection");
    expect(
      matchCommand(key("letter", "v"), {
        "hunk.history.startVisualSelection": false,
      }),
    ).toBeUndefined();
  });

  test("derives parent and search enabled state from current snapshot", () => {
    const enabled = (id: HistoryCommandId, value = snapshot()) =>
      isHistoryCommandEnabled(id, value);
    expect(enabled("hunk.history.openFirstParent")).toBe(false);
    expect(enabled("hunk.history.openFirstParent", snapshot(["p1", "p2"]))).toBe(true);
    expect(enabled("hunk.history.openParent", snapshot(["p1", "p2"]))).toBe(true);
    const range = { ...snapshot(["p1", "p2"]), selectionAnchor: 1 };
    expect(enabled("hunk.history.openFirstParent", range)).toBe(false);
    expect(enabled("hunk.history.openParent", range)).toBe(false);
    expect(enabled("hunk.history.nextMatch")).toBe(false);
    expect(enabled("hunk.history.clearSelection")).toBe(false);
    expect(
      enabled("hunk.history.clearSelection", { ...snapshot(), visualSelectionActive: true }),
    ).toBe(true);
  });
});

test("marks preserve paging bindings, remaps, context labels, and clear availability", () => {
  expect(matchCommand(key("x"))).toBe("hunk.history.toggleMark");
  expect(matchCommand(key("space", " "))).toBe("hunk.history.pageDown");
  expect(matchCommand(key("space", " ", false, true))).toBe("hunk.history.pageUp");
  expect(matchCommand(key("m"), { "hunk.history.toggleMark": "m" })).toBe(
    "hunk.history.toggleMark",
  );
  expect(matchCommand(key("x"), { "hunk.history.toggleMark": "m" })).toBeUndefined();
  const marked: LogSnapshot = {
    ...snapshot(),
    marks: [
      {
        kind: "resolved",
        revisionId: "commit",
        mark: { revisionId: "commit", subject: "subject", seenUnder: "test" },
      },
    ],
  };
  const build = (value: LogSnapshot) =>
    buildHistoryCommands({ getSnapshot: () => value, handlers: noopHandlers });
  expect(build(marked).find((c) => c.id === "hunk.history.openSelection")?.title).toBe(
    "Open highlighted revision",
  );
  expect(
    build({ ...marked, selectionAnchor: 0 }).find((c) => c.id === "hunk.history.openSelection")
      ?.title,
  ).toBe("Open review range");
  expect(isHistoryCommandEnabled("hunk.history.clearSelection", marked)).toBe(true);
  expect(isHistoryCommandEnabled("hunk.history.clearSelection", snapshot())).toBe(false);
  expect(
    isHistoryCommandEnabled("hunk.history.toggleMark", { ...marked, markStatus: "checking" }),
  ).toBe(false);
  expect(buildHistoryHelpSections(build(marked)).flatMap((s) => s.rows)).toContainEqual({
    keys: "x",
    description: "mark/unmark revision",
  });
});
