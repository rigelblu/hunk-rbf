import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliInput } from "./types";
import { resolveConfiguredCliInput } from "./config";
import { loadAppBootstrap } from "./loaders";
import { resolveConfiguredThemeInput } from "./themePreference";

const tempDirs: string[] = [];

function cleanupTempDirs() {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function createTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createRepo(dir: string) {
  mkdirSync(join(dir, ".git"), { recursive: true });
}

function createJjRepo(dir: string) {
  mkdirSync(join(dir, ".jj"), { recursive: true });
}

function createPatchPagerInput(overrides: Partial<CliInput["options"]> = {}): CliInput {
  return {
    kind: "patch",
    file: "-",
    options: {
      pager: true,
      ...overrides,
    },
  };
}

afterEach(() => {
  cleanupTempDirs();
});

describe("config resolution", () => {
  test("merges global, repo, pager, command, and CLI overrides in the right order", () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-repo-");
    createRepo(repo);

    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      [
        'theme = "github-dark-default"',
        "line_numbers = false",
        "transparentBackground = true",
        "color_moved = true",
        "",
        "[patch]",
        'mode = "split"',
        "",
        "[pager]",
        'mode = "stack"',
      ].join("\n"),
    );

    mkdirSync(join(repo, ".hunk"), { recursive: true });
    writeFileSync(
      join(repo, ".hunk", "config.toml"),
      [
        'theme = "github-light-default"',
        "wrap_lines = true",
        "menu_bar = false",
        "",
        "[pager]",
        "hunk_headers = false",
      ].join("\n"),
    );

    const resolved = resolveConfiguredCliInput(createPatchPagerInput({ agentNotes: true }), {
      cwd: repo,
      env: { HOME: home },
    });

    expect(resolved.repoConfigPath).toBe(join(repo, ".hunk", "config.toml"));
    expect(resolved.input.options).toMatchObject({
      pager: true,
      mode: "stack",
      theme: "github-light-default",
      lineNumbers: false,
      wrapLines: true,
      menuBar: false,
      hunkHeaders: false,
      agentNotes: true,
      transparentBackground: true,
      colorMoved: true,
    });
  });

  test("merges custom theme overrides from global and repo config", () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-repo-");
    createRepo(repo);

    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      [
        'theme = "custom"',
        "",
        "[custom_theme]",
        'base = "github-dark-default"',
        'label = "Global Custom"',
        'accent = "#123456"',
        "",
        "[custom_theme.syntax]",
        'keyword = "#abcdef"',
      ].join("\n"),
    );

    mkdirSync(join(repo, ".hunk"), { recursive: true });
    writeFileSync(
      join(repo, ".hunk", "config.toml"),
      [
        'theme = "custom"',
        "",
        "[custom_theme]",
        'label = "Repo Custom"',
        'panel = "#654321"',
        "",
        "[custom_theme.syntax]",
        'string = "#fedcba"',
      ].join("\n"),
    );

    const resolved = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd: repo,
      env: { HOME: home },
    });

    expect(resolved.input.options.theme).toBe("custom");
    expect(resolved.customThemes).toEqual({
      custom: {
        base: "github-dark-default",
        label: "Repo Custom",
        accent: "#123456",
        panel: "#654321",
        syntax: {
          keyword: "#abcdef",
          string: "#fedcba",
        },
      },
    });
  });

  test("merges semantic diff colors without displacing explicit component overrides", () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-repo-");
    createRepo(repo);

    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      [
        "[custom_themes.dawn]",
        'base = "github-light-default"',
        'diffAddedColor = "#3DAA8E"',
        'removedBg = "#112233"',
      ].join("\n"),
    );

    mkdirSync(join(repo, ".hunk"), { recursive: true });
    writeFileSync(
      join(repo, ".hunk", "config.toml"),
      ["[custom_themes.dawn]", 'diffRemovedColor = "#B4647A"', 'addedBg = "#445566"'].join("\n"),
    );

    const resolved = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd: repo,
      env: { HOME: home },
    });

    expect(resolved.customThemes?.dawn).toMatchObject({
      diffAddedColor: "#3daa8e",
      diffRemovedColor: "#b4647a",
      addedBg: "#445566",
      removedBg: "#112233",
    });
  });

  test.each(["github-dark-default", "github-light-default", "dracula", "catppuccin-mocha"])(
    "accepts custom theme base id: %s",
    (base) => {
      const home = createTempDir("hunk-config-home-");
      mkdirSync(join(home, ".config", "hunk"), { recursive: true });
      writeFileSync(
        join(home, ".config", "hunk", "config.toml"),
        ["[custom_theme]", `base = "${base}"`].join("\n"),
      );

      const resolved = resolveConfiguredCliInput(createPatchPagerInput(), {
        cwd: createTempDir("hunk-config-cwd-"),
        env: { HOME: home },
      });

      expect(resolved.customThemes).toEqual({ custom: { base } });
    },
  );

  test("normalizes legacy custom theme base ids", () => {
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      ["[custom_theme]", 'base = "graphite"'].join("\n"),
    );

    const resolved = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd: createTempDir("hunk-config-cwd-"),
      env: { HOME: home },
    });

    expect(resolved.customThemes).toEqual({ custom: { base: "github-dark-default" } });
  });

  test("loads, merges, orders, and pairs named custom themes", () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-repo-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    mkdirSync(join(repo, ".hunk"), { recursive: true });
    writeFileSync(join(repo, ".git"), "gitdir: elsewhere\n");
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      [
        'theme = { light = "my-light", dark = "my-dark" }',
        "",
        "[custom_themes.my-light]",
        'base = "github-light-default"',
        'label = "My Light"',
        "",
        "[custom_themes.my-light.syntax]",
        'keyword = "#abcdef"',
        "",
        "[custom_themes.my-dark]",
        'base = "github-dark-default"',
      ].join("\n"),
    );
    writeFileSync(
      join(repo, ".hunk", "config.toml"),
      [
        "[custom_themes.my-light]",
        'accent = "#123456"',
        "",
        "[custom_themes.my-light.syntax]",
        'string = "#fedcba"',
        "",
        "[custom_themes.third-theme]",
        'base = "dracula"',
      ].join("\n"),
    );

    const resolved = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd: repo,
      env: { HOME: home },
    });

    expect(resolved.input.options.theme).toEqual({ light: "my-light", dark: "my-dark" });
    expect(Object.keys(resolved.customThemes ?? {})).toEqual([
      "my-light",
      "my-dark",
      "third-theme",
    ]);
    expect(resolved.customThemes?.["my-light"]).toEqual({
      base: "github-light-default",
      label: "My Light",
      accent: "#123456",
      syntax: { keyword: "#abcdef", string: "#fedcba" },
    });
  });

  test.each(["1bad", "Bad", "bad_name", "nord", "graphite", "system", "custom"])(
    "rejects invalid or reserved named custom theme id: %s",
    (id) => {
      const home = createTempDir("hunk-config-home-");
      mkdirSync(join(home, ".config", "hunk"), { recursive: true });
      writeFileSync(
        join(home, ".config", "hunk", "config.toml"),
        [`[custom_themes.${JSON.stringify(id)}]`, 'base = "github-dark-default"'].join("\n"),
      );

      expect(() =>
        resolveConfiguredCliInput(createPatchPagerInput(), {
          cwd: createTempDir("hunk-config-cwd-"),
          env: { HOME: home },
        }),
      ).toThrow(/custom theme id|reserved or built in/);
    },
  );

  test("supports prototype-looking ids without inheriting registry properties", () => {
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      [
        'theme = "constructor"',
        "",
        "[custom_themes.constructor]",
        'base = "github-dark-default"',
      ].join("\n"),
    );

    const resolved = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd: createTempDir("hunk-config-cwd-"),
      env: { HOME: home },
    });

    expect(Object.hasOwn(resolved.customThemes ?? {}, "constructor")).toBe(true);
    expect(resolved.customThemes?.["constructor"]).toEqual({ base: "github-dark-default" });
  });

  test("rejects dotted named custom headers instead of silently creating nested tables", () => {
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      ["[custom_themes.foo.bar]", 'base = "github-dark-default"'].join("\n"),
    );

    expect(() =>
      resolveConfiguredCliInput(createPatchPagerInput(), {
        cwd: createTempDir("hunk-config-cwd-"),
        env: { HOME: home },
      }),
    ).toThrow("Unsupported custom_themes.foo.bar.");
  });

  test("rejects invalid custom theme base ids", () => {
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      ["[custom_theme]", 'base = "unknown"'].join("\n"),
    );

    expect(() =>
      resolveConfiguredCliInput(createPatchPagerInput(), {
        cwd: createTempDir("hunk-config-cwd-"),
        env: { HOME: home },
      }),
    ).toThrow("Expected custom_theme.base to be a built-in theme id.");
  });

  test("rejects invalid custom theme color values", () => {
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      ["[custom_theme]", 'accent = "blue"'].join("\n"),
    );

    expect(() =>
      resolveConfiguredCliInput(createPatchPagerInput(), {
        cwd: createTempDir("hunk-config-cwd-"),
        env: { HOME: home },
      }),
    ).toThrow("Expected custom_theme.accent to be a hex color like #112233.");
  });

  test("rejects theme = custom when no [custom_theme] table is configured", () => {
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(join(home, ".config", "hunk", "config.toml"), 'theme = "custom"\n');

    expect(() =>
      resolveConfiguredCliInput(createPatchPagerInput(), {
        cwd: createTempDir("hunk-config-cwd-"),
        env: { HOME: home },
      }),
    ).toThrow('Expected a [custom_theme] table when config selects theme = "custom".');
  });

  test("accepts transparent background config and CLI overrides", () => {
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(join(home, ".config", "hunk", "config.toml"), "transparent_background = true\n");

    const cwd = createTempDir("hunk-config-cwd-");
    const configured = resolveConfiguredCliInput(
      {
        kind: "vcs",
        staged: false,
        options: {},
      },
      { cwd, env: { HOME: home } },
    );
    const overridden = resolveConfiguredCliInput(
      {
        kind: "vcs",
        staged: false,
        options: { transparentBackground: false },
      },
      { cwd, env: { HOME: home } },
    );

    expect(configured.input.options.transparentBackground).toBe(true);
    expect(overridden.input.options.transparentBackground).toBe(false);
  });

  test("defaults unspecified themes to github-dark-default, including piped pager-style patch input", () => {
    const home = createTempDir("hunk-config-home-");
    const cwd = createTempDir("hunk-config-cwd-");

    const resolved = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd,
      env: { HOME: home },
    });

    expect(resolved.repoConfigPath).toBeUndefined();
    expect(resolved.input.options.theme).toBe("github-dark-default");
  });

  test("parses complete pairs and replaces the whole theme value across config and CLI layers", () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-repo-");
    createRepo(repo);
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    mkdirSync(join(repo, ".hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      'theme = { light = "catppuccin-latte", dark = "nord" }\n',
    );

    const globalPair = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd: repo,
      env: { HOME: home },
    });
    expect(globalPair.input.options.theme).toEqual({
      light: "catppuccin-latte",
      dark: "nord",
    });

    writeFileSync(join(repo, ".hunk", "config.toml"), 'theme = "dracula"\n');
    const repoScalar = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd: repo,
      env: { HOME: home },
    });
    expect(repoScalar.input.options.theme).toBe("dracula");

    writeFileSync(
      join(repo, ".hunk", "config.toml"),
      'theme = { light = "github-light-default", dark = "dark-plus" }\n',
    );
    const repoPair = resolveConfiguredCliInput(createPatchPagerInput(), {
      cwd: repo,
      env: { HOME: home },
    });
    expect(repoPair.input.options.theme).toEqual({
      light: "github-light-default",
      dark: "dark-plus",
    });

    const cliScalar = resolveConfiguredCliInput(
      createPatchPagerInput({ theme: "everforest-dark" }),
      {
        cwd: repo,
        env: { HOME: home },
      },
    );
    expect(cliScalar.input.options.theme).toBe("everforest-dark");
  });

  test.each([
    ['theme = { dark = "nord" }', "theme.light"],
    ['theme = { light = "catppuccin-latte" }', "theme.dark"],
    ['theme = { light = "future-theme", dark = "nord" }', "theme.light"],
    ['theme = { light = "custom", dark = "nord" }', "theme.light"],
    ['theme = { light = "paper", dark = "nord" }', "theme.light"],
    ['theme = { mode = "system", light = "catppuccin-latte", dark = "nord" }', "theme.mode"],
  ])("rejects invalid paired theme input: %s", (config, expectedKey) => {
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(join(home, ".config", "hunk", "config.toml"), `${config}\n`);

    expect(() =>
      resolveConfiguredCliInput(createPatchPagerInput(), {
        cwd: createTempDir("hunk-config-cwd-"),
        env: { HOME: home },
      }),
    ).toThrow(expectedKey);
  });

  test("command-specific config sections also apply to show mode", () => {
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      ["[show]", 'mode = "stack"', "line_numbers = false"].join("\n"),
    );

    const resolved = resolveConfiguredCliInput(
      {
        kind: "show",
        ref: "HEAD~1",
        options: {},
      },
      { cwd: createTempDir("hunk-config-cwd-"), env: { HOME: home } },
    );

    expect(resolved.input.options.mode).toBe("stack");
    expect(resolved.input.options.lineNumbers).toBe(false);
  });

  test("defaults git diff to include untracked files and honors config plus CLI overrides", () => {
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(join(home, ".config", "hunk", "config.toml"), "exclude_untracked = true\n");

    const cwd = createTempDir("hunk-config-cwd-");
    const defaultResolved = resolveConfiguredCliInput(
      {
        kind: "vcs",
        staged: false,
        options: {},
      },
      { cwd, env: { HOME: home } },
    );
    const overriddenResolved = resolveConfiguredCliInput(
      {
        kind: "vcs",
        staged: false,
        options: { excludeUntracked: false },
      },
      { cwd, env: { HOME: home } },
    );
    const noConfigHome = createTempDir("hunk-config-home-");
    const fallbackResolved = resolveConfiguredCliInput(
      {
        kind: "vcs",
        staged: false,
        options: {},
      },
      { cwd, env: { HOME: noConfigHome } },
    );

    expect(defaultResolved.input.options.excludeUntracked).toBe(true);
    expect(overriddenResolved.input.options.excludeUntracked).toBe(false);
    expect(fallbackResolved.input.options.excludeUntracked).toBe(false);
  });

  test.each([
    {
      name: "enables watch from config",
      config: "watch = true\n",
      cliOptions: {},
      expected: true,
    },
    {
      name: "disables watch from config",
      config: "watch = false\n",
      cliOptions: {},
      expected: false,
    },
    {
      name: "defaults watch to false",
      config: "",
      cliOptions: {},
      expected: false,
    },
    {
      name: "lets CLI enable watch over config",
      config: "watch = false\n",
      cliOptions: { watch: true },
      expected: true,
    },
    {
      name: "lets CLI disable watch over config",
      config: "watch = true\n",
      cliOptions: { watch: false },
      expected: false,
    },
  ] satisfies Array<{
    name: string;
    config: string;
    cliOptions: Partial<CliInput["options"]>;
    expected: boolean;
  }>)("resolves watch: $name", ({ config, cliOptions, expected }) => {
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(join(home, ".config", "hunk", "config.toml"), config);

    const resolved = resolveConfiguredCliInput(
      {
        kind: "vcs",
        staged: false,
        options: cliOptions,
      },
      { cwd: createTempDir("hunk-config-cwd-"), env: { HOME: home } },
    );

    expect(resolved.input.options.watch).toBe(expected);
  });

  test("defaults to git VCS mode and accepts registered VCS modes from config", () => {
    const home = createTempDir("hunk-config-home-");
    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(join(home, ".config", "hunk", "config.toml"), 'vcs = "jj"\n');

    const cwd = createTempDir("hunk-config-cwd-");
    const defaultResolved = resolveConfiguredCliInput(
      {
        kind: "vcs",
        staged: false,
        options: {},
      },
      { cwd, env: { HOME: createTempDir("hunk-config-empty-home-") } },
    );
    const configuredResolved = resolveConfiguredCliInput(
      {
        kind: "vcs",
        staged: false,
        options: {},
      },
      { cwd, env: { HOME: home } },
    );

    expect(defaultResolved.input.options.vcs).toBe("git");
    expect(configuredResolved.input.options.vcs).toBe("jj");
  });

  test("auto-detects registered VCS checkouts before falling back to git mode", () => {
    const home = createTempDir("hunk-config-home-");
    const jjRepo = createTempDir("hunk-config-jj-repo-");
    const colocatedRepo = createTempDir("hunk-config-colocated-repo-");
    const gitRepo = createTempDir("hunk-config-git-repo-");
    const parentJjRepo = createTempDir("hunk-config-parent-jj-");
    const gitRepoInsideParentJj = join(parentJjRepo, "git-project");
    const plainDir = createTempDir("hunk-config-no-repo-");

    createJjRepo(jjRepo);
    createRepo(colocatedRepo);
    createJjRepo(colocatedRepo);
    createRepo(gitRepo);
    createJjRepo(parentJjRepo);
    createRepo(gitRepoInsideParentJj);

    const input = {
      kind: "vcs",
      staged: false,
      options: {},
    } satisfies CliInput;

    expect(
      resolveConfiguredCliInput(input, { cwd: jjRepo, env: { HOME: home } }).input.options.vcs,
    ).toBe("jj");
    expect(
      resolveConfiguredCliInput(input, { cwd: colocatedRepo, env: { HOME: home } }).input.options
        .vcs,
    ).toBe("jj");
    expect(
      resolveConfiguredCliInput(input, { cwd: gitRepo, env: { HOME: home } }).input.options.vcs,
    ).toBe("git");
    expect(
      resolveConfiguredCliInput(input, { cwd: gitRepoInsideParentJj, env: { HOME: home } }).input
        .options.vcs,
    ).toBe("git");
    expect(
      resolveConfiguredCliInput(input, { cwd: plainDir, env: { HOME: home } }).input.options.vcs,
    ).toBe("git");
  });

  test("explicit config overrides auto-detected jj mode", () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-jj-repo-");
    createJjRepo(repo);

    mkdirSync(join(repo, ".hunk"), { recursive: true });
    writeFileSync(join(repo, ".hunk", "config.toml"), 'vcs = "git"\n');

    const resolved = resolveConfiguredCliInput(
      {
        kind: "vcs",
        staged: false,
        options: {},
      },
      { cwd: repo, env: { HOME: home } },
    );

    expect(resolved.input.options.vcs).toBe("git");
  });

  test("loadAppBootstrap exposes resolved initial preferences to the UI", async () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-repo-");
    createRepo(repo);

    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      [
        'theme = "github-light-default"',
        "line_numbers = false",
        "wrap_lines = true",
        "menu_bar = false",
        "hunk_headers = false",
        "agent_notes = true",
        "copy_decorations = false",
      ].join("\n"),
    );

    const before = join(repo, "before.ts");
    const after = join(repo, "after.ts");
    writeFileSync(before, "export const alpha = 1;\n");
    writeFileSync(after, "export const alpha = 2;\nexport const beta = true;\n");

    const resolved = resolveConfiguredCliInput(
      {
        kind: "diff",
        left: before,
        right: after,
        options: {},
      },
      { cwd: repo, env: { HOME: home } },
    );
    const bootstrap = await loadAppBootstrap(resolveConfiguredThemeInput(resolved.input, null));

    expect(bootstrap.initialMode).toBe("auto");
    expect(bootstrap.initialTheme).toBe("github-light-default");
    expect(bootstrap.initialShowLineNumbers).toBe(false);
    expect(bootstrap.initialWrapLines).toBe(true);
    expect(bootstrap.initialShowMenuBar).toBe(false);
    expect(bootstrap.initialShowHunkHeaders).toBe(false);
    expect(bootstrap.initialShowAgentNotes).toBe(true);
    expect(bootstrap.initialCopyDecorations).toBe(false);
  });

  test("loadAppBootstrap carries the configured custom theme into the UI bootstrap", async () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-repo-");
    createRepo(repo);

    mkdirSync(join(home, ".config", "hunk"), { recursive: true });
    writeFileSync(
      join(home, ".config", "hunk", "config.toml"),
      [
        'theme = "custom"',
        "",
        "[custom_theme]",
        'base = "catppuccin-mocha"',
        'accent = "#7755aa"',
        "",
        "[custom_theme.syntax]",
        'comment = "#998877"',
      ].join("\n"),
    );

    const before = join(repo, "before.ts");
    const after = join(repo, "after.ts");
    writeFileSync(before, "export const alpha = 1;\n");
    writeFileSync(after, "export const alpha = 2;\n");

    const resolved = resolveConfiguredCliInput(
      {
        kind: "diff",
        left: before,
        right: after,
        options: {},
      },
      { cwd: repo, env: { HOME: home } },
    );
    const bootstrap = await loadAppBootstrap(resolveConfiguredThemeInput(resolved.input, null), {
      customThemes: resolved.customThemes,
    });

    expect(bootstrap.initialTheme).toBe("custom");
    expect(bootstrap.customThemes).toEqual({
      custom: {
        base: "catppuccin-mocha",
        accent: "#7755aa",
        syntax: {
          comment: "#998877",
        },
      },
    });
  });

  test("loadAppBootstrap exposes github-dark-default when no theme is configured", async () => {
    const home = createTempDir("hunk-config-home-");
    const repo = createTempDir("hunk-config-repo-");
    createRepo(repo);

    const before = join(repo, "before.ts");
    const after = join(repo, "after.ts");
    writeFileSync(before, "export const alpha = 1;\n");
    writeFileSync(after, "export const alpha = 2;\n");

    const resolved = resolveConfiguredCliInput(
      {
        kind: "diff",
        left: before,
        right: after,
        options: {},
      },
      { cwd: repo, env: { HOME: home } },
    );
    const bootstrap = await loadAppBootstrap(resolveConfiguredThemeInput(resolved.input, null));

    expect(bootstrap.initialTheme).toBe("github-dark-default");
  });
});
