import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { HistoryCommit } from "../../core/history/types";
import { persistedViewPreferencesFromOptions } from "../../core/run/config";
import { createTestExtensionSession } from "../../../../../test/helpers/extension-session";
import type { HistoryRuntime } from "./types";
import { runStaticHistory } from "./runStaticHistory";

/** Create a page-backed runtime and expose whether cleanup ran. */
function runtime(commits: HistoryCommit[], maxCount?: number, closeFailure?: Error) {
  let offset = 0;
  let closed = 0;
  let reads = 0;
  const cleanup: string[] = [];
  const extensionSession = createTestExtensionSession();
  extensionSession.shutdown = async () => {
    cleanup.push("extensions");
  };
  const value: HistoryRuntime = {
    input: {
      kind: "history",
      color: "never",
      format: "medium",
      ascii: false,
      static: true,
      extensionsEnabled: true,
      extensionPaths: [],
      ...(maxCount !== undefined ? { maxCount } : {}),
    },
    extensionSession,
    providerId: "test",
    providerName: "Test",
    repoRoot: "/repo",
    notices: [],
    customThemes: [],
    keybindings: {},
    initialViewPreferences: persistedViewPreferencesFromOptions({}),
    promptSaveViewPreferences: true,
    async planReview(commit) {
      return { kind: "revision-show", revisionId: commit.revisionId };
    },
    async reopenSource() {
      return value.source;
    },
    source: {
      async read({ limit }) {
        reads += 1;
        const page = commits.slice(offset, offset + limit);
        offset += page.length;
        return { commits: page, done: offset >= commits.length };
      },
      async close() {},
    },
    async close() {
      closed += 1;
      cleanup.push("cursor");
      if (closeFailure) throw closeFailure;
    },
  };
  return { value, closed: () => closed, reads: () => reads, cleanup };
}

const commits: HistoryCommit[] = ["a", "b"].map((id, index) => ({
  revisionId: id,
  displayId: id.repeat(8),
  parentRevisionIds: index === 0 ? ["b"] : [],
  subject: `Commit ${id}`,
  authorName: "Ada",
  authoredAt: "2026-01-01T00:00:00Z",
  decorations: [],
}));

describe("static history runner", () => {
  test("writes complete rows directly to non-TTY output and closes", async () => {
    const history = runtime(commits);
    let output = "";
    let paged = "";
    await runStaticHistory(history.value, {
      stdout: {
        isTTY: false,
        columns: 80,
        rows: 24,
        write: (text) => ((output += String(text)), true),
      },
      stderr: { write: () => true },
      env: {},
      pageText: async (text) => {
        paged = text;
      },
    });
    expect(output).toContain("Commit a");
    expect(output).toContain("Commit b");
    expect(paged).toBe("");
    expect(history.closed()).toBe(1);
    expect(history.cleanup).toEqual(["cursor", "extensions"]);
  });

  test("closes the cursor before extensions when pager startup fails", async () => {
    const history = runtime(commits);
    await expect(
      runStaticHistory(history.value, {
        stdout: { isTTY: true, columns: 80, rows: 2, write: () => true },
        stderr: { write: () => true },
        env: { TERM: "xterm" },
        pageText: async () => {
          throw new Error("pager failed");
        },
      }),
    ).rejects.toThrow("pager failed");
    expect(history.cleanup).toEqual(["cursor", "extensions"]);
  });

  test("still shuts down extensions when cursor close rejects", async () => {
    const failure = new Error("cursor close failed");
    const history = runtime(commits, undefined, failure);
    await expect(
      runStaticHistory(history.value, {
        stdout: { isTTY: false, columns: 80, rows: 24, write: () => true },
        stderr: { write: () => true },
        env: {},
        pageText: async () => {},
      }),
    ).rejects.toBe(failure);
    expect(history.cleanup).toEqual(["cursor", "extensions"]);
  });

  test("treats a downstream EPIPE as normal and still closes the source", async () => {
    const history = runtime(commits);
    const stdout = new EventEmitter() as EventEmitter & {
      isTTY: boolean;
      columns: number;
      rows: number;
      write(text: string): boolean;
    };
    stdout.isTTY = false;
    stdout.columns = 80;
    stdout.rows = 24;
    stdout.write = () => {
      queueMicrotask(() =>
        stdout.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" })),
      );
      return false;
    };
    await runStaticHistory(history.value, {
      stdout: stdout as never,
      stderr: { write: () => true },
      env: {},
      pageText: async () => {},
    });
    expect(history.closed()).toBe(1);
  });

  test("uses the pager only when TTY rows overflow", async () => {
    const history = runtime(commits);
    let paged = "";
    await runStaticHistory(history.value, {
      stdout: { isTTY: true, columns: 80, rows: 2, write: () => true },
      stderr: { write: () => true },
      env: { TERM: "xterm" },
      pageText: async (text) => {
        paged = text;
      },
    });
    expect(paged).toContain("Commit a");
    expect(paged).toContain("Commit b");
  });

  test("streams overflowing TTY pages through one bounded pager writer", async () => {
    const history = runtime(commits);
    let written = "";
    let closes = 0;
    await runStaticHistory(history.value, {
      stdout: { isTTY: true, columns: 80, rows: 2, write: () => true },
      stderr: { write: () => true },
      env: { TERM: "xterm" },
      pageText: async () => {
        throw new Error("buffered pager should not run");
      },
      openPager: () => ({
        async write(text) {
          written += text;
        },
        async close() {
          closes += 1;
        },
      }),
    });
    expect(written).toContain("Commit a");
    expect(written).toContain("Commit b");
    expect(closes).toBe(1);
  });

  test("stops traversing history when the pager closes early", async () => {
    const manyCommits = Array.from({ length: 600 }, (_, index) => ({
      ...commits[1]!,
      revisionId: `commit-${index}`,
      displayId: `c${index}`,
      subject: `Commit ${index}`,
    }));
    const history = runtime(manyCommits);
    let closes = 0;
    await runStaticHistory(history.value, {
      stdout: { isTTY: true, columns: 80, rows: 2, write: () => true },
      stderr: { write: () => true },
      env: { TERM: "xterm" },
      pageText: async () => {},
      openPager: () => ({
        async write() {
          return false;
        },
        async close() {
          closes += 1;
        },
      }),
    });
    expect(history.reads()).toBe(1);
    expect(history.closed()).toBe(1);
    expect(closes).toBe(1);
  });

  test("keeps max-count zero silent even on a TTY", async () => {
    const history = runtime([], 0);
    let output = "";
    await runStaticHistory(history.value, {
      stdout: {
        isTTY: true,
        columns: 80,
        rows: 24,
        write: (text) => ((output += String(text)), true),
      },
      stderr: { write: () => true },
      env: {},
      pageText: async () => {},
    });
    expect(output).toBe("");
  });
});

