import { describe, expect, test } from "bun:test";
import { TRANSPARENT_BACKGROUND } from "../themes";
import { resolveSpanBackgrounds } from "./spanColors";

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

  test("uses the retained opaque row when the emitted row is transparent", () => {
    expect(
      resolveSpanBackgrounds(
        TRANSPARENT_BACKGROUND,
        "#2e9e4859",
        TRANSPARENT_BACKGROUND,
        "#182d23",
      ),
    ).toEqual({
      emittedBackground: "#205430",
      contrastBackground: "#205430",
    });
  });

  test("preserves the existing transparent fallback without an overlay", () => {
    expect(
      resolveSpanBackgrounds(TRANSPARENT_BACKGROUND, undefined, TRANSPARENT_BACKGROUND, "#faf4ed"),
    ).toEqual({
      emittedBackground: TRANSPARENT_BACKGROUND,
      contrastBackground: "#faf4ed",
    });
  });
});
