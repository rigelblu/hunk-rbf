import type { KeyEvent } from "@opentui/core";
import {
  HISTORY_COMMAND_CATALOG,
  type HistoryCommandCatalogEntry,
  type HistoryCommandHelpSection,
  type HistoryCommandId,
} from "../../core/run/historyCommandCatalog";
import { matchesAnyKeyChord } from "../../lib/commandKeys";
import type { HelpSection } from "../lib/helpContent";
import { formatKeyChord, type CommandKeyDefaults } from "../lib/keymap";
import type { AppCommand, ResolvedCommandKeys } from "../lib/appCommands";
import type { HistoryOperationPhase, HistoryOperationSnapshot } from "./historyOperationTypes";
import type { LogSnapshot } from "./controller";

export type { HistoryCommandId } from "../../core/run/historyCommandCatalog";

/** What each canonical history command does in the terminal history surface. */
export type HistoryCommandHandlers = Record<
  HistoryCommandId,
  (key: KeyEvent, entry: HistoryCommandCatalogEntry) => void
>;

export interface BuildHistoryCommandsOptions {
  getSnapshot: () => LogSnapshot;
  handlers: HistoryCommandHandlers;
  resolvedKeys?: ResolvedCommandKeys;
  getOperation?: () => Pick<HistoryOperationSnapshot, "visit" | "phase">;
}

/** Return the history command defaults consumed by shared keymap resolution. */
export function historyCommandKeyDefaults(): readonly CommandKeyDefaults[] {
  return HISTORY_COMMAND_CATALOG.map((entry) => ({
    id: entry.id,
    aliases: entry.aliases,
    defaultKeys: entry.defaultKeys,
  }));
}

/** Apply context-sensitive availability consistently to keyboard and menus. */
export function isHistoryCommandEnabled(id: HistoryCommandId, snapshot: LogSnapshot) {
  const selected = snapshot.rows[snapshot.selected];
  if (
    id === "hunk.history.openSelection" ||
    id === "hunk.history.copyRevision" ||
    id === "hunk.history.startVisualSelection"
  )
    return Boolean(selected);
  if (id === "hunk.history.clearRevisionSelection")
    return snapshot.marks.length > 0 || Boolean(snapshot.pendingMarkEdits);
  if (id === "hunk.history.toggleRevisionSelection")
    return (
      Boolean(selected) &&
      snapshot.markStatus === "ready" &&
      !snapshot.pendingMarkEdits &&
      !snapshot.marks.some((mark) => mark.kind === "unresolved")
    );
  if (id === "hunk.history.toggleGraph")
    return !snapshot.stagingGraph && !snapshot.sourceTransitionPending;
  if (id === "hunk.history.toggleNativeGraph")
    return (
      !snapshot.stagingGraph &&
      !snapshot.sourceTransitionPending &&
      snapshot.supportsNativeGraph !== false
    );
  if (id === "hunk.history.squash" || id === "hunk.history.rebase")
    return !snapshot.stagingGraph && !snapshot.sourceTransitionPending;
  if (id === "hunk.history.toggleUnicode") return snapshot.graphStyle !== "native";
  if (id === "hunk.history.editRevset") return snapshot.query?.editable === true;
  if (id === "hunk.history.clearSelection")
    return snapshot.selectionAnchor !== null || snapshot.visualSelectionActive;
  if (
    id === "hunk.history.previousCommit" ||
    id === "hunk.history.extendPrevious" ||
    id === "hunk.history.pageUp" ||
    id === "hunk.history.halfPageUp" ||
    id === "hunk.history.jumpToFirst"
  )
    return snapshot.selected > 0;
  if (
    id === "hunk.history.nextCommit" ||
    id === "hunk.history.extendNext" ||
    id === "hunk.history.pageDown" ||
    id === "hunk.history.halfPageDown" ||
    id === "hunk.history.jumpToLast"
  )
    return !(snapshot.historyDone && snapshot.selected >= snapshot.rows.length - 1);
  if (id === "hunk.history.nextMatch" || id === "hunk.history.previousMatch")
    return Boolean(snapshot.search);
  if (id === "hunk.history.openFirstParent")
    return snapshot.selectionAnchor === null && Boolean(selected?.commit.parentRevisionIds.length);
  if (id === "hunk.history.openParent")
    return (
      snapshot.selectionAnchor === null && (selected?.commit.parentRevisionIds.length ?? 0) > 1
    );
  return true;
}

