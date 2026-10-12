import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryCommandInput } from "../core/run/commandInputs";
import type { VcsAdapter, VcsCatalog, VcsHistorySource } from "../core/vcs/types";
import { loadHistoryBootstrap } from "./historyBootstrap";
import { getBundledVcsCatalog } from "./vcsCatalog";

const input: HistoryCommandInput = {
  kind: "history",
  color: "never",
  format: "compact",
  ascii: false,
  static: false,
  vcs: "test",
  extensionsEnabled: false,
  extensionPaths: [],
};

describe("history bootstrap cursor ownership", () => {
  test("cancels refresh before opening and closes each active provider cursor once", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "hunk-history-bootstrap-"));
    const configHome = mkdtempSync(join(tmpdir(), "hunk-history-config-"));
    const configPath = join(configHome, "hunk", "config.toml");
    mkdirSync(join(configHome, "hunk"), { recursive: true });
    writeFileSync(
      configPath,
      'theme = "github-dark-dimmed"\nline_numbers = false\nhistory_auto_refresh = true\nprompt_save_view_preferences = false\n\n[keybindings]\n"hunk.history.nextCommit" = "ctrl+n"\n',
    );
    const closeCounts: number[] = [];
    let opens = 0;
    const makeSource = (): VcsHistorySource => {
      const index = opens++;
      closeCounts[index] = 0;
      return {
        async read() {
          return { commits: [], done: true };
        },
        async close() {
          closeCounts[index]! += 1;
        },
      };
    };
    const adapter: VcsAdapter = {
      id: "test",
      name: "Test",
      detect: () => ({ id: "test", repoRoot: cwd }),
      operations: {},
      history: {
        async open() {
          return makeSource();
        },
        async planReview(commit) {
          return { kind: "revision-show", revisionId: commit.revisionId };
        },
      },
    };
    const catalog: VcsCatalog = {
      adapters: [adapter],
      defaultAdapterId: "test",
      reservedIds: new Set(["test"]),
    };

    try {
      const bootstrap = await loadHistoryBootstrap({
        input,
        cwd,
        env: { ...process.env, XDG_CONFIG_HOME: configHome },
        baseVcsCatalog: catalog,
      });
      expect(bootstrap.input.theme).toBe("github-dark-dimmed");
      expect(bootstrap.customThemes).toEqual([]);
      expect(bootstrap.initialization).toEqual({
        theme: {
          initialTheme: "github-dark-dimmed",
          customThemes: [],
        },
        viewPreferences: bootstrap.initialViewPreferences,
        historyAutoRefreshEnabled: true,
      });
      expect(bootstrap.initialViewPreferences).toMatchObject({
        theme: "github-dark-dimmed",
        showLineNumbers: false,
      });
      expect(bootstrap.keybindings).toEqual({ "hunk.history.nextCommit": "ctrl+n" });
      expect(bootstrap.viewPreferencesConfigPath).toBe(configPath);
      expect(bootstrap.promptSaveViewPreferences).toBe(false);

      const cancelled = new AbortController();
      cancelled.abort();
      await expect(bootstrap.reopenSource(cancelled.signal)).rejects.toThrow();
      expect(opens).toBe(1);

      const replacement = await bootstrap.reopenSource();
      expect(opens).toBe(2);
      expect(closeCounts).toEqual([0, 0]);
      await bootstrap.acceptSource(replacement);
      expect(closeCounts).toEqual([1, 0]);
      await bootstrap.close();
      await bootstrap.close();
      expect(closeCounts).toEqual([1, 1]);
      expect(bootstrap.extensionSession.current.registry.eventBusPhase).toBe("ready");
      await bootstrap.extensionSession.shutdown();
      await bootstrap.extensionSession.shutdown();
      expect(bootstrap.extensionSession.current.registry.eventBusPhase).toBe("closed");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(configHome, { recursive: true, force: true });
    }
  });
});

