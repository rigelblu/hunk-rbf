import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { SESSION_BROKER_REGISTRATION_VERSION } from "@hunk/session-broker-core";
import { removeTestDirectory } from "../../../../test/helpers/filesystem";
import type { HunkSessionBrokerClient } from "../session/broker/brokerClient";
import type {
  HunkSessionRegistration,
  HunkSessionServerMessage,
  HunkSessionSnapshot,
} from "../session/types";
import { ThemeController } from "./theme/controller";

const { getBundledVcsCatalog } = await import("../app/vcsCatalog");
const { loadAppBootstrap } = await import("../core/changeset/loaders");
const { TestAppHost: AppHost } = await import("../../../../test/helpers/app-host");

/** Stand in for the session daemon so a test can send the commands agents send. */
function createTestHostClient(options?: { replaceSessionError?: Error }) {
  type Bridge = Parameters<HunkSessionBrokerClient["setBridge"]>[0];

  let bridge: Bridge = null;
  let registration: HunkSessionRegistration = {
    registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
    sessionId: "session-1",
    pid: process.pid,
    cwd: process.cwd(),
    repoRoot: process.cwd(),
    launchedAt: "2026-03-24T00:00:00.000Z",
    info: { inputKind: "diff", title: "before.ts → after.ts", sourceLabel: "after.ts", files: [] },
  };

  return {
    hostClient: {
      getRegistration: () => registration,
      replaceSession: (nextRegistration: HunkSessionRegistration) => {
        if (options?.replaceSessionError) throw options.replaceSessionError;
        registration = nextRegistration;
      },
      subscribeConnectionNotice: () => () => undefined,
      setBridge: (nextBridge: Bridge) => {
        bridge = nextBridge;
      },
      updateSnapshot: (_snapshot: HunkSessionSnapshot) => {},
    } as unknown as HunkSessionBrokerClient,
    dispatchCommand: async (message: HunkSessionServerMessage) => {
      if (!bridge) {
        throw new Error("Expected App to register a bridge before running the test command.");
      }

      return bridge.dispatchCommand(message);
    },
  };
}

/**
 * Return the backgrounds painted behind `marked` and behind the rest of its rendered line.
 *
 * An attention mark is only visible as a background the surrounding code does not share, so
 * comparing the two is how a test sees the mark that character frames cannot show.
 */
function markedLineBackgrounds(
  frame: ReturnType<Awaited<ReturnType<typeof testRender>>["captureSpans"]>,
  lineText: string,
  marked: string,
) {
  const line = frame.lines.find((candidate) =>
    candidate.spans
      .map((span) => span.text)
      .join("")
      .includes(lineText),
  );
  const spans = line?.spans ?? [];
  const renderedText = spans.map((span) => span.text).join("");
  const markStart = renderedText.indexOf(marked, renderedText.indexOf(lineText));
  const markEnd = markStart + marked.length;

  const markedBackgrounds = new Set<string>();
  const unmarkedBackgrounds = new Set<string>();
  let offset = 0;
  for (const span of spans) {
    const spanEnd = offset + span.text.length;
    const overlapsMark = markStart >= 0 && offset < markEnd && spanEnd > markStart;
    (overlapsMark ? markedBackgrounds : unmarkedBackgrounds).add(JSON.stringify(span.bg ?? null));
    offset = spanEnd;
  }

  return { markedBackgrounds, unmarkedBackgrounds };
}

async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
}

/** Settle renders long enough for the async syntax-highlight cache to populate.
 *  Without this, the plain-text fallback path masks the stale-cache bug. */
async function settleHighlights(setup: Awaited<ReturnType<typeof testRender>>) {
  for (let i = 0; i < 15; i++) {
    await flush(setup);
    await Bun.sleep(50);
  }
}

/** Create one repository whose config and diff can be reloaded by AppHost. */
function createReloadThemeRepository() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-reload-themes-"));
  const configDir = join(dir, ".hunk");
  const configPath = join(configDir, "config.toml");
  const file = join(dir, "test.txt");
  mkdirSync(configDir);
  writeFileSync(configPath, "");
  writeFileSync(file, "original line\n");
  execSync("git init && git config user.email test@test && git config user.name test", {
    cwd: dir,
    stdio: "ignore",
  });
  execSync("git add . && git commit -m init", { cwd: dir, stdio: "ignore" });
  writeFileSync(file, "changed line\n");
  return { configPath, dir };
}

