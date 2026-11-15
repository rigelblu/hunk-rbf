import { describe, expect, test } from "bun:test";
import { resolveTheme } from "../themes";
import { BUNDLED_SHIKI_THEME_IDS } from "../../core/theme/catalog";
import { setDetectedTerminalColors } from "../../core/theme/terminalColors";
import { contrastRatio } from "../lib/color";
import {
  interactiveLogUsesColor,
  monochromeLogTheme,
  resolveInteractiveLogPalette,
  resolveSquashRolePalette,
} from "./colorPolicy";

describe("interactive log color policy", () => {
  test("honors explicit color precedence and terminal conventions", () => {
    expect(interactiveLogUsesColor("always", { NO_COLOR: "", TERM: "dumb" })).toBe(true);
    expect(interactiveLogUsesColor("never", {})).toBe(false);
    expect(interactiveLogUsesColor("auto", { NO_COLOR: "" })).toBe(false);
    expect(interactiveLogUsesColor("auto", { TERM: "dumb" })).toBe(false);
    expect(interactiveLogUsesColor("auto", { TERM: "xterm-256color" })).toBe(true);
  });

  test("maps history roles onto the active semantic theme", () => {
    const selected = resolveTheme("github-dark-default", null);
    const palette = resolveInteractiveLogPalette(selected);
    expect(palette).toEqual({
      timeline: selected.noteBorder,
      dayHeading: selected.fileRenamed,
      author: selected.addedSignColor,
      separator: selected.lineNumberFg,
      relativeTime: selected.muted,
      decoration: selected.addedSignColor,
      commitId: selected.fileRenamed,
      copyAction: selected.copyAction,
      graphLanes: [
        selected.accent,
        selected.addedSignColor,
        selected.removedSignColor,
        selected.fileRenamed,
        selected.noteBorder,
      ],
    });
    expect(selected.copyAction).toBe(selected.lineNumberFg);
    expect(palette.decoration).not.toBe(palette.commitId);
    expect(new Set(Object.values(palette).flat()).size).toBeGreaterThanOrEqual(5);
  });

  test("does not expose selected theme colors when color is disabled", () => {
    const selected = resolveTheme("github-dark-default", null);
    const neutral = monochromeLogTheme(selected, "dark");
    const palette = resolveInteractiveLogPalette(neutral);
    expect(neutral.id).toBe("terminal-monochrome");
    expect(neutral.background).toBe("#000000");
    expect(neutral.selectedHunk).toBe("#404040");
    expect(new Set(Object.values(palette).flat())).toEqual(new Set(["#ffffff"]));
    expect(new Set(Object.values(neutral.syntaxColors))).toEqual(new Set(["#ffffff"]));
    expect(neutral.syntaxScopeOverrides).toBeUndefined();
  });
});

test("Squash role words retain readable text without fills on every built-in normal/focused row", () => {
  for (const id of BUNDLED_SHIKI_THEME_IDS) {
    const theme = resolveTheme(id, null);
    for (const row of [theme.background, theme.selectedHunk]) {
      for (const role of ["from", "into"] as const) {
        const palette = resolveSquashRolePalette(theme, role, row);
        expect(contrastRatio(palette.fg, row)).toBeGreaterThanOrEqual(4.5);
        expect(palette.bg).toBeUndefined();
        expect(resolveSquashRolePalette(theme, role, row, false)).toEqual({ fg: theme.text });
      }
    }
  }
});

test("Squash uses reported terminal role colors and repairs an accent that matches the row", () => {
  const colors = Array<string | undefined>(16);
  colors[3] = "#f0cf80";
  colors[6] = "#88c0d0";
  setDetectedTerminalColors({ background: "#2e3440", foreground: "#d8dee9", palette: colors });
  try {
    const theme = resolveTheme("terminal", "dark");
    expect(resolveSquashRolePalette(theme, "from", theme.background).fg).toBe(colors[3]);
    expect(resolveSquashRolePalette(theme, "into", theme.background).fg).toBe(colors[6]);
    const colliding = { ...theme, id: "custom", accent: theme.selectedHunk };
    const palette = resolveSquashRolePalette(colliding, "from", theme.selectedHunk);
    expect(contrastRatio(palette.fg, theme.selectedHunk)).toBeGreaterThanOrEqual(4.5);
    expect(palette.bg).toBeUndefined();
  } finally {
    setDetectedTerminalColors(undefined);
  }
});

test("named and custom themes keep Squash colors independent of terminal detection", () => {
  const named = resolveTheme("nord", "dark");
  const custom = { ...named, id: "custom", accent: "#eab676" };
  try {
    for (const theme of [named, custom]) {
      setDetectedTerminalColors(undefined);
      const before = ["from", "into"].map((role) =>
        resolveSquashRolePalette(theme, role as "from" | "into", theme.background),
      );
      for (const cyan of ["#88c0d0", "#ff00ff"]) {
        const palette = Array<string | undefined>(16);
        palette[3] = "#f0cf80";
        palette[6] = cyan;
        setDetectedTerminalColors({ background: "#2e3440", foreground: "#d8dee9", palette });
        expect(
          ["from", "into"].map((role) =>
            resolveSquashRolePalette(theme, role as "from" | "into", theme.background),
          ),
        ).toEqual(before);
      }
    }
  } finally {
    setDetectedTerminalColors(undefined);
  }
});

test("terminal Squash badges follow newly reported role colors", () => {
  try {
    const palettes = [];
    for (const cyan of ["#88c0d0", "#ff00ff"]) {
      const palette = Array<string | undefined>(16);
      palette[6] = cyan;
      setDetectedTerminalColors({ background: "#2e3440", foreground: "#d8dee9", palette });
      const theme = resolveTheme("terminal", "dark");
      const badge = resolveSquashRolePalette(theme, "into", theme.background);
      expect(contrastRatio(badge.fg, theme.background)).toBeGreaterThanOrEqual(4.5);
      palettes.push(badge);
    }
    expect(palettes[0]).not.toEqual(palettes[1]);
  } finally {
    setDetectedTerminalColors(undefined);
  }
});
