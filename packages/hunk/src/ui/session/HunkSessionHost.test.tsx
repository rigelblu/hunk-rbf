import { expect, mock, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { createTestVcsAppBootstrap } from "../../../../../test/helpers/app-bootstrap";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import { createTestExtensionSession } from "../../../../../test/helpers/extension-session";
import { persistedViewPreferencesFromOptions } from "../../core/run/config";
import { createEmptyExtensionLoadResult } from "../../extensions/types";
import type { InteractiveHistoryRuntime } from "../history/types";
import { LogController } from "../log/controller";
import { PreviousInputs } from "./previousInputs";
import { availableThemes } from "../themes";
import {
  HunkSessionHost,
  type HistorySurfaceRoute,
  type HunkSessionHostDeps,
} from "./HunkSessionHost";

mock.restore();

const historyCustomTheme = {
  id: "history-only",
  label: "History only",
  accent: "#112233",
} as const;
const reviewCustomTheme = {
  id: "review-only",
  label: "Review only",
  accent: "#abcdef",
} as const;

/** Create a loaded history route for session-host navigation tests. */
async function createHistoryRoute(subjects = ["History row"]) {
  const commits = subjects.map((subject, index) => ({
    revisionId: `revision-${String.fromCharCode(97 + index)}`,
    displayId: index === 0 ? "revision" : `rev-${index}`,
    parentRevisionIds:
      index + 1 < subjects.length ? [`revision-${String.fromCharCode(98 + index)}`] : [],
    subject,
    authorName: "Ada",
    authoredAt: "2026-01-01T00:00:00Z",
    decorations: [],
  }));
  const initialViewPreferences = persistedViewPreferencesFromOptions({});
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
    extensionSession: createTestExtensionSession(),
    source: {
      async read() {
        return { commits, done: true };
      },
      async close() {},
    },
    providerId: "test",
    providerName: "Test",
    repoRoot: "/repo",
    notices: [],
    customThemes: [],
    initialization: { theme: { customThemes: [] }, viewPreferences: initialViewPreferences },
    keybindings: {},
    initialViewPreferences,
    promptSaveViewPreferences: true,
    async planReview(commit) {
      return { kind: "revision-show", revisionId: commit.revisionId };
    },
    async planRangeReview(selection, options) {
      return {
        kind: "revision-range",
        fromRevisionId:
          options?.parentRevisionId ?? selection.oldestCommit.parentRevisionIds[0] ?? "empty",
        toRevisionId: selection.newestCommit.revisionId,
      };
    },
    async reopenSource() {
      return this.source;
    },
    async close() {},
  };
  const controller = new LogController(runtime);
  await controller.loadMore();
  return { kind: "history", controller, runtime } satisfies HistorySurfaceRoute;
}

/** Select Quit through the live history menu while review preparation owns the input lock. */
async function selectHistoryMenuQuit(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => setup.mockInput.pressKey("f10"));
  await act(async () => setup.mockInput.pressKey("q"));
}

/** Flush async history planning and mounted review shutdown work. */
async function settle(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await Bun.sleep(20);
    await setup.renderOnce();
    await Bun.sleep(20);
    await setup.renderOnce();
  });
}

/** Preview the trailing custom theme from one known committed bundled theme. */
async function previewTrailingCustomTheme(
  setup: Awaited<ReturnType<typeof testRender>>,
  committedThemeId: string,
) {
  const committedIndex = availableThemes().findIndex((theme) => theme.id === committedThemeId);
  if (committedIndex < 0) throw new Error(`Unknown bundled theme: ${committedThemeId}`);
  await act(async () => {
    for (let step = 0; step <= committedIndex; step++) setup.mockInput.pressArrow("up");
  });
  await setup.renderOnce();
}

