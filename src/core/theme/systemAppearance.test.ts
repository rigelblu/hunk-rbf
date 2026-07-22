import { describe, expect, test } from "bun:test";
import {
  resolveSystemAppearanceMode,
  subscribeToSystemAppearanceMode,
  type SystemAppearanceCommandResult,
} from "./systemAppearance";

/** Build one deterministic macOS preference-command result. */
function createCommandResult(
  overrides: Partial<SystemAppearanceCommandResult> = {},
): SystemAppearanceCommandResult {
  return {
    signal: null,
    status: 0,
    stderr: "",
    stdout: "Dark\n",
    ...overrides,
  };
}

describe("resolveSystemAppearanceMode", () => {
  test("maps the macOS Dark and omitted Light preferences", () => {
    expect(
      resolveSystemAppearanceMode({
        platform: "darwin",
        readMacOSAppearance: () => createCommandResult(),
      }),
    ).toBe("dark");
    expect(
      resolveSystemAppearanceMode({
        platform: "darwin",
        readMacOSAppearance: () =>
          createCommandResult({
            status: 1,
            stderr:
              "The domain/default pair of (kCFPreferencesAnyApplication, AppleInterfaceStyle) does not exist\n",
            stdout: "",
          }),
      }),
    ).toBe("light");
  });

  test("returns no authority for non-macOS or unclassified results", () => {
    expect(resolveSystemAppearanceMode({ platform: "linux" })).toBeNull();
    expect(
      resolveSystemAppearanceMode({
        platform: "darwin",
        readMacOSAppearance: () => createCommandResult({ status: 2, stdout: "" }),
      }),
    ).toBeNull();
  });
});

describe("subscribeToSystemAppearanceMode", () => {
  test("emits one debounced global-preference change", async () => {
    let listener: (eventType: string, filename: string | Buffer | null) => void = () => undefined;
    let closeCalls = 0;
    const received: string[] = [];
    const subscription = subscribeToSystemAppearanceMode((mode) => received.push(mode), {
      debounceMs: 0,
      platform: "darwin",
      resolveAppearance: () => "dark",
      watchPreferences: (_directory, nextListener) => {
        listener = nextListener;
        return {
          close: () => {
            closeCalls += 1;
          },
          on() {
            return this as never;
          },
        };
      },
    });

    listener("change", "unrelated.plist");
    listener("change", ".GlobalPreferences.plist");
    listener("rename", ".GlobalPreferences.plist");
    await Bun.sleep(5);

    expect(received).toEqual(["dark"]);
    subscription.dispose();
    subscription.dispose();
    expect(closeCalls).toBe(1);
  });
});
