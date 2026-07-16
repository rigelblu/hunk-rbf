import { describe, expect, test } from "bun:test";
import {
  isThemePairPreference,
  resolveConfiguredThemeInput,
  resolveThemePreference,
  themePreferenceFollowsAppearance,
} from "./themePreference";

describe("theme preferences", () => {
  test("resolves complete pairs from one startup classification with dark fallback", () => {
    const pair = { light: "catppuccin-latte", dark: "nord" };

    expect(isThemePairPreference(pair)).toBe(true);
    expect(themePreferenceFollowsAppearance(pair)).toBe(true);
    expect(resolveThemePreference(pair, "light")).toBe("catppuccin-latte");
    expect(resolveThemePreference(pair, "dark")).toBe("nord");
    expect(resolveThemePreference(pair, null)).toBe("nord");
  });

  test("normalizes system and auto to the built-in pair", () => {
    for (const preference of ["system", "auto"] as const) {
      expect(themePreferenceFollowsAppearance(preference)).toBe(true);
      expect(resolveThemePreference(preference, "light")).toBe("github-light-default");
      expect(resolveThemePreference(preference, "dark")).toBe("github-dark-default");
      expect(resolveThemePreference(preference, undefined)).toBe("github-dark-default");
    }
  });

  test("leaves fixed, custom, and unknown scalar requests opaque", () => {
    for (const preference of ["dracula", "custom", "future-theme"]) {
      expect(themePreferenceFollowsAppearance(preference)).toBe(false);
      expect(resolveThemePreference(preference, "light")).toBe(preference);
    }
  });

  test("reduces configured input to the scalar runtime contract", () => {
    const resolved = resolveConfiguredThemeInput(
      {
        kind: "patch",
        file: "change.patch",
        options: { theme: { light: "catppuccin-latte", dark: "nord" } },
      },
      "light",
    );

    expect(resolved.options.theme).toBe("catppuccin-latte");
  });
});