test("routes repeated history reviews through fresh runtimes and returns instead of quitting", async () => {
  const history = await createHistoryRoute();
  const quit = mock(() => undefined);
  const stops: Array<ReturnType<typeof mock>> = [];
  let instance = 0;
  const deps: HunkSessionHostDeps = {
    prepareReview: (async () => {
      const bootstrap = createTestVcsAppBootstrap({
        changesetId: `review-${++instance}`,
        files: [createTestDiffFile({ id: "review.ts", path: "review.ts" })],
      });
      bootstrap.extensions = history.runtime.extensionSession.current;
      return {
        bootstrap,
        initialization: history.runtime.initialization,
        borrowsExtensions: true,
      };
    }) as never,
    createReviewRuntime: (() => {
      const stop = mock(() => undefined);
      stops.push(stop);
      return { hostClient: undefined, reviewProducer: undefined, stop };
    }) as never,
  };
  const abort = new AbortController();
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={history}
      initialization={history.runtime.initialization}
      externalQuitSignal={abort.signal}
      onQuit={quit}
      deps={deps}
    />,
    { width: 100, height: 20 },
  );
  try {
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("History row");

    await act(async () => setup.mockInput.pressEnter());
    await settle(setup);
    const reviewFrame = setup.captureCharFrame();
    expect(reviewFrame).not.toContain("Commits on");
    expect(reviewFrame).toContain("History row");
    expect(
      reviewFrame
        .split("\n")
        .find((line) => line.includes("History row"))
        ?.trimEnd(),
    ).toEndWith("revision ⧉");
    expect(reviewFrame).toContain("Ada ·");
    expect(reviewFrame).not.toContain("Ada · Test");
    await act(async () => setup.mockInput.pressKey("q"));
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("History row");

    await act(async () => setup.mockInput.pressEnter());
    await settle(setup);
    await act(async () => setup.mockInput.pressKey("q"));
    await settle(setup);

    expect(stops).toHaveLength(2);
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(stops[1]).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
  } finally {
    setup.renderer.destroy();
    await history.controller.close();
  }
});

test("keeps one previous-input list across history reviews for the whole session", async () => {
  const history = await createHistoryRoute();
  const created: PreviousInputs[] = [];
  let instance = 0;
  const deps: HunkSessionHostDeps = {
    createPreviousInputs: () => {
      const inputs = new PreviousInputs();
      created.push(inputs);
      return inputs;
    },
    prepareReview: (async () => {
      const bootstrap = createTestVcsAppBootstrap({
        changesetId: `review-${++instance}`,
        files: [createTestDiffFile({ id: "review.ts", path: "review.ts" })],
      });
      bootstrap.extensions = history.runtime.extensionSession.current;
      return {
        bootstrap,
        initialization: history.runtime.initialization,
        borrowsExtensions: true,
      };
    }) as never,
    createReviewRuntime: (() => ({
      hostClient: undefined,
      reviewProducer: undefined,
      stop: mock(() => undefined),
    })) as never,
  };
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={history}
      initialization={history.runtime.initialization}
      externalQuitSignal={new AbortController().signal}
      onQuit={mock(() => undefined)}
      deps={deps}
    />,
    { width: 100, height: 20 },
  );
  try {
    await setup.renderOnce();
    expect(created).toHaveLength(1);
    created[0]!.record("@-");

    for (let trip = 0; trip < 2; trip += 1) {
      await act(async () => setup.mockInput.pressEnter());
      await settle(setup);
      expect(setup.captureCharFrame()).not.toContain("Commits on");
      await act(async () => setup.mockInput.pressKey("q"));
      await settle(setup);
      expect(setup.captureCharFrame()).toContain("History row");
    }

    // Two round trips through a review neither rebuilt nor emptied the list.
    expect(created).toHaveLength(1);
    expect(created[0]!.list()).toEqual(["@-"]);
  } finally {
    setup.renderer.destroy();
    await history.controller.close();
  }
});

test("retains review view preferences across repeated history reviews", async () => {
  const history = await createHistoryRoute();
  const initialViewPreferences = persistedViewPreferencesFromOptions({ mode: "split" });
  history.runtime.initialViewPreferences = initialViewPreferences;
  history.runtime.initialization = {
    ...history.runtime.initialization,
    viewPreferences: initialViewPreferences,
  };
  const quit = mock(() => undefined);
  const deps: HunkSessionHostDeps = {
    prepareReview: (async () => {
      const bootstrap = createTestVcsAppBootstrap({
        changesetId: "preference-review",
        files: [createTestDiffFile({ id: "review.ts", path: "review.ts" })],
        initialMode: "split",
      });
      bootstrap.extensions = history.runtime.extensionSession.current;
      return {
        bootstrap,
        initialization: history.runtime.initialization,
        borrowsExtensions: true,
      };
    }) as never,
    createReviewRuntime: (() => ({
      hostClient: undefined,
      reviewProducer: undefined,
      stop: mock(() => undefined),
    })) as never,
  };
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={history}
      initialization={history.runtime.initialization}
      externalQuitSignal={new AbortController().signal}
      onQuit={quit}
      deps={deps}
    />,
    { width: 120, height: 20 },
  );
  try {
    await setup.renderOnce();
    await act(async () => setup.mockInput.pressEnter());
    await settle(setup);
    expect(setup.captureCharFrame()).toMatch(/▌.*▌/);

    await act(async () => setup.mockInput.typeText("1q"));
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Test history");
    expect(setup.captureCharFrame()).not.toContain("Save view preferences?");

    await act(async () => setup.mockInput.pressEnter());
    await settle(setup);
    expect(setup.captureCharFrame()).not.toMatch(/▌.*▌/);

    await act(async () => setup.mockInput.pressKey("q"));
    await settle(setup);
    await act(async () => setup.mockInput.pressKey("q"));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Save view preferences?");
    expect(setup.captureCharFrame()).toContain('- mode = "split"');
    expect(setup.captureCharFrame()).toContain('+ mode = "unified"');
    expect(quit).not.toHaveBeenCalled();
  } finally {
    setup.renderer.destroy();
    await history.controller.close();
  }
});