describe("reload theme catalog", () => {
  test("adopts reloaded custom themes without replacing the committed theme", async () => {
    const { configPath, dir } = createReloadThemeRepository();

    const bootstrap = await loadAppBootstrap(
      { kind: "vcs", staged: false, options: { mode: "unified", excludeUntracked: true } },
      { cwd: dir, vcsCatalog: getBundledVcsCatalog() },
    );
    const themeController = new ThemeController({
      initialTheme: "dracula",
      customThemes: [{ id: "original", accent: "#112233" }],
    });
    const setup = await testRender(
      <AppHost bootstrap={bootstrap} themeController={themeController} />,
      { width: 120, height: 20 },
    );

    try {
      await flush(setup);
      writeFileSync(configPath, '[themes.reloaded]\naccent = "#abcdef"\n');
      await act(async () => setup.mockInput.typeText("r"));

      for (let attempt = 0; attempt < 30; attempt++) {
        await flush(setup);
        if (themeController.getSnapshot().customThemes.some((theme) => theme.id === "reloaded")) {
          break;
        }
        await Bun.sleep(50);
      }

      expect(themeController.getSnapshot()).toMatchObject({
        themeId: "dracula",
        customThemes: [{ id: "reloaded", accent: "#abcdef" }],
      });
    } finally {
      await act(async () => setup.renderer.destroy());
      await removeTestDirectory(dir);
    }
  });

  test("keeps the current custom themes when reload publication fails", async () => {
    const { configPath, dir } = createReloadThemeRepository();
    const bootstrap = await loadAppBootstrap(
      { kind: "vcs", staged: false, options: { mode: "unified", excludeUntracked: true } },
      { cwd: dir, vcsCatalog: getBundledVcsCatalog() },
    );
    const themeController = new ThemeController({
      initialTheme: "dracula",
      customThemes: [{ id: "original", accent: "#112233" }],
    });
    const publicationError = new Error("publication failed");
    const { dispatchCommand, hostClient } = createTestHostClient({
      replaceSessionError: publicationError,
    });
    const setup = await testRender(
      <AppHost bootstrap={bootstrap} hostClient={hostClient} themeController={themeController} />,
      { width: 120, height: 20 },
    );

    try {
      await flush(setup);
      writeFileSync(configPath, '[themes.reloaded]\naccent = "#abcdef"\n');

      await expect(
        dispatchCommand({
          type: "command",
          requestId: "reload-theme-publication-failure",
          command: "reload_session",
          input: {
            sessionId: "session-1",
            nextInput: {
              kind: "vcs",
              staged: false,
              options: { mode: "unified", excludeUntracked: true },
            },
          },
        }),
      ).rejects.toThrow(publicationError.message);

      expect(themeController.getSnapshot()).toEqual({
        themeId: "dracula",
        customThemes: [{ id: "original", accent: "#112233" }],
      });
    } finally {
      await act(async () => setup.renderer.destroy());
      await removeTestDirectory(dir);
    }
  });
});

/** Create one refreshable review whose repository config names its theme. */
async function loadConfiguredThemeReview(themeConfig: string) {
  const { configPath, dir } = createReloadThemeRepository();
  writeFileSync(configPath, themeConfig);
  const bootstrap = await loadAppBootstrap(
    { kind: "vcs", staged: false, options: { mode: "unified", excludeUntracked: true } },
    { cwd: dir, vcsCatalog: getBundledVcsCatalog() },
  );
  return { bootstrap, configPath, dir };
}