describe("history bootstrap query replacement", () => {
  /** Build a provider that records the input every open and watch call receives. */
  function createQueryAdapter(cwd: string, acceptsExpression: boolean) {
    const calls = {
      open: [] as unknown[],
      closed: [] as string[],
      signature: [] as unknown[],
      plan: [] as unknown[],
    };
    let serial = 0;
    const adapter: VcsAdapter = {
      id: "test",
      name: "Test",
      detect: () => ({ id: "test", repoRoot: cwd }),
      operations: {},
      history: {
        ...(acceptsExpression && { acceptsExpression: true as const }),
        async open(historyInput) {
          calls.open.push(historyInput);
          const label = `source-${++serial}`;
          return {
            async read() {
              return { commits: [], done: true };
            },
            async close() {
              calls.closed.push(label);
            },
          } satisfies VcsHistorySource;
        },
        async planReview(commit) {
          return { kind: "revision-show", revisionId: commit.revisionId };
        },
        watchSignature(historyInput) {
          calls.signature.push(historyInput);
          return "signature";
        },
        watchPlan(historyInput) {
          calls.plan.push(historyInput);
          return {
            coverage: "poll-only",
            targets: [],
            // Distinguishes the plan built for each accepted query.
            ...(historyInput.kind === "expression" ? { pollIntervalMs: 1234 } : {}),
          } as never;
        },
      },
    };
    const catalog: VcsCatalog = {
      adapters: [adapter],
      defaultAdapterId: "test",
      reservedIds: new Set(["test"]),
    };
    return { adapter, catalog, calls };
  }

  async function load(acceptsExpression: boolean, historyInput = input) {
    const cwd = mkdtempSync(join(tmpdir(), "hunk-history-query-"));
    const configHome = mkdtempSync(join(tmpdir(), "hunk-history-query-config-"));
    const fixture = createQueryAdapter(cwd, acceptsExpression);
    const bootstrap = await loadHistoryBootstrap({
      input: historyInput,
      cwd,
      env: { ...process.env, XDG_CONFIG_HOME: configHome },
      baseVcsCatalog: fixture.catalog,
    });
    return {
      ...fixture,
      bootstrap,
      cleanup: async () => {
        await bootstrap.close();
        await bootstrap.extensionSession.shutdown();
        rmSync(cwd, { recursive: true, force: true });
        rmSync(configHome, { recursive: true, force: true });
      },
    };
  }

  test("offers query replacement only for a provider that accepts expressions", async () => {
    const without = await load(false);
    const withFlag = await load(true);
    try {
      expect(without.bootstrap.queryReplacement).toBeUndefined();
      expect(withFlag.bootstrap.queryReplacement).toBeDefined();
    } finally {
      await without.cleanup();
      await withFlag.cleanup();
    }
  });

  test("accepting an expression moves refresh, watch signature and watch plan to it together", async () => {
    const { bootstrap, calls, cleanup } = await load(true, { ...input, maxCount: 7 });
    try {
      const replacement = bootstrap.queryReplacement!;
      const target = { kind: "expression", expression: "@-", maxCount: 7 } as const;
      expect(bootstrap.historyWatchPlan).toEqual({ coverage: "poll-only", targets: [] });

      // Opening a candidate changes nothing the session reads.
      const candidate = await replacement.open(target);
      expect(calls.open.at(-1)).toEqual({ kind: "expression", expression: "@-", maxCount: 7 });
      await bootstrap.reopenSource();
      expect(calls.open.at(-1)).toEqual({ maxCount: 7 });
      await bootstrap.historyWatchSignature!();
      expect(calls.signature.at(-1)).toEqual({ maxCount: 7 });

      await replacement.accept(target, candidate);
      await bootstrap.reopenSource();
      expect(calls.open.at(-1)).toEqual({ kind: "expression", expression: "@-", maxCount: 7 });
      await bootstrap.historyWatchSignature!();
      expect(calls.signature.at(-1)).toEqual({ kind: "expression", expression: "@-", maxCount: 7 });
      expect(bootstrap.historyWatchPlan).toMatchObject({ pollIntervalMs: 1234 });
      // The launch source closed when the candidate was accepted.
      expect(calls.closed).toEqual(["source-1"]);
    } finally {
      await cleanup();
    }
  });

  test("a launch target restores the launch input for refresh and watch", async () => {
    const { bootstrap, calls, cleanup } = await load(true);
    try {
      const replacement = bootstrap.queryReplacement!;
      const custom = { kind: "expression", expression: "@-" } as const;
      await replacement.accept(custom, await replacement.open(custom));
      const launch = await replacement.open({ kind: "launch" });
      expect(calls.open.at(-1)).toEqual({});
      await replacement.accept({ kind: "launch" }, launch);
      await bootstrap.reopenSource();
      expect(calls.open.at(-1)).toEqual({});
      await bootstrap.historyWatchSignature!();
      expect(calls.signature.at(-1)).toEqual({});
      expect(bootstrap.historyWatchPlan).toEqual({ coverage: "poll-only", targets: [] });
    } finally {
      await cleanup();
    }
  });

  test("closes a candidate that arrives after the session closed", async () => {
    const { bootstrap, calls, cleanup } = await load(true);
    try {
      const replacement = bootstrap.queryReplacement!;
      const custom = { kind: "expression", expression: "@-" } as const;
      const candidate = await replacement.open(custom);
      await bootstrap.close();
      await expect(replacement.accept(custom, candidate)).rejects.toThrow("closed");
      expect(calls.closed).toContain("source-2");
    } finally {
      await cleanup();
    }
  });
});

