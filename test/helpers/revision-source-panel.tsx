/** Exercise source-panel gestures with the real controller, without a production mutation host. */
import { useKeyboard } from "@opentui/react";
import { useState, useSyncExternalStore } from "react";
import { createTestExtensionSession } from "./extension-session";
import { persistedViewPreferencesFromOptions } from "../../packages/hunk/src/core/run/config";
import type { HistoryRuntime } from "../../packages/hunk/src/ui/history/types";
import { LogController } from "../../packages/hunk/src/ui/log/controller";
import { RevisionSourceSelection } from "../../packages/hunk/src/ui/log/revisionSourceSelection";
import {
  RevisionSourceMark,
  RevisionSourcePanel,
  handleRevisionSourcePanelKey,
} from "../../packages/hunk/src/ui/log/RevisionSourcePanel";
import { resolveTheme } from "../../packages/hunk/src/ui/themes";

/** Load three deterministic revisions through the actual history controller. */
export async function createTestRevisionSourcePanelController() {
  const preferences = persistedViewPreferencesFromOptions({});
  const makeSource = () => ({
    read: async () => ({
      commits: ["A", "B", "C"].map((revisionId) => ({
        revisionId,
        displayId: revisionId,
        subject: revisionId,
        parentRevisionIds: [],
        authorName: "Test",
        authoredAt: "2026-10-14T00:00:00Z",
        decorations: [],
      })),
      done: true,
    }),
    close: async () => {},
  });
  const runtime: HistoryRuntime = {
    input: {
      kind: "history",
      color: "never",
      format: "compact",
      ascii: false,
      static: false,
      extensionsEnabled: false,
      extensionPaths: [],
    },
    source: makeSource(),
    extensionSession: createTestExtensionSession(),
    providerId: "test",
    providerName: "Test",
    repoRoot: "test-repo",
    notices: [],
    customThemes: [],
    keybindings: {},
    initialViewPreferences: preferences,
    promptSaveViewPreferences: true,
    planReview: async (commit) => ({ kind: "revision-show", revisionId: commit.revisionId }),
    reopenSource: async () => makeSource(),
    close: async () => {},
  };
  const controller = new LogController(runtime);
  await controller.loadMore();
  return controller;
}

/** Compose test rows with the prepared controls; do not pretend to mount Rebase or Squash. */
export function TestRevisionSourcePanel({
  controller,
  selection,
  visit,
  width,
  onContinue = () => {},
}: {
  controller: LogController;
  selection: RevisionSourceSelection;
  visit: symbol;
  width: number;
  onContinue?: () => void;
}) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [phase, setPhase] = useState<"sources" | "locked" | "cancelled">("sources");
  const theme = resolveTheme("github-dark-default", null);
  const state = { targets: selection.targets(visit), selectedCount: snapshot.marks.length };
  const actions = {
    toggle: () => {
      selection.toggle(visit);
    },
    continue: () => {
      selection.lock(visit);
      setPhase("locked");
      onContinue();
    },
    cancel: () => {
      selection.end(visit);
      setPhase("cancelled");
    },
  };
  useKeyboard(async (key) => {
    await controller.settleNavigation();
    if (phase !== "sources") return;
    if (
      handleRevisionSourcePanelKey(
        key,
        { targets: selection.targets(visit), selectedCount: controller.getSnapshot().marks.length },
        actions,
      )
    )
      return;
    if (key.name === "down") await controller.move(1, 20);
    if (key.name === "up") await controller.move(-1, 20);
    if (key.name === "pagedown") await controller.page(1, 20);
    if (key.name === "pageup") await controller.page(-1, 20);
  });
  return (
    <box style={{ width, flexDirection: "column" }}>
      <text>Source panel test harness</text>
      {snapshot.rows.map((row, index) => (
        <box
          key={row.commit.revisionId}
          style={{ height: 1, flexDirection: "row" }}
          onMouseUp={() => {
            controller.select(index, 20);
          }}
        >
          <text style={{ width: 2 }}>{snapshot.selected === index ? "> " : "  "}</text>
          <RevisionSourceMark
            selected={selection.indicator(row.commit.revisionId) === "✓"}
            editable={phase === "sources"}
            onToggle={() => {
              selection.toggle(visit, index);
            }}
            theme={theme}
          />
          <text>Revision {row.commit.revisionId}</text>
        </box>
      ))}
      {phase === "sources" ? (
        <RevisionSourcePanel
          operationLabel="rebase"
          width={width}
          state={state}
          actions={actions}
          theme={theme}
        />
      ) : (
        <text>
          {phase === "locked" ? "Sources locked (test harness)" : "Source selection cancelled"}
        </text>
      )}
    </box>
  );
}
