import { describe, expect, test } from "bun:test";
import { contrastRatio } from "../lib/color";
import { MIN_HIGHLIGHT_CONTRAST, resolveSpanBackgrounds, resolveSpanColors } from "./spanColors";
import { TRANSPARENT_BACKGROUND } from "../themes";

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