test("shares committed themes across history and repeated review surfaces", async () => {
  const history = await createHistoryRoute();
  history.runtime.initialization = {
    ...history.runtime.initialization,
    theme: { customThemes: [historyCustomTheme] },
  };
  const requests: Array<{ themeId?: string }> = [];
  const deps: HunkSessionHostDeps = {
    prepareReview: (async (request: { themeId?: string }) => {
      requests.push(request);
      const bootstrap = createTestVcsAppBootstrap({
        changesetId: `theme-review-${requests.length}`,
        files: [createTestDiffFile({ id: "review.ts", path: "review.ts" })],
      });
      bootstrap.extensions = history.runtime.extensionSession.current;
      return {
        bootstrap,
        initialization: {
          ...history.runtime.initialization,
          theme: { customThemes: [reviewCustomTheme] },
        },
        borrowsExtensions: true,
      };
    }) as never,
    createReviewRuntime: (() => ({
      hostClient: undefined,
      reviewProducer: undefined,
      stop: mock(() => undefined),
    })) as never,
  };
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={history}
      initialization={history.runtime.initialization}
      externalQuitSignal={new AbortController().signal}
      onQuit={() => undefined}
      deps={deps}
    />,
    { width: 100, height: 20 },
  );
  try {
    await setup.renderOnce();
    await act(async () => setup.mockInput.typeText("t"));
    await setup.renderOnce();
    await act(async () => setup.mockInput.pressArrow("down"));
    await act(async () => setup.mockInput.pressEnter());
    await setup.renderOnce();

    await act(async () => setup.mockInput.pressEnter());
    await settle(setup);
    // The unconfigured default `github-dark-default` is selected; one step down lands on `github-dark-dimmed`.
    expect(requests[0]?.themeId).toBe("github-dark-dimmed");

    await act(async () => setup.mockInput.typeText("t"));
    await setup.renderOnce();
    await previewTrailingCustomTheme(setup, "github-dark-dimmed");
    expect(setup.captureCharFrame()).toContain("Review only");
    expect(setup.captureCharFrame()).not.toContain("History only");
    await act(async () => setup.mockInput.pressEnter());
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Theme: Review only");

    await act(async () => setup.mockInput.pressKey("q"));
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Test history");
    await act(async () => setup.mockInput.typeText("t"));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("›  Review only");
    expect(setup.captureCharFrame()).toContain("Review only");
    expect(setup.captureCharFrame()).not.toContain("History only");
    await act(async () => setup.mockInput.pressEnter());
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("Theme selector");

    await act(async () => setup.mockInput.pressEnter());
    await settle(setup);
    expect(requests[1]?.themeId).toBe("review-only");
    await act(async () => setup.mockInput.typeText("t"));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("›  Review only");

    await act(async () => setup.mockInput.pressEnter());
    await act(async () => setup.mockInput.pressKey("q"));
    await settle(setup);
    await act(async () => setup.mockInput.pressKey("q"));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Save view preferences?");
    expect(setup.captureCharFrame()).toContain('+ theme = "review-only"');
  } finally {
    setup.renderer.destroy();
    await history.controller.close();
  }
});

test("seeds the shared catalog from interactive initialization, not static history data", async () => {
  const history = await createHistoryRoute();
  history.runtime.customThemes = [
    {
      id: "static-only",
      label: "Static only",
      accent: "#112233",
    },
  ];
  history.runtime.initialization = {
    ...history.runtime.initialization,
    theme: {
      initialTheme: "session-only",
      customThemes: [
        {
          id: "session-only",
          label: "Session only",
          accent: "#abcdef",
        },
      ],
    },
  };
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={history}
      initialization={history.runtime.initialization}
      externalQuitSignal={new AbortController().signal}
      onQuit={() => undefined}
    />,
    { width: 100, height: 20 },
  );
  try {
    await setup.renderOnce();
    await act(async () => setup.mockInput.typeText("t"));
    await setup.renderOnce();

    const frame = setup.captureCharFrame();
    expect(frame).toContain("Session only");
    expect(frame).not.toContain("Static only");
    expect(frame).toContain("active");
  } finally {
    setup.renderer.destroy();
    await history.controller.close();
  }
});

