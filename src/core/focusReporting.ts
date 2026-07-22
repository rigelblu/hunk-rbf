import type { CliRenderer } from "@opentui/core";

const ENABLE_FOCUS_REPORTING = "\x1b[?1004h";
const DISABLE_FOCUS_REPORTING = "\x1b[?1004l";

type TerminalControlRenderer = Pick<CliRenderer, "resume" | "suspend">;
const supportByRenderer = new WeakMap<TerminalControlRenderer, TerminalFocusReportingSupport>();

export interface TerminalFocusReportingSupport {
  /** Re-enable focus reporting after terminal modes are restored. */
  enable: () => void;
  /** Disable focus reporting before yielding the terminal. */
  disable: () => void;
  /** Permanently release focus reporting for this app session. */
  dispose: () => void;
}

/** Request terminal focus sequences for one balanced app-session lifetime. */
export function installTerminalFocusReporting(
  renderer: TerminalControlRenderer,
  output: Pick<NodeJS.WriteStream, "write">,
): TerminalFocusReportingSupport {
  if (supportByRenderer.has(renderer)) {
    throw new Error("Terminal focus reporting is already installed for this renderer.");
  }

  let disposed = false;
  let enabled = false;

  const writeMode = (sequence: string) => {
    try {
      output.write(sequence);
    } catch {
      // A closed terminal must not prevent normal shutdown or resume handling.
    }
  };

  const enable = () => {
    if (disposed || enabled) {
      return;
    }
    enabled = true;
    writeMode(ENABLE_FOCUS_REPORTING);
  };

  const disable = () => {
    if (!enabled) {
      return;
    }
    enabled = false;
    writeMode(DISABLE_FOCUS_REPORTING);
  };

  enable();

  const support: TerminalFocusReportingSupport = {
    enable,
    disable,
    dispose: () => {
      if (disposed) {
        return;
      }
      disable();
      disposed = true;
      if (supportByRenderer.get(renderer) === support) {
        supportByRenderer.delete(renderer);
      }
    },
  };
  supportByRenderer.set(renderer, support);
  return support;
}

/** Yield terminal ownership through the shared focus-reporting lifecycle. */
export function suspendTerminalSession(renderer: TerminalControlRenderer) {
  supportByRenderer.get(renderer)?.disable();
  renderer.suspend();
}

/** Restore terminal ownership through the shared focus-reporting lifecycle. */
export function resumeTerminalSession(renderer: TerminalControlRenderer) {
  renderer.resume();
  supportByRenderer.get(renderer)?.enable();
}