describe("bundled providers and query replacement", () => {
  const jjTest = Bun.which("jj") ? test : test.skip;

  jjTest("the bundled Jujutsu provider takes part in query replacement", async () => {
    const repo = mkdtempSync(join(tmpdir(), "hunk-history-jj-"));
    const configHome = mkdtempSync(join(tmpdir(), "hunk-history-jj-config-"));
    try {
      const init = Bun.spawnSync(["jj", "git", "init", "--no-colocate", repo], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(init.exitCode).toBe(0);
      const bootstrap = await loadHistoryBootstrap({
        input: { ...input, vcs: "jj", extensionsEnabled: true },
        cwd: repo,
        env: { ...process.env, XDG_CONFIG_HOME: configHome },
        baseVcsCatalog: getBundledVcsCatalog(),
      });
      try {
        expect(bootstrap.providerId).toBe("jj");
        const replacement = bootstrap.queryReplacement;
        expect(replacement).toBeDefined();
        const target = { kind: "expression", expression: "none()" } as const;
        const candidate = await replacement!.open(target);
        expect(candidate.expression).toBe("none()");
        expect(candidate.scope).toBeUndefined();
        expect(await candidate.read({ limit: 5 })).toEqual({ commits: [], done: true });
        await replacement!.accept(target, candidate);
        expect(typeof bootstrap.historyWatchSignature).toBe("function");
      } finally {
        await bootstrap.close();
        await bootstrap.extensionSession.shutdown();
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(configHome, { recursive: true, force: true });
    }
  });

  test("the bundled Git provider does not offer it", () => {
    const git = getBundledVcsCatalog().adapters.find((adapter) => adapter.id === "git");
    expect(git?.history).toBeDefined();
    expect(git?.history?.acceptsExpression).toBeUndefined();
  });
});

describe("history theme configuration scope", () => {
  for (const scenario of [
    { name: "user root", user: 'theme = "nord"', repo: "", cli: undefined, expected: "nord" },
    {
      name: "repository root",
      user: 'theme = "nord"',
      repo: 'theme = "dracula"',
      cli: undefined,
      expected: "dracula",
    },
    {
      name: "explicit CLI",
      user: 'theme = "nord"',
      repo: 'theme = "dracula"',
      cli: "one-dark-pro",
      expected: "one-dark-pro",
    },
    {
      name: "complete pair",
      user: 'theme = { light = "github-light", dark = "nord" }',
      repo: "",
      cli: undefined,
      expected: "nord",
    },
    { name: "default", user: "", repo: "", cli: undefined, expected: "github-dark-default" },
  ]) {
    test(`ignores show overrides while preserving ${scenario.name}`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), "hunk-history-theme-repo-"));
      const configHome = mkdtempSync(join(tmpdir(), "hunk-history-theme-config-"));
      mkdirSync(join(configHome, "hunk"), { recursive: true });
      writeFileSync(
        join(configHome, "hunk", "config.toml"),
        `${scenario.user}\n[show]\ntheme = "github-dark-dimmed"\n`,
      );
      mkdirSync(join(cwd, ".hunk"), { recursive: true });
      writeFileSync(
        join(cwd, ".hunk", "config.toml"),
        `${scenario.repo}\n[show]\ntheme = "github-dark-dimmed"\n`,
      );
      const catalog: VcsCatalog = {
        defaultAdapterId: "test",
        reservedIds: new Set(["test"]),
        adapters: [
          {
            id: "test",
            name: "Test",
            detect: () => ({ id: "test", repoRoot: cwd }),
            operations: {},
            history: {
              async open() {
                return {
                  async read() {
                    return { commits: [], done: true };
                  },
                  async close() {},
                };
              },
              async planReview(commit) {
                return { kind: "revision-show", revisionId: commit.revisionId };
              },
            },
          },
        ],
      };
      try {
        const bootstrap = await loadHistoryBootstrap({
          input: { ...input, theme: scenario.cli },
          cwd,
          env: { XDG_CONFIG_HOME: configHome },
          baseVcsCatalog: catalog,
        });
        try {
          expect(bootstrap.input.theme).toBe(scenario.expected);
          expect(bootstrap.initialization.theme.initialTheme).toBe(scenario.expected);
          expect(bootstrap.initialViewPreferences.theme).toBe(scenario.expected);
        } finally {
          await bootstrap.close();
          await bootstrap.extensionSession.shutdown();
        }
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(configHome, { recursive: true, force: true });
      }
    });
  }
});