test("opens an extended history selection as one inclusive comparison", async () => {
  const history = await createHistoryRoute(["Newest", "Oldest"]);
  const requests: unknown[] = [];
  const deps: HunkSessionHostDeps = {
    prepareReview: (async (request: unknown) => {
      requests.push(request);
      const bootstrap = createTestVcsAppBootstrap({
        changesetId: "range-review",
        files: [createTestDiffFile({ id: "range.ts", path: "range.ts" })],
      });
      bootstrap.extensions = history.runtime.extensionSession.current;
      return {
        bootstrap,
        initialization: history.runtime.initialization,
        borrowsExtensions: true,
      };
    }) as never,
    createReviewRuntime: (() => ({
      hostClient: undefined,
      reviewProducer: undefined,
      stop: mock(() => undefined),
    })) as never,
  };
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={history}
      initialization={history.runtime.initialization}
      externalQuitSignal={new AbortController().signal}
      onQuit={() => undefined}
      deps={deps}
    />,
    { width: 100, height: 20 },
  );
  try {
    await setup.renderOnce();
    await act(async () => setup.mockInput.typeText("J"));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Review range: 2");
    await act(async () => setup.mockInput.pressEnter());
    await settle(setup);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      action: {
        kind: "revision-range",
        fromRevisionId: "empty",
        toRevisionId: "revision-a",
      },
    });
  } finally {
    setup.renderer.destroy();
    await history.controller.close();
  }
});

test("quits the session from a standalone review route", async () => {
  const quit = mock(() => undefined);
  const stop = mock(() => undefined);
  const abort = new AbortController();
  const extensionSession = createTestExtensionSession();
  const bootstrap = createTestVcsAppBootstrap({
    changesetId: "standalone-review",
    files: [createTestDiffFile({ id: "standalone.ts", path: "standalone.ts" })],
  });
  bootstrap.extensions = extensionSession.current;
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={{
        kind: "review",
        instanceId: 1,
        bootstrap: bootstrap as never,
        runtime: {
          hostClient: undefined,
          reviewProducer: undefined,
          stop,
        } as never,
        extensionSession,
      }}
      initialization={{
        theme: { initialTheme: bootstrap.initialTheme!, customThemes: [] },
        viewPreferences: persistedViewPreferencesFromOptions(bootstrap.input.options),
      }}
      externalQuitSignal={abort.signal}
      onQuit={quit}
    />,
    { width: 100, height: 20 },
  );
  try {
    await setup.renderOnce();
    await act(async () => setup.mockInput.pressKey("q"));
    await settle(setup);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  } finally {
    setup.renderer.destroy();
  }
});

test("finishes review navigation even when broker shutdown throws", async () => {
  const quit = mock(() => undefined);
  const stop = mock(() => {
    throw new Error("broker close failed");
  });
  const abort = new AbortController();
  const extensionSession = createTestExtensionSession();
  const bootstrap = createTestVcsAppBootstrap({
    changesetId: "failing-broker-review",
    files: [createTestDiffFile({ id: "failing.ts", path: "failing.ts" })],
  });
  bootstrap.extensions = extensionSession.current;
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={{
        kind: "review",
        instanceId: 1,
        bootstrap: bootstrap as never,
        runtime: {
          hostClient: undefined,
          reviewProducer: undefined,
          stop,
        } as never,
        extensionSession,
      }}
      initialization={{
        theme: { initialTheme: bootstrap.initialTheme!, customThemes: [] },
        viewPreferences: persistedViewPreferencesFromOptions(bootstrap.input.options),
      }}
      externalQuitSignal={abort.signal}
      onQuit={quit}
    />,
    { width: 100, height: 20 },
  );
  try {
    await setup.renderOnce();
    await act(async () => setup.mockInput.pressKey("q"));
    await settle(setup);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  } finally {
    setup.renderer.destroy();
  }
});

test("does not start provider planning after shutdown wins the pre-dispatch window", async () => {
  const history = await createHistoryRoute();
  const planReview = mock(history.runtime.planReview);
  history.runtime.planReview = planReview;
  const abort = new AbortController();
  const quit = mock(() => undefined);
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={history}
      initialization={history.runtime.initialization}
      externalQuitSignal={abort.signal}
      onQuit={quit}
    />,
    { width: 100, height: 20 },
  );
  try {
    await setup.renderOnce();
    await act(async () => {
      setup.mockInput.pressEnter();
      abort.abort();
    });
    await settle(setup);
    expect(planReview).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledTimes(1);
  } finally {
    setup.renderer.destroy();
    await history.controller.close();
  }
});

