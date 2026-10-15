import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import type { LogSnapshot } from "./controller";
import { dispatchAppCommand } from "../lib/appCommands";
import type { HistoryOperationSnapshot } from "./historyOperationTypes";
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
  ({ name, sequence, ctrl, shift, preventDefault() {}, stopPropagation() {} }) as KeyEvent;

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
    expect(helpRows).toContainEqual({ keys: "v", description: "start review range" });
    expect(helpRows).toContainEqual({ keys: "Esc", description: "clear review range" });
    expect(helpRows).toContainEqual({
      keys: "PageUp / b / Shift+Space",
      description: "page up",
    });
    expect(helpRows).toContainEqual({
      keys: "Shift+Up / K",
      description: "extend review range up",
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
  expect(matchCommand(key("x"))).toBeUndefined();
  expect(matchCommand(key("space", " "))).toBe("hunk.history.pageDown");
  expect(matchCommand(key("space", " ", false, true))).toBe("hunk.history.pageUp");
  expect(matchCommand(key("x"))).toBeUndefined();
  expect(matchCommand(key("s", "S", false, true))).toBe("hunk.history.squash");
  expect(matchCommand(key("r", "R", false, true))).toBe("hunk.history.rebase");
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
  expect(isHistoryCommandEnabled("hunk.history.clearSelection", marked)).toBe(false);
  expect(isHistoryCommandEnabled("hunk.history.clearSelection", snapshot())).toBe(false);
  expect(
    buildHistoryHelpSections(build(marked))
      .flatMap((section) => section.rows)
      .some((row) => row.description === "mark/unmark revision"),
  ).toBe(false);
});

test("operation locks follow command identity through remapped keyboard bindings", () => {
  let phase: HistoryOperationSnapshot["phase"] = "sources";
  let visit: symbol | null = Symbol("visit");
  const invoked: string[] = [];
  const handlers = Object.fromEntries(
    historyCommandKeyDefaults().map(({ id }) => [id, () => invoked.push(id)]),
  ) as unknown as HistoryCommandHandlers;
  const { keys } = resolveCommandKeys({
    defaults: historyCommandKeyDefaults(),
    userBindings: {
      "hunk.history.editRevset": "ctrl+e",
      "hunk.history.refresh": "ctrl+r",
      "hunk.history.extendNext": "ctrl+n",
      "hunk.history.nextCommit": "x",
    },
  });
  const value = {
    ...snapshot(["parent"]),
    query: { editable: true },
    historyDone: false,
  } as LogSnapshot;
  const commands = buildHistoryCommands({
    getSnapshot: () => value,
    getOperation: () => ({ visit, phase }),
    handlers,
    resolvedKeys: keys,
  });
  expect(dispatchAppCommand(commands, key("e", "", true))).toBeUndefined();
  expect(dispatchAppCommand(commands, key("r", "", true))?.id).toBe("hunk.history.refresh");
  expect(dispatchAppCommand(commands, key("n", "", true))?.id).toBe("hunk.history.extendNext");
  phase = "destination";
  expect(dispatchAppCommand(commands, key("r", "", true))).toBeUndefined();
  expect(dispatchAppCommand(commands, key("n", "", true))).toBeUndefined();
  expect(dispatchAppCommand(commands, key("x"))?.id).toBe("hunk.history.nextCommit");
  visit = null;
  expect(dispatchAppCommand(commands, key("e", "", true))?.id).toBe("hunk.history.editRevset");
  expect(invoked).toEqual([
    "hunk.history.refresh",
    "hunk.history.extendNext",
    "hunk.history.nextCommit",
    "hunk.history.editRevset",
  ]);
});

test("help describes operation keys and excludes commands locked in that phase", () => {
  const commands = buildHistoryCommands({
    getSnapshot: () => ({ ...snapshot(), query: { editable: true } }) as LogSnapshot,
    handlers: noopHandlers,
  });
  const source = buildHistoryHelpSections(commands, { phase: "sources", operation: "squash" });
  const rows = source.flatMap((section) => section.rows);
  expect(source[0]?.title).toBe("Source selection");
  expect(rows).toContainEqual({
    keys: "I / i",
    description: "inspect highlighted revision and return",
  });
  expect(rows).toContainEqual({ keys: "Enter", description: "continue with one explicit source" });
  expect(rows.some((row) => row.description.startsWith("open highlighted"))).toBe(false);
  expect(rows.some((row) => row.description === "edit revset")).toBe(false);
  expect(rows.find((row) => row.description === "page down")?.keys).not.toContain("Space");
  const dest = buildHistoryHelpSections(commands, { phase: "destination", operation: "rebase" });
  expect(dest[0]?.rows).toContainEqual({
    keys: "o / A / B",
    description: "choose onto, after or before",
  });
  expect(
    dest
      .flatMap((section) => section.rows)
      .some((row) => row.description === "extend selection down"),
  ).toBe(false);
  const squash = buildHistoryHelpSections(commands, { phase: "destination", operation: "squash" });
  const squashRows = squash.flatMap((section) => section.rows);
  expect(squashRows.some((row) => row.keys === "d" || row.description.includes("details"))).toBe(
    false,
  );
  expect(squashRows).toContainEqual({
    keys: "PgUp / PgDn",
    description: "scroll messages when they overflow",
  });
  expect(buildHistoryHelpSections(commands)[0]?.title).toBe("Navigation");
});

test("source help keeps remapped Refresh and removes a reserved Space-only paging row", () => {
  const { keys } = resolveCommandKeys({
    defaults: historyCommandKeyDefaults(),
    userBindings: {
      "hunk.history.refresh": "ctrl+r",
      "hunk.history.pageDown": "space",
    },
  });
  const commands = buildHistoryCommands({
    getSnapshot: snapshot,
    handlers: noopHandlers,
    resolvedKeys: keys,
  });
  const rows = buildHistoryHelpSections(commands, {
    phase: "sources",
    operation: "squash",
  }).flatMap((section) => section.rows);
  expect(rows).toContainEqual({ keys: "Ctrl+R", description: "refresh history" });
  expect(rows).toContainEqual({ keys: "r", description: "review unresolved marks when available" });
  expect(rows.some((row) => row.description === "page down")).toBe(false);
  expect(rows.every((row) => row.keys.length > 0)).toBe(true);
});

test("ordinary revision selection commands have distinct remappable keys and lifecycle guards", () => {
  expect(matchCommand(key("m"))).toBe("hunk.history.toggleRevisionSelection");
  expect(matchCommand(key("letter", "M"))).toBe("hunk.history.clearRevisionSelection");
  expect(matchCommand(key("z"), { "hunk.history.toggleRevisionSelection": "z" })).toBe(
    "hunk.history.toggleRevisionSelection",
  );
  expect(isHistoryCommandEnabled("hunk.history.clearRevisionSelection", snapshot())).toBe(false);
  expect(
    isHistoryCommandEnabled("hunk.history.toggleRevisionSelection", {
      ...snapshot(),
      markStatus: "checking",
    }),
  ).toBe(false);
  for (const phase of ["sources", "destination", "preparing", "applying"] as const) {
    const commands = buildHistoryCommands({
      getSnapshot: snapshot,
      handlers: noopHandlers,
      getOperation: () => ({ visit: Symbol("test"), phase }),
    });
    expect(
      commands.find((c) => c.id === "hunk.history.toggleRevisionSelection")!.isEnabled!(),
    ).toBe(false);
    expect(commands.find((c) => c.id === "hunk.history.clearRevisionSelection")!.isEnabled!()).toBe(
      false,
    );
  }
});