test("HK-93 projection parity explains cutoffs once and fallback even when no records are emitted", async () => {
  for (const format of ["compact", "medium"] as const) {
    const history = runtime([
      { ...commits[0]!, parentRevisionIds: ["hidden"], graphCutoffParentRevisionIds: ["hidden"] },
    ]);
    history.value.input.format = format;
    history.value.source = {
      ...history.value.source,
      scope: { kind: "bounded", boundaryRevisionId: "a" },
    };
    let stdout = "",
      stderr = "";
    await runStaticHistory(history.value, {
      stdout: { isTTY: false, columns: 80, rows: 24, write: (value) => ((stdout += value), true) },
      stderr: { write: (value) => ((stderr += value), true) },
      env: {},
      pageText: async () => {},
    });
    expect(stdout.match(/~ older history hidden/g)).toHaveLength(1);
    expect(stdout.split("\n").some((line) => line.trim() === "~")).toBe(true);
    expect(stderr).toBe("");
  }
  for (const reason of ["unavailable", "ambiguous"] as const) {
    const history = runtime([], 0);
    history.value.source = { ...history.value.source, scope: { kind: "fallback", reason } };
    let stdout = "",
      stderr = "";
    await runStaticHistory(history.value, {
      stdout: { isTTY: false, columns: 80, rows: 24, write: (value) => ((stdout += value), true) },
      stderr: { write: (value) => ((stderr += value), true) },
      env: {},
      pageText: async () => {},
    });
    expect(stdout).toBe("");
    expect(stderr).toBe(`hunk: Mainline ${reason}; showing visible history.\n`);
  }
});

test("HK-93 failed initial fallback reads never claim visible history and still close", async () => {
  for (const emptyPage of [false, true]) {
    const history = runtime([]);
    history.value.source = {
      ...history.value.source,
      scope: { kind: "fallback", reason: "unavailable" },
      read: async () => {
        if (!emptyPage) throw new Error("invalid machine record");
        return { commits: [], done: false };
      },
    };
    let stdout = "",
      stderr = "";
    await expect(
      runStaticHistory(history.value, {
        stdout: {
          isTTY: false,
          columns: 80,
          rows: 24,
          write: (value) => ((stdout += value), true),
        },
        stderr: { write: (value) => ((stderr += value), true) },
        env: {},
        pageText: async () => {},
      }),
    ).rejects.toThrow(emptyPage ? "empty page" : "invalid machine record");
    expect(stdout).toBe("");
    expect(stderr).toBe("");
    expect(history.closed()).toBe(1);
  }
});