test("refuses a nested review that returns independent extension authority", async () => {
  const history = await createHistoryRoute();
  history.runtime.initialization = {
    ...history.runtime.initialization,
    theme: { initialTheme: historyCustomTheme.id, customThemes: [historyCustomTheme] },
  };
  const foreign = createEmptyExtensionLoadResult("/repo");
  const createReviewRuntime = mock(() => {
    throw new Error("nested runtime mounted");
  });
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={history}
      initialization={history.runtime.initialization}
      externalQuitSignal={new AbortController().signal}
      onQuit={() => undefined}
      deps={{
        prepareReview: (async () => ({
          bootstrap: {
            ...createTestVcsAppBootstrap({
              changesetId: "foreign-review",
              files: [createTestDiffFile({ id: "foreign.ts", path: "foreign.ts" })],
            }),
            extensions: foreign,
          },
          initialization: {
            ...history.runtime.initialization,
            theme: { customThemes: [reviewCustomTheme] },
          },
          borrowsExtensions: false,
        })) as never,
        createReviewRuntime: createReviewRuntime as never,
      }}
    />,
    { width: 100, height: 20 },
  );
  try {
    await setup.renderOnce();
    await act(async () => setup.mockInput.pressEnter());
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("History row");
    expect(setup.captureCharFrame()).toContain("cannot replace");
    expect(createReviewRuntime).not.toHaveBeenCalled();
    expect(foreign.registry.eventBusPhase).toBe("closed");
    expect(history.runtime.extensionSession.closing).toBe(false);
    await act(async () => setup.mockInput.typeText("t"));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("History only");
    expect(setup.captureCharFrame()).not.toContain("Review only");
  } finally {
    setup.renderer.destroy();
    await history.controller.close();
  }
});

test("keeps history mounted when review preparation fails", async () => {
  const history = await createHistoryRoute();
  const quit = mock(() => undefined);
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={history}
      initialization={history.runtime.initialization}
      externalQuitSignal={new AbortController().signal}
      onQuit={quit}
      deps={{
        prepareReview: (async () => {
          throw new Error("provider failed");
        }) as never,
      }}
    />,
    { width: 100, height: 20 },
  );
  try {
    await setup.renderOnce();
    await act(async () => setup.mockInput.pressEnter());
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("History row");
    expect(setup.captureCharFrame()).toContain("provider failed");
    expect(quit).not.toHaveBeenCalled();
  } finally {
    setup.renderer.destroy();
    await history.controller.close();
  }
});

test("waits for non-cooperative provider planning before menu quit", async () => {
  const history = await createHistoryRoute();
  let resolvePlanning!: (value: { kind: "revision-show"; revisionId: string }) => void;
  const planning = new Promise<{ kind: "revision-show"; revisionId: string }>((resolve) => {
    resolvePlanning = resolve;
  });
  let planningSignal: AbortSignal | undefined;
  history.runtime.planReview = mock((_commit, _options, signal) => {
    planningSignal = signal;
    return planning;
  });
  const prepareReview = mock(async () => {
    throw new Error("cancelled planning reached preparation");
  });
  const quit = mock(() => undefined);
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={history}
      initialization={history.runtime.initialization}
      externalQuitSignal={new AbortController().signal}
      onQuit={quit}
      deps={{ prepareReview: prepareReview as never }}
    />,
    { width: 100, height: 20 },
  );
  try {
    await setup.renderOnce();
    await act(async () => setup.mockInput.pressEnter());
    await Bun.sleep(10);
    await selectHistoryMenuQuit(setup);
    expect(quit).not.toHaveBeenCalled();
    expect(planningSignal?.aborted).toBeTrue();

    resolvePlanning({ kind: "revision-show", revisionId: "revision-a" });
    await settle(setup);
    expect(prepareReview).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledTimes(1);
  } finally {
    setup.renderer.destroy();
    await history.controller.close();
  }
});