/** Open the theme selector, wait until one theme row is active, then close the selector. */
async function expectActiveSelectorTheme(
  setup: Awaited<ReturnType<typeof testRender>>,
  themeId: string,
) {
  const isActiveRow = (line: string) =>
    line.split(/\s+/).includes(themeId) && line.includes("active");
  await act(async () => setup.mockInput.typeText("t"));
  let frame = setup.captureCharFrame();
  for (let attempt = 0; attempt < 20 && !frame.split("\n").some(isActiveRow); attempt++) {
    await flush(setup);
    await Bun.sleep(30);
    frame = setup.captureCharFrame();
  }
  expect(frame.split("\n").some(isActiveRow)).toBe(true);
  await act(async () => setup.mockInput.pressEscape());
  // Wait for the selector to close so the key parser cannot join this escape with the next key.
  for (
    let attempt = 0;
    attempt < 20 && setup.captureCharFrame().includes("Theme selector");
    attempt++
  ) {
    await flush(setup);
    await Bun.sleep(30);
  }
  expect(setup.captureCharFrame()).not.toContain("Theme selector");
}

/** Reload through the `r` refresh key and wait until the next bootstrap has mounted. */
async function reloadWithRefreshKey(
  setup: Awaited<ReturnType<typeof testRender>>,
  readActiveBootstrap: () => object,
) {
  const previous = readActiveBootstrap();
  await act(async () => setup.mockInput.typeText("r"));
  for (let attempt = 0; attempt < 40 && readActiveBootstrap() === previous; attempt++) {
    await flush(setup);
    await Bun.sleep(50);
  }
  expect(readActiveBootstrap()).not.toBe(previous);
}

describe("reload configured theme", () => {
  test("a refresh with a changed configured theme switches the review and keeps the committed theme", async () => {
    const { bootstrap, configPath, dir } = await loadConfiguredThemeReview('theme = "nord"\n');
    bootstrap.initialTheme = "nord";
    bootstrap.configuredThemePreference = "nord";
    const themeController = new ThemeController({ initialTheme: "nord" });
    let activeBootstrap = bootstrap;
    const setup = await testRender(
      <AppHost
        bootstrap={bootstrap}
        onActiveBootstrapChange={(next) => {
          activeBootstrap = next;
        }}
        themeController={themeController}
      />,
      { width: 120, height: 20 },
    );

    try {
      await flush(setup);
      await expectActiveSelectorTheme(setup, "nord");
      writeFileSync(configPath, 'theme = "dracula"\n');
      await reloadWithRefreshKey(setup, () => activeBootstrap);

      expect(activeBootstrap.configuredThemePreference).toBe("dracula");
      await expectActiveSelectorTheme(setup, "dracula");
      expect(themeController.getSnapshot().themeId).toBe("nord");
    } finally {
      await act(async () => setup.renderer.destroy());
      await removeTestDirectory(dir);
    }
  });

  test("a picked theme keeps masking a changed configured theme across a refresh", async () => {
    const { bootstrap, configPath, dir } = await loadConfiguredThemeReview('theme = "nord"\n');
    bootstrap.initialTheme = "nord";
    bootstrap.configuredThemePreference = "nord";
    const themeController = new ThemeController({ initialTheme: "nord" });
    let activeBootstrap = bootstrap;
    const setup = await testRender(
      <AppHost
        bootstrap={bootstrap}
        onActiveBootstrapChange={(next) => {
          activeBootstrap = next;
        }}
        themeController={themeController}
      />,
      { width: 120, height: 20 },
    );

    try {
      await flush(setup);
      await act(async () => themeController.commitTheme("github-dark-dimmed"));
      await expectActiveSelectorTheme(setup, "github-dark-dimmed");
      writeFileSync(configPath, 'theme = "dracula"\n');
      await reloadWithRefreshKey(setup, () => activeBootstrap);

      expect(activeBootstrap.configuredThemePreference).toBe("dracula");
      await expectActiveSelectorTheme(setup, "github-dark-dimmed");
      expect(themeController.getSnapshot().themeId).toBe("github-dark-dimmed");
    } finally {
      await act(async () => setup.renderer.destroy());
      await removeTestDirectory(dir);
    }
  });

  test("an appearance change after a refresh still switches a configured light/dark pair", async () => {
    const pair = { light: "catppuccin-latte", dark: "nord" };
    const { bootstrap, dir } = await loadConfiguredThemeReview(
      'theme = { light = "catppuccin-latte", dark = "nord" }\n',
    );
    bootstrap.initialTheme = pair.light;
    bootstrap.initialThemeMode = "light";
    bootstrap.configuredThemePreference = pair;
    let emitSystemMode: (mode: "light" | "dark") => void = () => undefined;
    let activeBootstrap = bootstrap;
    const setup = await testRender(
      <AppHost
        bootstrap={bootstrap}
        onActiveBootstrapChange={(next) => {
          activeBootstrap = next;
        }}
        systemAppearanceResolver={() => "light"}
        systemAppearanceSubscriber={(onMode) => {
          emitSystemMode = onMode;
          return { dispose: () => undefined };
        }}
      />,
      { width: 120, height: 20 },
    );

    try {
      await flush(setup);
      await expectActiveSelectorTheme(setup, pair.light);
      await reloadWithRefreshKey(setup, () => activeBootstrap);

      expect(activeBootstrap.configuredThemePreference).toEqual(pair);
      await act(async () => emitSystemMode("dark"));
      await flush(setup);
      await expectActiveSelectorTheme(setup, pair.dark);
    } finally {
      await act(async () => setup.renderer.destroy());
      await removeTestDirectory(dir);
    }
  });

  test("a refresh with no configured theme lets a theme configured later apply", async () => {
    const { bootstrap, configPath, dir } = await loadConfiguredThemeReview("");
    // Config resolution records its built-in default when no layer names a theme.
    bootstrap.configuredThemePreference = "github-dark-default";
    let activeBootstrap = bootstrap;
    const setup = await testRender(
      <AppHost
        bootstrap={bootstrap}
        onActiveBootstrapChange={(next) => {
          activeBootstrap = next;
        }}
      />,
      { width: 120, height: 20 },
    );

    try {
      await flush(setup);
      // The second refresh starts from a bootstrap that config resolution built with no theme.
      await reloadWithRefreshKey(setup, () => activeBootstrap);
      await reloadWithRefreshKey(setup, () => activeBootstrap);
      writeFileSync(configPath, 'theme = "dracula"\n');
      await reloadWithRefreshKey(setup, () => activeBootstrap);

      expect(activeBootstrap.configuredThemePreference).toBe("dracula");
      await expectActiveSelectorTheme(setup, "dracula");
    } finally {
      await act(async () => setup.renderer.destroy());
      await removeTestDirectory(dir);
    }
  });
});