/** Gate semantic command identities, so remapped keys cannot bypass an operation's phase. */
export function historyOperationCommandAllowed(
  id: HistoryCommandId,
  operation?: Pick<HistoryOperationSnapshot, "visit" | "phase">,
) {
  if (!operation?.visit) return true;
  if (
    [
      "hunk.history.clearSelection",
      "hunk.history.toggleRevisionSelection",
      "hunk.history.clearRevisionSelection",
      "hunk.history.editRevset",
      "hunk.history.toggleGraph",
      "hunk.history.toggleNativeGraph",
      "hunk.history.openSelection",
      "hunk.history.openFirstParent",
      "hunk.history.openParent",
    ].includes(id)
  )
    return false;
  if (
    operation.phase !== "sources" &&
    [
      "hunk.history.refresh",
      "hunk.history.startVisualSelection",
      "hunk.history.extendPrevious",
      "hunk.history.extendNext",
    ].includes(id)
  )
    return false;
  return true;
}

/** Bind canonical history command identity to live terminal handlers. */
export function buildHistoryCommands({
  getSnapshot,
  handlers,
  resolvedKeys,
  getOperation,
}: BuildHistoryCommandsOptions): AppCommand[] {
  return HISTORY_COMMAND_CATALOG.map((entry) => {
    const keys = resolvedKeys?.get(entry.id) ?? entry.defaultKeys;
    return {
      id: entry.id,
      aliases: entry.aliases,
      title:
        entry.id === "hunk.history.openSelection"
          ? getSnapshot().selectionAnchor !== null || getSnapshot().visualSelectionActive
            ? "Open review range"
            : getSnapshot().marks.length > 0
              ? "Open highlighted revision"
              : entry.title
          : entry.id === "hunk.history.toggleRevisionSelection"
            ? getSnapshot().marks.some(
                (mark) =>
                  mark.kind === "resolved" &&
                  mark.revisionId === getSnapshot().rows[getSnapshot().selected]?.commit.revisionId,
              )
              ? "Unselect revision"
              : "Select revision"
            : entry.id === "hunk.history.toggleUnicode" && getSnapshot().graphStyle === "native"
              ? "Unicode lines (JJ config)"
              : entry.title,
      keys,
      keyLabels: keys.map(formatKeyChord),
      defaultKeys: entry.defaultKeys,
      isEnabled: () =>
        isHistoryCommandEnabled(entry.id as HistoryCommandId, getSnapshot()) &&
        historyOperationCommandAllowed(entry.id as HistoryCommandId, getOperation?.()),
      publicToExtensions: entry.publicToExtensions,
      verticalDirection: entry.verticalDirection,
      closesMenu: entry.closesMenu,
      match: matchesAnyKeyChord(keys),
      run: (key) => handlers[entry.id as HistoryCommandId](key, entry),
    };
  });
}

/** Find the canonical history definition used by menus and tests. */
export function historyCommand(id: HistoryCommandId) {
  return HISTORY_COMMAND_CATALOG.find((entry) => entry.id === id)!;
}

/** Build history help from effective session bindings rather than shipped defaults. */
export function buildHistoryHelpSections(
  commands: readonly AppCommand[],
  operation?: { phase: HistoryOperationPhase; operation: "squash" | "rebase" | null },
): readonly HelpSection[] {
  const order: readonly HistoryCommandHelpSection[] = ["Navigation", "Commit", "Application"];
  const byId = new Map(commands.map((command) => [command.id, command]));
  const source = operation?.phase === "sources";
  const destination = operation?.phase === "destination";
  const context = operation ? { visit: Symbol("help"), phase: operation.phase } : undefined;
  const sections: HelpSection[] = order.map((title) => ({
    title,
    rows: HISTORY_COMMAND_CATALOG.filter((entry) => entry.helpSection === title)
      .map((entry) => ({ entry, command: byId.get(entry.id) }))
      .filter(
        ({ entry, command }) =>
          command !== undefined &&
          command.keyLabels.length > 0 &&
          ((!source && !destination) ||
            historyOperationCommandAllowed(entry.id as HistoryCommandId, context)),
      )
      .map(({ command }) => ({
        keys: command!.keyLabels.filter((label) => !source || label !== "Space").join(" / "),
        description: command!.title.toLocaleLowerCase(),
      }))
      .filter((row) => row.keys.length > 0),
  }));
  if (source)
    sections.unshift({
      title: "Source selection",
      rows: [
        { keys: "Space", description: "select/unselect highlighted revision" },
        { keys: "I / i", description: "inspect highlighted revision and return" },
        { keys: "Enter", description: "continue with one explicit source" },
        { keys: "Esc", description: "cancel this action" },
        { keys: "r", description: "review unresolved marks when available" },
      ],
    });
  else if (destination)
    sections.unshift({
      title: "Destination",
      rows: [
        {
          keys: "Enter",
          description:
            operation?.operation === "squash"
              ? "squash into the ready highlighted destination"
              : "preview the highlighted destination",
        },
        ...(operation?.operation === "squash"
          ? [{ keys: "PgUp / PgDn", description: "scroll messages when they overflow" }]
          : []),
        { keys: "Esc", description: "cancel this action" },
        ...(operation?.operation === "rebase"
          ? [{ keys: "o / A / B", description: "choose onto, after or before" }]
          : []),
      ],
    });
  return sections;
}
