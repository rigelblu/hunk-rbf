import { describe, expect, test } from "bun:test";
import {
  installTerminalFocusReporting,
  resumeTerminalSession,
  suspendTerminalSession,
} from "./focusReporting";

describe("installTerminalFocusReporting", () => {
  test("balances reporting across install, suspend, resume, and dispose", () => {
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

  test("rejects duplicate ownership for one renderer", () => {
    const renderer = { resume: () => undefined, suspend: () => undefined };
    const output = { write: () => true };
    const support = installTerminalFocusReporting(renderer, output);

    expect(() => installTerminalFocusReporting(renderer, output)).toThrow(
      "Terminal focus reporting is already installed for this renderer.",
    );

    support.dispose();
  });

  test("does not let terminal write failures escape", () => {
    const renderer = { resume: () => undefined, suspend: () => undefined };
    expect(() =>
      installTerminalFocusReporting(renderer, {
        write: () => {
          throw new Error("terminal closed");
        },
      }).dispose(),
    ).not.toThrow();
  });
});