describe("reload watch runtime compatibility", () => {
  test("refuses a live reload that enables watch mode under an affected Bun runtime", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunk-reload-watch-runtime-"));
    const file = join(dir, "test.txt");

    execSync("git init && git config user.email test@test && git config user.name test", {
      cwd: dir,
      stdio: "ignore",
    });
    writeFileSync(file, "original line\n");
    execSync("git add . && git commit -m init", { cwd: dir, stdio: "ignore" });
    writeFileSync(file, "original line\nfirst change\n");

    const bootstrap = await loadAppBootstrap(
      { kind: "vcs", staged: false, options: { mode: "unified", excludeUntracked: true } },
      { cwd: dir, vcsCatalog: getBundledVcsCatalog() },
    );
    const { dispatchCommand, hostClient } = createTestHostClient();
    const setup = await testRender(
      <AppHost bootstrap={bootstrap} hostClient={hostClient} bunVersion="1.3.10" />,
      { width: 120, height: 20 },
    );

    try {
      await flush(setup);

      await expect(
        dispatchCommand({
          type: "command",
          requestId: "reload-watch-runtime",
          command: "reload_session",
          input: {
            sessionId: "session-1",
            nextInput: {
              kind: "vcs",
              staged: false,
              options: { mode: "unified", excludeUntracked: true, watch: true },
            },
          },
        }),
      ).rejects.toThrow("can deadlock while closing filesystem watchers");

      await flush(setup);
      expect(setup.captureCharFrame()).toContain("first change");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
      await removeTestDirectory(dir);
    }
  });
});

