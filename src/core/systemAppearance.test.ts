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
  test("maps exact Dark output to dark", () => {
    expect(
      resolveSystemAppearanceMode({
        platform: "darwin",
        readMacOSAppearance: () => createCommandResult(),
      }),
    ).toBe("dark");
  });

  test("maps the ordinary missing preference to light", () => {
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

  test.each([
    ["unexpected successful output", createCommandResult({ stdout: "Light\n" })],
    ["unexpected exit status", createCommandResult({ status: 2, stdout: "" })],
    ["unexpected missing-key output", createCommandResult({ status: 1, stdout: "error" })],
    [
      "stderr-only exit-one failure",
      createCommandResult({ status: 1, stderr: "defaults service unavailable\n", stdout: "" }),
    ],
    ["termination", createCommandResult({ signal: "SIGTERM", status: null, stdout: "" })],
    ["spawn error", createCommandResult({ error: new Error("spawn failed"), status: null })],
    [
      "command timeout",
      createCommandResult({
        error: Object.assign(new Error("spawnSync /usr/bin/defaults ETIMEDOUT"), {
          code: "ETIMEDOUT",
        }),
        status: null,
      }),
    ],
  ])("preserves the caller's last mode for %s", (_name, result) => {
    expect(
      resolveSystemAppearanceMode({
        platform: "darwin",
        readMacOSAppearance: () => result,
      }),
    ).toBeNull();
  });

  test("preserves the caller's last mode when the command throws", () => {
    expect(
      resolveSystemAppearanceMode({
        platform: "darwin",
        readMacOSAppearance: () => {
          throw new Error("spawn failed");
        },
      }),
    ).toBeNull();
  });

  test("never invokes the macOS resolver on other platforms", () => {
    let reads = 0;

    expect(
      resolveSystemAppearanceMode({
        platform: "linux",
        readMacOSAppearance: () => {
          reads += 1;
          return createCommandResult();
        },
      }),
    ).toBeNull();
    expect(reads).toBe(0);
  });
});

describe("subscribeToSystemAppearanceMode", () => {
  test("emits a debounced macOS preference change without polling", async () => {
    let preferenceListener: (eventType: string, filename: string | Buffer | null) => void = () =>
      undefined;
    let closeCalls = 0;
    const received: string[] = [];
    const subscription = subscribeToSystemAppearanceMode((mode) => received.push(mode), {
      debounceMs: 0,
      platform: "darwin",
      resolveAppearance: () => "dark",
      watchPreferences: (_directory, listener) => {
        preferenceListener = listener;
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

    preferenceListener("change", "unrelated.plist");
    preferenceListener("rename", ".GlobalPreferences.plist");
    preferenceListener("change", ".GlobalPreferences.plist");
    await Bun.sleep(5);

    expect(received).toEqual(["dark"]);
    subscription.dispose();
    subscription.dispose();
    expect(closeCalls).toBe(1);
  });

  test("does not watch preferences outside macOS", () => {
    let watchCalls = 0;
    const subscription = subscribeToSystemAppearanceMode(() => undefined, {
      platform: "linux",
      watchPreferences: () => {
        watchCalls += 1;
        throw new Error("must not watch");
      },
    });

    subscription.dispose();
    expect(watchCalls).toBe(0);
  });

  test("keeps the prior mode when a preference event cannot be classified", async () => {
    let preferenceListener: (eventType: string, filename: string | Buffer | null) => void = () =>
      undefined;
    let received = 0;
    subscribeToSystemAppearanceMode(
      () => {
        received += 1;
      },
      {
        debounceMs: 0,
        platform: "darwin",
        resolveAppearance: () => null,
        watchPreferences: (_directory, listener) => {
          preferenceListener = listener;
          return {
            close: () => undefined,
            on() {
              return this as never;
            },
          };
        },
      },
    );

    preferenceListener("change", ".GlobalPreferences.plist");
    await Bun.sleep(5);
    expect(received).toBe(0);
  });
});
