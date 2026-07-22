import { describe, expect, test } from "bun:test";
import {
  blendHex,
  compositeHexOverlay,
  contrastRatio,
  ensureMinimumContrast,
  relativeLuminance,
} from "./color";

describe("compositeHexOverlay", () => {
  test.each([
    ["#2e9e4859", "#dce8de", "#9fceaa"],
    ["#78081acc", "#efdddb", "#903341"],
    ["#2e9e4859", "#182d23", "#205430"],
    ["#78081acc", "#431720", "#6d0b1b"],
    ["#ff000080", "#0000ff", "#80007f"],
    ["#abcdef00", "#112233", "#112233"],
    ["#abcdefFF", "#112233", "#abcdef"],
  ])("composites %s over %s as %s", (overlay, background, expected) => {
    expect(compositeHexOverlay(overlay, background)).toBe(expected);
  });

  test("rejects invalid overlays and non-opaque backgrounds", () => {
    expect(compositeHexOverlay("#112233", "#ffffff")).toBeUndefined();
    expect(compositeHexOverlay("#11223380", "transparent")).toBeUndefined();
    expect(compositeHexOverlay("11223380", "#ffffff")).toBeUndefined();
    expect(compositeHexOverlay("#11223380", "ffffff")).toBeUndefined();
  });
});

describe("ensureMinimumContrast", () => {
  test("matches canonical WCAG luminance and contrast identities", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBe(1);
    expect(contrastRatio("#000000", "#ffffff")).toBe(21);
    expect(contrastRatio("#777777", "#777777")).toBe(1);
  });

  test("preserves passing colors byte-for-byte", () => {
    expect(ensureMinimumContrast("#575279", "#dce8de")).toBe("#575279");
    expect(ensureMinimumContrast("#E0DEF4", "#385b5e")).toBe("#E0DEF4");
  });

  test.each([
    ["#ea9d34", "#dce8de", "#8a5d1f"],
    ["#ea9d34", "#bfddd0", "#7e551c"],
    ["#ea9d34", "#903341", "#f1be79"],
    ["#6e6a86", "#385b5e", "#cbc9d3"],
  ])("adjusts %s on %s by the smallest passing one-percent blend", (fg, bg, expected) => {
    const adjusted = ensureMinimumContrast(fg, bg);

    expect(adjusted).toBe(expected);
    expect(contrastRatio(adjusted, bg)).toBeGreaterThanOrEqual(4.5);

    const previousBlack = blendHex("#000000", fg, 0.4);
    const previousWhite = blendHex("#ffffff", fg, 0.4);
    if (expected === "#8a5d1f") {
      expect(contrastRatio(previousBlack, bg)).toBeLessThan(4.5);
      expect(contrastRatio(previousWhite, bg)).toBeLessThan(4.5);
    }
  });

  test("leaves non-hex terminal colors alone", () => {
    expect(ensureMinimumContrast("default", "transparent")).toBe("default");
  });
});
