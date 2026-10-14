import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { createTestExtensionSession } from "../../../../../test/helpers/extension-session";
import { persistedViewPreferencesFromOptions } from "../../core/run/config";
import { createInteractiveSessionInitialization } from "../../core/session/initialization";
import type { InteractiveHistoryRuntime } from "../history/types";
import { ThemeController } from "../theme/controller";
import { LogApp } from "./LogApp";
import { LogController } from "./controller";

type TestHarness = Awaited<ReturnType<typeof testRender>>;

async function flushTestFrame(setup: TestHarness) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
  return setup.captureCharFrame();
}

test("View menu presents Graph view (jj style) adjacent to Graph view and toggles it", async () => {
  const commits = [
    {
      revisionId: "c111111111111111111111111111111111111111",
      displayId: "c1111111",
      parentRevisionIds: [],
      subject: "First commit",
      authorName: "Ada",
      authoredAt: "2026-10-11T00:00:00Z",
      decorations: [],
    },
    {
      revisionId: "c222222222222222222222222222222222222222",
      displayId: "c2222222",
      parentRevisionIds: [],
      subject: "Second commit",
      authorName: "Ada",
      authoredAt: "2026-10-11T00:00:00Z",
      decorations: [],
    },
  ];

  const defaultSource = {
    graphStyle: "default" as const,
    graphSnapshotId: "snap-1",
    read: async () => ({ commits, done: true }),
    close: async () => {},
    openGraph: async (style: string) => {
      if (style === "native") {
        return {
          graphStyle: "native" as const,
          graphSnapshotId: "snap-1",
          read: async () => ({
            commits: [
              {
                ...commits[0]!,
                nativeGraph: {
                  body: ["@  ", "│  ", "│  "] as [string, string, string],
                  after: ["├──"],
                },
              },
              {
                ...commits[1]!,
                nativeGraph: { body: ["○  ", "│  ", "│  "] as [string, string, string], after: [] },
              },
            ],
            done: true,
          }),
          close: async () => {},
        };
      }
      return defaultSource;
    },
  };

  const preferences = persistedViewPreferencesFromOptions({});
  const runtime: InteractiveHistoryRuntime = {
    input: {
      kind: "history",
      color: "never",
      format: "compact",
      ascii: false,
      static: false,
      extensionsEnabled: false,
      extensionPaths: [],
    },
    source: defaultSource,
    providerId: "test-jj",
    providerName: "Jujutsu",
    repoRoot: "test-repo",
    notices: [],
    customThemes: [],
    keybindings: {},
    initialViewPreferences: preferences,
    promptSaveViewPreferences: false,
    extensionSession: createTestExtensionSession(),
    initialization: createInteractiveSessionInitialization({
      theme: {},
      viewPreferences: preferences,
    }),
    planReview: async (commit) => ({ kind: "revision-show", revisionId: commit.revisionId }),
    reopenSource: async () => defaultSource,
    close: async () => {},
  };

  const controller = new LogController(runtime);
  controller.togglePresentation("graph");
  await controller.loadMore();

  const setup = await testRender(
    <LogApp
      controller={controller}
      runtime={runtime}
      onOutcome={() => {}}
      sessionViewPreferences={preferences}
      autoRefreshEnabled={false}
      onAutoRefreshEnabledChange={() => {}}
      refreshOnMountGeneration={0}
      themeController={new ThemeController({})}
      useColor={false}
    />,
    { width: 100, height: 25 },
  );

  let frame = await flushTestFrame(setup);
  expect(frame).toContain("First commit");

  // Open View menu
  await act(async () => setup.mockInput.pressKey("F10"));
  await act(async () => setup.mockInput.pressArrow("right")); // File -> View
  frame = await flushTestFrame(setup);

  expect(frame).toContain("Graph view");
  expect(frame).toContain("[ ] Graph view (jj style)");

  // Trigger toggleNativeGraph via keybinding Ctrl+G
  await act(async () => setup.mockInput.pressKey("g", { ctrl: true }));
  // Allow staging to complete
  await act(async () => {
    await Bun.sleep(50);
  });
  frame = await flushTestFrame(setup);

  // Check that native graph rendered '@' and after row '├──'
  expect(frame).toContain("@");
  expect(frame).toContain("├──");

  // Open View menu again to verify checkbox state and disabled Unicode lines (JJ config)
  await act(async () => setup.mockInput.pressKey("F10"));
  await act(async () => setup.mockInput.pressArrow("right"));
  frame = await flushTestFrame(setup);

  expect(frame).toContain("[x] Graph view (jj style)");
  expect(frame).toContain("Unicode lines (JJ config)");

  await act(async () => setup.renderer.destroy());
  await controller.close();
});
