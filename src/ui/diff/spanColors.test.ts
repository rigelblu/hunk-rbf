import { describe, expect, test } from "bun:test";
import { contrastRatio } from "../lib/color";
import { MIN_HIGHLIGHT_CONTRAST, resolveSpanColors } from "./spanColors";

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
