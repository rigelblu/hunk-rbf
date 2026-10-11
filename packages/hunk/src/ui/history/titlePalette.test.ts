import { afterEach, describe, expect, test } from "bun:test";
import { BUNDLED_SHIKI_THEME_IDS } from "../../core/theme/catalog";
import { setDetectedTerminalColors } from "../../core/theme/terminalColors";
import { contrastRatio } from "../lib/color";
import { monochromeLogTheme } from "../log/colorPolicy";
import { resolveTheme } from "../themes";
import { formatHistoryTitle, splitHistoryTitle } from "./title";
import { resolveHistoryTitlePalette } from "./titlePalette";

afterEach(() => setDetectedTerminalColors(undefined));

describe("history label colors", () => {
  test("keeps all fitted text intact and marks only the generated prefix and exact placeholder", () => {
    for (const subject of [
      "(no description set)",
      "Title (empty) (no description set)",
      "日本語 title",
    ]) {
      for (const isEmpty of [true, false, undefined]) {
        for (let width = 0; width < 55; width += 1) {
          const commit = { subject, isEmpty };
          const title = formatHistoryTitle(commit, width, "…");
          const spans = splitHistoryTitle(commit, title);
          expect(spans.map((span) => span.text).join("")).toBe(title);
          expect(spans.some((span) => span.role === "empty")).toBe(isEmpty === true);
          if (subject !== "(no description set)") {
            expect(spans.some((span) => span.role === "undescribed")).toBe(false);
          }
        }
      }
    }
    expect(
      splitHistoryTitle(
        { subject: "(no description set)", isEmpty: true },
        "(empty) (no description set)",
      ),
    ).toEqual([
      { text: "(empty)", role: "empty" },
      { text: " ", role: "text" },
      { text: "(no description set)", role: "undescribed" },
    ]);
  });

  test("keeps labels readable and equally yellow on all built-in normal and selected backgrounds", () => {
    for (const id of BUNDLED_SHIKI_THEME_IDS) {
      const theme = resolveTheme(id, null);
      for (const background of [theme.background, theme.selectedHunk]) {
        const palette = resolveHistoryTitlePalette(theme, background);
        expect(contrastRatio(palette.empty, background)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(palette.undescribed, background)).toBeGreaterThanOrEqual(4.5);
        expect(palette.empty).toBe(palette.undescribed);
        expect(palette.text).toBe(theme.text);
      }
    }
  });

  test("uses the detected terminal yellow slot and suppresses them in monochrome", () => {
    const palette = Array<string | undefined>(16);
    palette[2] = "#55dd77";
    palette[3] = "#ffdd55";
    setDetectedTerminalColors({ background: "#000000", foreground: "#ffffff", palette });
    const theme = resolveTheme("terminal", "dark");
    expect(resolveHistoryTitlePalette(theme)).toEqual({
      empty: "#ffdd55",
      undescribed: "#ffdd55",
      text: theme.text,
    });
    for (const mode of ["dark", "light"] as const) {
      const mono = monochromeLogTheme(theme, mode);
      expect(
        new Set(Object.values(resolveHistoryTitlePalette(mono, mono.background, false))),
      ).toEqual(new Set([mono.text]));
    }
  });

  test("does not mistake a named custom theme for the color-disabled state", () => {
    const theme = resolveTheme("terminal-monochrome", "dark", [
      {
        id: "terminal-monochrome",
        label: "My named theme",
        base: "github-dark-default",
        text: "#ffffff",
        background: "#000000",
      },
    ]);
    const palette = resolveHistoryTitlePalette(theme);
    expect(palette.empty).not.toBe(theme.text);
    expect(palette.undescribed).not.toBe(theme.text);
    expect(palette.empty).toBe(palette.undescribed);
    expect(
      new Set(Object.values(resolveHistoryTitlePalette(theme, theme.background, false))),
    ).toEqual(new Set([theme.text]));
  });
});