describe("reload stale highlight cache", () => {
  test("r key picks up new file content for file-pair diffs", async () => {
    const dir = mkdtempSync(join(process.cwd(), ".hunk-reload-file-"));
    const left = join(dir, "before.ts");
    const right = join(dir, "after.ts");

    writeFileSync(left, "export const answer = 41;\n");
    writeFileSync(right, "export const answer = 42;\nexport const first = true;\n");

    const bootstrap = await loadAppBootstrap({
      kind: "diff",
      left,
      right,
      options: { mode: "unified" },
    });

    const setup = await testRender(<AppHost bootstrap={bootstrap} />, {
      width: 220,
      height: 20,
    });

    try {
      await settleHighlights(setup);

      let frame = setup.captureCharFrame();
      expect(frame).toContain("first");

      // Modify the right file while hunk is open
      writeFileSync(right, "export const answer = 42;\nexport const second = true;\n");

      await act(async () => {
        await setup.mockInput.typeText("r");
      });

      let refreshed = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        await flush(setup);
        frame = setup.captureCharFrame();
        if (frame.includes("second") && !frame.includes("first")) {
          refreshed = true;
          break;
        }
        await Bun.sleep(50);
      }

      expect(refreshed).toBe(true);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
      await removeTestDirectory(dir);
    }
  });

  test("r key picks up new file content for git working tree diffs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunk-reload-git-"));
    const file = join(dir, "test.txt");

    execSync("git init && git config user.email test@test && git config user.name test", {
      cwd: dir,
      stdio: "ignore",
    });
    writeFileSync(file, "original line\n");
    execSync("git add . && git commit -m init", { cwd: dir, stdio: "ignore" });

    writeFileSync(file, "original line\nfirst change\n");

    const bootstrap = await loadAppBootstrap(
      { kind: "vcs", staged: false, options: { mode: "unified", excludeUntracked: true } },
      { cwd: dir, vcsCatalog: getBundledVcsCatalog() },
    );

    const setup = await testRender(<AppHost bootstrap={bootstrap} />, {
      width: 120,
      height: 20,
    });

    try {
      await settleHighlights(setup);

      let frame = setup.captureCharFrame();
      expect(frame).toContain("first change");

      writeFileSync(file, "original line\nsecond change\n");

      await act(async () => {
        await setup.mockInput.typeText("r");
      });

      let refreshed = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        await flush(setup);
        frame = setup.captureCharFrame();
        if (frame.includes("second change") && !frame.includes("first change")) {
          refreshed = true;
          break;
        }
        await Bun.sleep(50);
      }

      expect(refreshed).toBe(true);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
      await removeTestDirectory(dir);
    }
  });
});