test("blocks reopening until dirty-quit cancellation settles", async () => {
  const history = await createHistoryRoute();
  let resolvePlanning!: (value: { kind: "revision-show"; revisionId: string }) => void;
  const planning = new Promise<{ kind: "revision-show"; revisionId: string }>((resolve) => {
    resolvePlanning = resolve;
  });
  history.runtime.planReview = mock(() => planning);
  const prepareReview = mock(async () => {
    throw new Error("cancelled planning reached preparation");
  });
  const quit = mock(() => undefined);
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={history}
      initialization={history.runtime.initialization}
      externalQuitSignal={new AbortController().signal}
      onQuit={quit}
      deps={{ prepareReview: prepareReview as never }}
    />,
    { width: 100, height: 20 },
  );
  try {
    await setup.renderOnce();
    await act(async () => setup.mockInput.typeText("t"));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Theme selector");
    await act(async () => setup.mockInput.pressArrow("down"));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("›  github-dark-dimmed");
    await act(async () => setup.mockInput.pressEnter());
    await setup.renderOnce();
    await act(async () => setup.mockInput.pressEnter());
    await Bun.sleep(10);
    await selectHistoryMenuQuit(setup);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Save view preferences?");

    await act(async () => setup.mockInput.pressKey("escape"));
    await setup.renderOnce();
    await act(async () => setup.mockInput.pressEnter());
    expect(setup.captureCharFrame()).not.toContain("Save view preferences?");

    resolvePlanning({ kind: "revision-show", revisionId: "revision-a" });
    await settle(setup);
    await act(async () => Bun.sleep(20));
    await setup.renderOnce();
    expect(prepareReview).not.toHaveBeenCalled();
    expect(setup.captureCharFrame()).toContain("History row");
    expect(setup.captureCharFrame()).not.toContain("Preparing review");
    expect(quit).not.toHaveBeenCalled();
  } finally {
    setup.renderer.destroy();
    await history.controller.close();
  }
});

test("preserves the original exit status while a saved-preferences quit is delayed", async () => {
  const history = await createHistoryRoute();
  const configHome = mkdtempSync(join(tmpdir(), "hunk-log-delayed-quit-"));
  history.runtime.viewPreferencesConfigPath = join(configHome, "config.toml");
  const quit = mock(() => undefined);
  let scheduledQuit: (() => void) | undefined;
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={history}
      initialization={history.runtime.initialization}
      externalQuitSignal={new AbortController().signal}
      onQuit={quit}
      deps={{
        viewPreferenceQuitScheduler: {
          schedule(callback) {
            scheduledQuit = callback;
            return callback;
          },
          cancel() {},
        },
      }}
    />,
    { width: 100, height: 20 },
  );
  try {
    await setup.renderOnce();
    await act(async () => setup.mockInput.typeText("t"));
    await setup.renderOnce();
    await act(async () => setup.mockInput.pressArrow("down"));
    await setup.renderOnce();
    await act(async () => setup.mockInput.pressEnter());
    await setup.renderOnce();
    await act(async () => setup.mockInput.typeText("q"));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Save view preferences?");

    await act(async () => setup.mockInput.typeText("s"));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Saved view preferences");
    await act(async () => setup.mockInput.pressKey("c", { ctrl: true }));
    expect(scheduledQuit).toBeDefined();
    await act(async () => scheduledQuit?.());

    expect(quit).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledWith(undefined);
  } finally {
    setup.renderer.destroy();
    await history.controller.close();
    rmSync(configHome, { recursive: true, force: true });
  }
});

test("waits for non-cooperative provider planning after an external signal", async () => {
  const history = await createHistoryRoute();
  let resolvePlanning!: (value: { kind: "revision-show"; revisionId: string }) => void;
  const planning = new Promise<{ kind: "revision-show"; revisionId: string }>((resolve) => {
    resolvePlanning = resolve;
  });
  history.runtime.planReview = mock(() => planning);
  const abort = new AbortController();
  const quit = mock(() => undefined);
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={history}
      initialization={history.runtime.initialization}
      externalQuitSignal={abort.signal}
      onQuit={quit}
    />,
    { width: 100, height: 20 },
  );
  try {
    await setup.renderOnce();
    await act(async () => setup.mockInput.pressEnter());
    await Bun.sleep(10);
    act(() => abort.abort());
    expect(quit).not.toHaveBeenCalled();

    resolvePlanning({ kind: "revision-show", revisionId: "revision-a" });
    await settle(setup);
    expect(quit).toHaveBeenCalledTimes(1);
  } finally {
    setup.renderer.destroy();
    await history.controller.close();
  }
});

