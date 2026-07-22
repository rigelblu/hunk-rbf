import { describe, expect, test } from "bun:test";
import { createTestCustomThemes } from "../../../../../test/helpers/theme-helpers";
import { contrastRatio } from "../lib/color";
import { monochromeLogTheme } from "../log/colorPolicy";
import { applyLineHighlightsToSpans } from "./lineHighlightPaint";
import { MIN_HIGHLIGHT_CONTRAST, resolveSpanBackgrounds, resolveSpanColors } from "./spanColors";
import { resolveTheme, TRANSPARENT_BACKGROUND } from "../themes";

describe("resolveSpanBackgrounds", () => {
  test.each([
    ["#2e9e4859", "#dce8de", "#9fceaa"],
    ["#78081acc", "#efdddb", "#903341"],
    ["#2e9e4859", "#182d23", "#205430"],
    ["#78081acc", "#431720", "#6d0b1b"],
  ])("resolves %s over the actual row %s", (overlay, row, expected) => {
    expect(resolveSpanBackgrounds("#000000", overlay, row, row)).toEqual({
      emittedBackground: expected,
      contrastBackground: expected,
    });
  });

  test("uses the retained opaque row when emitted surfaces are transparent", () => {
    expect(
      resolveSpanBackgrounds(
        TRANSPARENT_BACKGROUND,
        "#2e9e4859",
        TRANSPARENT_BACKGROUND,
        "#182d23",
      ),
    ).toEqual({ emittedBackground: "#205430", contrastBackground: "#205430" });
  });
});

describe("alpha word overlays under upstream paint policies", () => {
  test("an extension mark's background replaces a word overlay, and a dim mark keeps it", () => {
    const row = "#182d23";
    const word = { text: "abcdefgh", fg: "#e0def4", bg: "#1d3e29", bgOverlay: "#2e9e4859" };
    const painted = applyLineHighlightsToSpans(
      [word],
      [
        { startCol: 0, endCol: 2, tone: "match" },
        { startCol: 2, endCol: 4, tone: "current" },
        { startCol: 4, endCol: 6, tone: "dim" },
      ],
      (tone) =>
        tone === "match"
          ? { bg: "#445566" }
          : tone === "current"
            ? { bg: "#e0def4", fg: "#191724" }
            : { transformFg: (sourceFg) => sourceFg ?? "#e0def4" },
    );

    expect(
      painted.map((span) => [
        span.text,
        resolveSpanBackgrounds(span.bg, span.bgOverlay, row, row).emittedBackground,
      ]),
    ).toEqual([
      ["ab", "#445566"],
      ["cd", "#e0def4"],
      // #2e9e4859 over #182d23 at alpha 89/255 is 0x20, 0x54, 0x30 per channel.
      ["ef", "#205430"],
      ["gh", "#205430"],
    ]);
  });

  test("monochrome history drops a custom theme's alpha word overlays", () => {
    const alpha = resolveTheme(
      "alpha",
      null,
      createTestCustomThemes(
        { base: "github-dark-default", addedContentBg: "#2e9e4859", removedContentBg: "#78081acc" },
        "alpha",
      ),
    );
    const neutral = monochromeLogTheme(alpha, "dark");

    expect(alpha.addedContentOverlay).toBe("#2e9e4859");
    expect(neutral.addedContentOverlay).toBeUndefined();
    expect(neutral.removedContentOverlay).toBeUndefined();
    // A kept #2e9e4859 overlay would paint the changed word #103719 over the black row.
    expect(
      resolveSpanBackgrounds(
        neutral.addedContentBg,
        neutral.addedContentOverlay,
        neutral.addedBg,
        neutral.addedBg,
      ).emittedBackground,
    ).toBe("#000000");
  });
});

describe("resolveSpanColors", () => {
  test("adjusts only the foreground against the retained opaque surface", () => {
    const resolved = resolveSpanColors("#777777", "transparent", "#888888");

    expect(resolved.emittedBackground).toBe("transparent");
    expect(resolved.contrastBackground).toBe("#888888");
    expect(contrastRatio(resolved.foreground, resolved.contrastBackground)).toBeGreaterThanOrEqual(
      MIN_HIGHLIGHT_CONTRAST,
    );
  });

  test("preserves a foreground that already meets the target", () => {
    expect(resolveSpanColors("#ffffff", "#000000", "#000000").foreground).toBe("#ffffff");
  });
});