describe("reload agent attention marks", () => {
  test("r key keeps agent attention marks when nothing changed on disk", async () => {
    const dir = mkdtempSync(join(process.cwd(), ".hunk-reload-marks-"));
    const left = join(dir, "before.ts");
    const right = join(dir, "after.ts");

    writeFileSync(left, "export const answer = 41;\n");
    writeFileSync(right, "export const answer = 42;\n");

    const bootstrap = await loadAppBootstrap({
      kind: "diff",
      left,
      right,
      options: { mode: "unified" },
    });
    const { dispatchCommand, hostClient } = createTestHostClient();
    const setup = await testRender(<AppHost bootstrap={bootstrap} hostClient={hostClient} />, {
      width: 120,
      height: 20,
    });

    try {
      await flush(setup);

      await act(async () => {
        await dispatchCommand({
          type: "command",
          requestId: "highlight-1",
          command: "highlight",
          input: {
            sessionId: "session-1",
            filePath: "after.ts",
            side: "new",
            line: 1,
            start: 13,
            end: 19,
            tone: "current",
            reveal: true,
          },
        });
      });
      await flush(setup);
      const painted = markedLineBackgrounds(
        setup.captureSpans(),
        "export const answer = 42",
        "answer",
      );
      expect(painted.markedBackgrounds.size).toBe(1);
      expect(painted.unmarkedBackgrounds).not.toContain([...painted.markedBackgrounds][0]!);

      // Refresh with nothing changed on disk: the review is rebuilt, the marked line is not.
      await act(async () => {
        await setup.mockInput.typeText("r");
        await Bun.sleep(120);
        await setup.renderOnce();
      });
      await flush(setup);

      const repainted = markedLineBackgrounds(
        setup.captureSpans(),
        "export const answer = 42",
        "answer",
      );
      expect([...repainted.markedBackgrounds]).toEqual([...painted.markedBackgrounds]);
      expect(repainted.unmarkedBackgrounds).not.toContain([...repainted.markedBackgrounds][0]!);

      const cleared = await act(async () =>
        dispatchCommand({
          type: "command",
          requestId: "clear-1",
          command: "clear_highlights",
          input: { sessionId: "session-1" },
        }),
      );
      expect(cleared).toMatchObject({ removedCount: 1, remainingCount: 0 });
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
      await removeTestDirectory(dir);
    }
  });

  test("r key keeps marks painted on an unchanged file whose runtime id shifts", async () => {
    // VCS file ids embed the file's index in the changeset, so an unrelated file joining
    // the review gives an untouched file a brand-new runtime id. The carried mark is
    // re-keyed onto that id and must still reach paint: a paint path that trusted the
    // previous file identity instead of the re-keyed id would silently drop it here.
    const dir = mkdtempSync(join(tmpdir(), "hunk-reload-marks-shift-"));
    const alpha = join(dir, "alpha.ts");
    const bravo = join(dir, "bravo.ts");

    execSync("git init && git config user.email test@test && git config user.name test", {
      cwd: dir,
      stdio: "ignore",
    });
    writeFileSync(alpha, "export const alpha = 1;\n");
    writeFileSync(bravo, "export const bravo = 1;\n");
    execSync("git add . && git commit -m init", { cwd: dir, stdio: "ignore" });

    // Only bravo starts out changed, so it is the changeset's first (index 0) file.
    writeFileSync(bravo, "export const bravo = 2;\n");

    const bootstrap = await loadAppBootstrap(
      { kind: "vcs", staged: false, options: { mode: "unified", excludeUntracked: true } },
      { cwd: dir, vcsCatalog: getBundledVcsCatalog() },
    );
    const { dispatchCommand, hostClient } = createTestHostClient();
    const setup = await testRender(<AppHost bootstrap={bootstrap} hostClient={hostClient} />, {
      width: 120,
      height: 40,
    });

    try {
      await flush(setup);

      await act(async () => {
        await dispatchCommand({
          type: "command",
          requestId: "highlight-1",
          command: "highlight",
          input: {
            sessionId: "session-1",
            filePath: "bravo.ts",
            side: "new",
            line: 1,
            start: 13,
            end: 18,
            tone: "current",
          },
        });
      });
      await flush(setup);
      const painted = markedLineBackgrounds(
        setup.captureSpans(),
        "export const bravo = 2",
        "bravo",
      );
      expect(painted.markedBackgrounds.size).toBe(1);
      expect(painted.unmarkedBackgrounds).not.toContain([...painted.markedBackgrounds][0]!);

      // Change alpha only: after reload the changeset is [alpha, bravo], so bravo keeps
      // its content but not its runtime id.
      writeFileSync(alpha, "export const alpha = 100;\n");
      await act(async () => {
        await setup.mockInput.typeText("r");
      });

      let reloaded = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        await flush(setup);
        if (setup.captureCharFrame().includes("export const alpha = 100")) {
          reloaded = true;
          break;
        }
        await Bun.sleep(50);
      }
      expect(reloaded).toBe(true);

      const repainted = markedLineBackgrounds(
        setup.captureSpans(),
        "export const bravo = 2",
        "bravo",
      );
      expect([...repainted.markedBackgrounds]).toEqual([...painted.markedBackgrounds]);
      expect(repainted.unmarkedBackgrounds).not.toContain([...repainted.markedBackgrounds][0]!);

      // The carried mark still answers to clear, so it is live state, not a paint ghost.
      const cleared = await act(async () =>
        dispatchCommand({
          type: "command",
          requestId: "clear-2",
          command: "clear_highlights",
          input: { sessionId: "session-1" },
        }),
      );
      expect(cleared).toMatchObject({ removedCount: 1, remainingCount: 0 });
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
      await removeTestDirectory(dir);
    }
  });
});