test("defers menu quit until cancelled preparation and retirement settle", async () => {
  const history = await createHistoryRoute();
  const events: string[] = [];
  const quit = mock(() => events.push("quit"));
  let resolvePreparation!: (value: unknown) => void;
  const preparation = new Promise((resolve) => {
    resolvePreparation = resolve;
  });
  history.runtime.extensionSession.trackPrepared = mock(() => undefined);
  history.runtime.extensionSession.retirePrepared = mock(async () => {
    events.push("retire");
  });
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={history}
      initialization={history.runtime.initialization}
      externalQuitSignal={new AbortController().signal}
      onQuit={quit}
      deps={{ prepareReview: (() => preparation) as never }}
    />,
    { width: 100, height: 20 },
  );
  try {
    await setup.renderOnce();
    await act(async () => setup.mockInput.pressEnter());
    await Bun.sleep(10);
    await selectHistoryMenuQuit(setup);
    expect(quit).not.toHaveBeenCalled();

    resolvePreparation({
      bootstrap: {
        ...createTestVcsAppBootstrap({
          changesetId: "cancelled-review",
          files: [createTestDiffFile({ id: "cancelled.ts", path: "cancelled.ts" })],
        }),
        extensions: createEmptyExtensionLoadResult("/repo"),
      },
      initialization: history.runtime.initialization,
      borrowsExtensions: false,
    });
    await settle(setup);
    expect(events).toEqual(["retire", "quit"]);
  } finally {
    setup.renderer.destroy();
    await history.controller.close();
  }
});

test("cancels stale preparation, retires its owned registry, and quits once", async () => {
  const history = await createHistoryRoute();
  const events: string[] = [];
  const quit = mock(() => events.push("quit"));
  let resolveRetirement!: () => void;
  const retirement = new Promise<void>((resolve) => {
    resolveRetirement = resolve;
  });
  const retire = mock(async () => {
    events.push("retire-start");
    await retirement;
    events.push("retire-finish");
  });
  let resolvePreparation!: (value: unknown) => void;
  const preparation = new Promise((resolve) => {
    resolvePreparation = resolve;
  });
  const abort = new AbortController();
  history.runtime.extensionSession.trackPrepared = mock(() => undefined);
  history.runtime.extensionSession.retirePrepared = retire as never;
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={history}
      initialization={history.runtime.initialization}
      externalQuitSignal={abort.signal}
      onQuit={quit}
      deps={{
        prepareReview: (() => preparation) as never,
        createReviewRuntime: mock(() => {
          throw new Error("stale review mounted");
        }) as never,
      }}
    />,
    { width: 100, height: 20 },
  );
  try {
    await setup.renderOnce();
    await act(async () => setup.mockInput.pressEnter());
    await Bun.sleep(10);
    act(() => abort.abort());
    expect(quit).not.toHaveBeenCalled();
    resolvePreparation({
      bootstrap: {
        ...createTestVcsAppBootstrap({
          changesetId: "stale-review",
          files: [createTestDiffFile({ id: "stale.ts", path: "stale.ts" })],
        }),
        extensions: createEmptyExtensionLoadResult("/repo"),
      },
      initialization: history.runtime.initialization,
      borrowsExtensions: false,
    });
    await act(async () => {
      await Bun.sleep(10);
      await setup.renderOnce();
    });
    expect(retire).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
    resolveRetirement();
    await settle(setup);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["retire-start", "retire-finish", "quit"]);
  } finally {
    setup.renderer.destroy();
    await history.controller.close();
  }
});

/** Expose only operation entry for retained-inspection tests; no provider command runs here. */
function enableSourceSelectionTestMutations(history: HistorySurfaceRoute) {
  history.runtime.mutations = {
    availability: async () => ({
      kind: "supported",
      kinds: ["squash", "rebase"],
      providerVersion: "test",
    }),
    prepare: async () => {
      throw new Error("Inspection unexpectedly prepared a mutation");
    },
    apply: async () => {
      throw new Error("Inspection unexpectedly applied a mutation");
    },
    dispose: async () => {},
  };
  history.runtime.promptSaveViewPreferences = false;
}

