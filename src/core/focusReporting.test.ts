import { describe, expect, test } from "bun:test";
import {
  installTerminalFocusReporting,
  resumeTerminalSession,
  suspendTerminalSession,
} from "./focusReporting";

describe("installTerminalFocusReporting", () => {
  test("balances focus reporting across install, suspend, resume, and dispose", () => {
    const writes: string[] = [];
    const renderer = {
      resume: () => undefined,
      suspend: () => undefined,
    };
    const support = installTerminalFocusReporting(renderer, {
      write: (sequence) => {
        writes.push(String(sequence));
        return true;
      },
    });

    expect(writes).toEqual(["\x1b[?1004h"]);

    support.enable();
    support.disable();
    support.disable();
    support.enable();
    support.dispose();
    support.enable();

    expect(writes).toEqual(["\x1b[?1004h", "\x1b[?1004l", "\x1b[?1004h", "\x1b[?1004l"]);
  });

  test("does not let terminal write failures escape", () => {
    const renderer = {
      resume: () => undefined,
      suspend: () => undefined,
    };
    expect(() =>
      installTerminalFocusReporting(renderer, {
        write: () => {
          throw new Error("terminal closed");
        },
      }).dispose(),
    ).not.toThrow();
  });

  test("balances every shared terminal suspend and resume", () => {
    const events: string[] = [];
    const renderer = {
      resume: () => events.push("renderer-resume"),
      suspend: () => events.push("renderer-suspend"),
    };
    const support = installTerminalFocusReporting(renderer, {
      write: (sequence) => {
        events.push(sequence === "\x1b[?1004h" ? "focus-enable" : "focus-disable");
        return true;
      },
    });

    suspendTerminalSession(renderer);
    resumeTerminalSession(renderer);
    support.dispose();

    expect(events).toEqual([
      "focus-enable",
      "focus-disable",
      "renderer-suspend",
      "renderer-resume",
      "focus-enable",
      "focus-disable",
    ]);
  });

  test("rejects duplicate ownership and keeps stale disposal from evicting a replacement", () => {
    const renderer = {
      resume: () => undefined,
      suspend: () => undefined,
    };
    const writes: string[] = [];
    let replaceDuringDispose = false;
    let firstSupport: ReturnType<typeof installTerminalFocusReporting>;
    let replacementSupport: ReturnType<typeof installTerminalFocusReporting> | undefined;
    const output = {
      write: (sequence: string | Uint8Array) => {
        writes.push(String(sequence));
        if (replaceDuringDispose && sequence === "\x1b[?1004l") {
          replaceDuringDispose = false;
          // Re-entering disposal releases the old registry entry while the outer call unwinds.
          firstSupport.dispose();
          replacementSupport = installTerminalFocusReporting(renderer, output);
        }
        return true;
      },
    };
    firstSupport = installTerminalFocusReporting(renderer, output);

    expect(() => installTerminalFocusReporting(renderer, output)).toThrow(
      "Terminal focus reporting is already installed for this renderer.",
    );

    replaceDuringDispose = true;
    firstSupport.dispose();
    expect(replacementSupport).toBeDefined();
    suspendTerminalSession(renderer);
    resumeTerminalSession(renderer);
    replacementSupport!.dispose();

    expect(writes).toEqual([
      "\x1b[?1004h",
      "\x1b[?1004l",
      "\x1b[?1004h",
      "\x1b[?1004l",
      "\x1b[?1004h",
      "\x1b[?1004l",
    ]);
  });
});