test("operation inspection borrows singleton review and returns to the same marks, range and reading position", async () => {
  const history = await createHistoryRoute(["Source A", "Inspect B", "Older C"]);
  enableSourceSelectionTestMutations(history);
  const planned: string[] = [];
  const originalPlan = history.runtime.planReview;
  history.runtime.planReview = async (commit, options, signal) => {
    planned.push(commit.revisionId);
    return originalPlan(commit, options, signal);
  };
  const quit = mock(() => undefined);
  const stop = mock(() => undefined);
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={history}
      initialization={history.runtime.initialization}
      externalQuitSignal={new AbortController().signal}
      onQuit={quit}
      deps={{
        prepareReview: (async () => {
          const bootstrap = createTestVcsAppBootstrap({
            changesetId: "inspect",
            files: [createTestDiffFile({ id: "inspect.ts", path: "inspect.ts" })],
          });
          bootstrap.extensions = history.runtime.extensionSession.current;
          return {
            bootstrap,
            initialization: history.runtime.initialization,
            borrowsExtensions: true,
          };
        }) as never,
        createReviewRuntime: (() => ({
          hostClient: undefined,
          reviewProducer: undefined,
          stop,
        })) as never,
      }}
    />,
    { width: 100, height: 24 },
  );
  try {
    await settle(setup);
    await act(async () => setup.mockInput.pressKey("R"));
    await settle(setup);
    await act(async () => history.controller.select(1, 15, { extend: true }));
    await settle(setup);
    const before = history.controller.getSnapshot();
    await act(async () => setup.mockInput.pressKey("I"));
    await settle(setup);
    expect(planned).toEqual(["revision-b"]);
    expect(setup.captureCharFrame()).toContain("inspect.ts");
    await act(async () => setup.mockInput.pressKey("q"));
    await settle(setup);
    const after = history.controller.getSnapshot();
    expect(setup.captureCharFrame()).toContain("Choose rebase sources");
    expect(setup.captureCharFrame()).toContain("I Inspect");
    expect(after.marks).toEqual(before.marks);
    expect(after.selected).toBe(before.selected);
    expect(after.selectionAnchor).toBe(before.selectionAnchor);
    expect(after.entryScroll).toBe(before.entryScroll);
    expect(after.top).toBe(before.top);
    expect(quit).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
    await act(async () => setup.mockInput.pressKey(" "));
    await settle(setup);
    expect(history.controller.getSnapshot().marks).toHaveLength(2);
  } finally {
    await act(async () => setup.renderer.destroy());
    await history.controller.close();
  }
});

test("failed inspection preparation resumes editable source selection without clearing marks", async () => {
  const history = await createHistoryRoute(["Source A", "Inspect B"]);
  enableSourceSelectionTestMutations(history);
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={history}
      initialization={history.runtime.initialization}
      externalQuitSignal={new AbortController().signal}
      onQuit={() => {}}
      deps={{
        prepareReview: (async () => {
          throw new Error("Test inspection refused");
        }) as never,
      }}
    />,
    { width: 100, height: 24 },
  );
  try {
    await settle(setup);
    await act(async () => setup.mockInput.pressKey("R"));
    await settle(setup);
    await act(async () => setup.mockInput.pressArrow("down"));
    await settle(setup);
    await act(async () => setup.mockInput.pressKey("i"));
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Choose rebase sources");
    expect(history.controller.getSnapshot().marks).toHaveLength(1);
    await act(async () => setup.mockInput.pressKey(" "));
    await settle(setup);
    expect(history.controller.getSnapshot().marks).toHaveLength(2);
  } finally {
    await act(async () => setup.renderer.destroy());
    await history.controller.close();
  }
});

test("raw interrupt during inspection planning yields to host cancellation and awaits planning before quit", async () => {
  const history = await createHistoryRoute(["Source A", "Inspect B"]);
  enableSourceSelectionTestMutations(history);
  let resolvePlan!: (value: { kind: "revision-show"; revisionId: string }) => void;
  const planning = new Promise<{ kind: "revision-show"; revisionId: string }>((resolve) => {
    resolvePlan = resolve;
  });
  let planningSignal: AbortSignal | undefined;
  history.runtime.planReview = async (_commit, _options, signal) => {
    planningSignal = signal;
    return planning;
  };
  let interruptClaim: (() => boolean) | undefined;
  const quit = mock(() => undefined);
  const prepareReview = mock(async () => {
    throw new Error("Cancelled inspection reached preparation");
  });
  const abort = new AbortController();
  const setup = await testRender(
    <HunkSessionHost
      initialRoute={history}
      initialization={history.runtime.initialization}
      externalQuitSignal={abort.signal}
      onQuit={quit}
      claimInterrupt={(claim) => {
        interruptClaim = claim;
        return () => {
          interruptClaim = undefined;
        };
      }}
      deps={{ prepareReview: prepareReview as never }}
    />,
    { width: 100, height: 24 },
  );
  try {
    await settle(setup);
    await act(async () => setup.mockInput.pressKey("R"));
    await settle(setup);
    await act(async () => setup.mockInput.pressKey("I"));
    await settle(setup);
    expect(planningSignal).toBeDefined();
    expect(interruptClaim?.()).toBe(false);
    await act(async () => abort.abort());
    await settle(setup);
    expect(planningSignal?.aborted).toBe(true);
    expect(quit).not.toHaveBeenCalled();
    resolvePlan({ kind: "revision-show", revisionId: "revision-a" });
    await settle(setup);
    expect(prepareReview).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledTimes(1);
    expect(history.controller.getSnapshot().marks).toHaveLength(0);
  } finally {
    await act(async () => setup.renderer.destroy());
    await history.controller.close();
  }
});
