import { createTestCleanSquashResult } from "../../../../../test/helpers/mutation-result";
import { isValidElement } from "react";
import type { ConfirmDialogAction } from "../components/chrome/ConfirmDialog";
import { afterEach, expect, jest, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import type {
  ExtensionVcsMutationPrepared,
  ExtensionVcsMutationRequest,
  ExtensionVcsMutationPreparation,
  ExtensionVcsMutationResult,
} from "../../extension-api/types";
import type { HistoryMutationRuntime } from "../history/types";
import { resolveTheme } from "../themes";
import { createTestRevisionSourcePanelController } from "../../../../../test/helpers/revision-source-panel";
import { HistoryMutationFlowController } from "./HistoryMutationFlowController";
import {
  HistoryOperationView,
  planHistoryOperationOverlay,
  squashDockLayout,
} from "./HistoryOperationView";

const retained: Array<{
  flow: HistoryMutationFlowController;
  controller: Awaited<ReturnType<typeof createTestRevisionSourcePanelController>>;
}> = [];
afterEach(async () => {
  for (const fixture of retained.splice(0)) {
    await fixture.flow.shutdown();
    await fixture.controller.close();
  }
});
/** Let queued input, provider settlement and subscriber callbacks complete. */
const tickTestFlow = () => new Promise<void>((resolve) => setImmediate(resolve));
/** Build deferred provider work so cancellation races are deterministic. */
function deferredTestFlow<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((r, fail) => {
    resolve = r;
    reject = fail;
  });
  return { promise, resolve, reject };
}
/** Observe the real controller and inject only the provider boundary. */
async function createTestFlow() {
  const controller = await createTestRevisionSourcePanelController();
  const disposed: string[] = [];
  const applied: string[] = [];
  let preparation = 0;
  const prepareTest = (request: ExtensionVcsMutationRequest): ExtensionVcsMutationPrepared => ({
    handleId: `handle-${++preparation}`,
    request,
    facts: {
      providerVersion: "test",
      operationId: "observed",
      files: { kind: "clean" },
      revisions: controller
        .getSnapshot()
        .rows.slice(0, 2)
        .map(({ commit }) => ({
          revisionId: commit.revisionId,
          logicalId: commit.logicalId,
          parents: [],
          description: `${commit.subject}\nFull second line`,
          isEmpty: false,
          hasConflict: false,
          isDivergent: false,
          isWorkingCopy: false,
          isImmutable: false,
          isRoot: false,
          bookmarks: [],
        })),
    },
    projection: {
      headline: "Preview this action",
      notes: [],
      warnings: [],
      named: [
        { label: "Source", revision: { revisionId: "A" } },
        { label: "Destination", revision: { revisionId: "B" } },
      ],
    },
    isInteractive: false,
  });
  const runtime: HistoryMutationRuntime = {
    availability: async () => ({
      kind: "supported",
      kinds: ["squash", "rebase"],
      providerVersion: "test",
    }),
    prepare: async (request) => ({ kind: "ready", prepared: prepareTest(request) }),
    apply: async (id) => {
      applied.push(id);
      return { kind: "not-run", reason: "start-failed", text: "Test command did not start" };
    },
    dispose: async (id) => {
      disposed.push(id);
    },
  };
  const flow = new HistoryMutationFlowController(controller, runtime);
  retained.push({ flow, controller });
  const frame = (width = 80, height = 24) => ({
    terminalWidth: width,
    terminalHeight: height,
    theme: resolveTheme("github-dark-default", null),
    highlighted: controller.getSelectedRow()?.commit ?? null,
  });
  const confirm = async (kind: "squash" | "rebase" = "rebase") => {
    expect(await flow.beginSources(kind)).toBe(true);
    flow.continueSources(flow.getSnapshot().visit!);
    await tickTestFlow();
    await controller.select(1, 20);
    flow.previewDestination(flow.getSnapshot().visit!);
    await tickTestFlow();
    expect(flow.getSnapshot().phase).toBe("confirmation");
  };
  return { controller, flow, runtime, disposed, applied, frame, confirm, prepareTest };
}

test("explicit operation entry seeds highlight; empty and multiple intent never fall back", async () => {
  const f = await createTestFlow();
  expect(await f.flow.beginSources("rebase")).toBe(true);
  const visit = f.flow.getSnapshot().visit!;
  f.flow.toggleSource(visit);
  f.flow.continueSources(visit);
  await tickTestFlow();
  expect(f.flow.sourceState().targets.kind).toBe("empty");
  expect(f.flow.getSnapshot().phase).toBe("sources");
  f.flow.toggleSource(visit, "A");
  f.flow.toggleSource(visit, "C");
  f.flow.continueSources(visit);
  await tickTestFlow();
  expect(f.flow.sourceState().continueRefusal).toContain("2 are selected");
  expect(f.flow.getSnapshot().phase).toBe("sources");
  expect(f.applied).toEqual([]);
});
test("queued Space completes before queued inspection and retains an unrelated review range", async () => {
  const f = await createTestFlow();
  await f.flow.beginSources("rebase");
  const visit = f.flow.getSnapshot().visit!;
  await f.controller.select(2, 20, { extend: true });
  const range = f.controller.getSelection()!;
  f.flow.toggleSource(visit, "A");
  let token: ReturnType<typeof f.flow.beginInspection> = null;
  f.flow.inspectSource(visit, (next) => {
    token = next;
  });
  await tickTestFlow();
  expect(f.controller.getSnapshot().marks).toHaveLength(0);
  expect(f.flow.getSnapshot().suspended).toBe(true);
  expect(f.controller.getSelection()?.count).toBe(range.count);
  f.flow.finishInspection(token!);
  expect(f.flow.getSnapshot().suspended).toBe(false);
});
test("low-level inspection cannot overtake queued source editing", async () => {
  const f = await createTestFlow();
  await f.flow.beginSources("rebase");
  const visit = f.flow.getSnapshot().visit!;
  f.flow.toggleSource(visit);
  await Promise.resolve();
  expect(f.flow.beginInspection(visit)).toBeNull();
  await tickTestFlow();
  expect(f.controller.getSnapshot().marks).toHaveLength(0);
});
test("stale source actions, placement and inspection tokens cannot alter a newer visit", async () => {
  const f = await createTestFlow();
  await f.flow.beginSources("rebase");
  const oldVisit = f.flow.getSnapshot().visit!;
  let inspections = 0;
  const actions = f.flow.sourceActions({
    ...f.frame(),
    inspectHighlighted: () => {
      inspections++;
    },
  });
  const token = f.flow.beginInspection(oldVisit)!;
  f.flow.finishInspection(token);
  await f.flow.cancelVisit(oldVisit);
  await f.flow.beginSources("rebase");
  const newVisit = f.flow.getSnapshot().visit!;
  actions.toggle();
  actions.inspect?.();
  f.flow.choosePlacement(oldVisit, "before");
  f.flow.finishInspection(token);
  await tickTestFlow();
  expect(f.flow.getSnapshot().visit).toBe(newVisit);
  expect(f.flow.getSnapshot().placement).toBe("onto");
  expect(inspections).toBe(0);
  expect(f.controller.getSnapshot().marks).toHaveLength(1);
});
test("confirmation cancel retains sources and tracked disposal blocks shutdown", async () => {
  const f = await createTestFlow();
  await f.confirm();
  const s = f.flow.getSnapshot();
  const disposal = deferredTestFlow<void>();
  f.runtime.dispose = async () => disposal.promise;
  const cancelled = f.flow.cancelConfirmation(s.visit!, s.attempt);
  expect(f.flow.getSnapshot().phase).toBe("preparing");
  expect(f.flow.getSnapshot().prepared).toBeNull();
  await f.flow.cancelConfirmation(s.visit!, f.flow.getSnapshot().attempt);
  let stopped = false;
  const shutdown = f.flow.shutdown().then(() => {
    stopped = true;
  });
  await tickTestFlow();
  expect(stopped).toBe(false);
  disposal.resolve();
  await cancelled;
  await shutdown;
  expect(f.controller.getSnapshot().marks).toHaveLength(0);
});
test("confirmation cancel returns to destination on the same source tuple", async () => {
  const f = await createTestFlow();
  await f.confirm();
  const s = f.flow.getSnapshot();
  await f.flow.cancelConfirmation(s.visit!, s.attempt);
  expect(f.flow.getSnapshot().phase).toBe("destination");
  expect(f.flow.getSnapshot().visit).toBe(s.visit);
  expect(f.flow.indicator("A")).toBe("✓");
  expect(f.disposed).toEqual([s.prepared!.handleId]);
});
test("terminal cancel disposes a late ready preparation before ending", async () => {
  const f = await createTestFlow();
  await f.flow.beginSources("squash");
  const visit = f.flow.getSnapshot().visit!;
  f.flow.continueSources(visit);
  await tickTestFlow();
  await f.controller.select(1, 20);
  const pending = deferredTestFlow<ExtensionVcsMutationPreparation>();
  f.runtime.prepare = async () => pending.promise;
  f.flow.previewDestination(visit);
  await tickTestFlow();
  const request = f.flow.getSnapshot().request!;
  let ended = false;
  const cancellation = f.flow.cancelVisit(visit).then(() => {
    ended = true;
  });
  await tickTestFlow();
  expect(ended).toBe(false);
  const prepared = f.prepareTest(request);
  pending.resolve({ kind: "ready", prepared });
  await cancellation;
  expect(f.disposed).toContain(prepared.handleId);
  expect(f.flow.getSnapshot().visit).toBeNull();
  expect(f.controller.getSnapshot().marks).toHaveLength(0);
});
test("changed preview requires new confirmation and rejects an old Apply closure", async () => {
  const f = await createTestFlow();
  await f.confirm();
  const s = f.flow.getSnapshot();
  const refreshed = f.prepareTest(s.prepared!.request);
  f.runtime.apply = async (id) => {
    f.applied.push(id);
    return {
      kind: "not-run",
      reason: "changed",
      detail: "Repository changed",
      revisions: [],
      refreshed: { kind: "ready", prepared: refreshed },
    };
  };
  f.flow.apply(s.visit!, s.attempt);
  await tickTestFlow();
  expect(f.flow.getSnapshot().attempt).not.toBe(s.attempt);
  f.flow.apply(s.visit!, s.attempt);
  await tickTestFlow();
  expect(f.applied).toEqual([s.prepared!.handleId]);
  expect(f.flow.getSnapshot().prepared?.handleId).toBe(refreshed.handleId);
  expect(f.flow.indicator("A")).toBe("✓");
});
test("small-terminal keys cannot apply a hidden action; Cancel starts focused", async () => {
  const f = await createTestFlow();
  await f.confirm();
  expect(f.flow.getSnapshot().focus).toBe(0);
  f.flow.handleKey({ name: "tab" } as KeyEvent, f.frame(28, 10));
  f.flow.handleKey({ name: "return" } as KeyEvent, f.frame(28, 10));
  await tickTestFlow();
  expect(f.applied).toEqual([]);
});
test("one Apply runs once; actual result ends marks and remains reopenable", async () => {
  const f = await createTestFlow();
  await f.confirm();
  const s = f.flow.getSnapshot();
  f.flow.apply(s.visit!, s.attempt);
  f.flow.apply(s.visit!, s.attempt);
  await tickTestFlow();
  expect(f.applied).toHaveLength(1);
  expect(f.flow.getSnapshot().phase).toBe("result");
  expect(f.flow.getSnapshot().visit).toBeNull();
  expect(f.controller.getSnapshot().marks).toHaveLength(0);
  f.flow.closeResult();
  f.flow.openResult();
  expect(f.flow.getSnapshot().result?.kind).toBe("not-run");
});
test("saved results do not suppress invocation restoration on a later cancelled visit", async () => {
  const f = await createTestFlow();
  await f.confirm();
  const s = f.flow.getSnapshot();
  f.flow.apply(s.visit!, s.attempt);
  await tickTestFlow();
  f.flow.closeResult();
  await f.controller.select(0, 20);
  await f.flow.beginSources("squash");
  await f.controller.select(1, 20);
  await f.flow.cancelVisit(f.flow.getSnapshot().visit!);
  await tickTestFlow();
  expect(f.controller.getSnapshot().selected).toBe(0);
});
test("failed provider preview retains sources and full diagnostics under Details", async () => {
  const f = await createTestFlow();
  f.runtime.prepare = async () => ({
    kind: "refused",
    reason: "Native refusal",
    providerText: "JJ full diagnostic\nHint: choose another destination",
  });
  await f.flow.beginSources("rebase");
  const visit = f.flow.getSnapshot().visit!;
  f.flow.continueSources(visit);
  await tickTestFlow();
  await f.controller.select(1, 20);
  f.flow.previewDestination(visit);
  await tickTestFlow();
  expect(f.flow.getSnapshot().phase).toBe("destination");
  expect(f.flow.getSnapshot().providerText).toContain("Hint:");
  f.flow.handleKey({ name: "tab" } as KeyEvent, f.frame());
  f.flow.handleKey({ name: "tab" } as KeyEvent, f.frame());
  f.flow.handleKey({ name: "enter" } as KeyEvent, f.frame());
  expect(f.flow.getSnapshot().details).toBe(true);
  expect(f.flow.getSnapshot().modal?.presentation).toBe("overlay");
  expect(f.flow.indicator("A")).toBe("✓");
});
test("old Details and Close callbacks are rejected after a newer visit/result", async () => {
  const f = await createTestFlow();
  await f.confirm();
  const s = f.flow.getSnapshot();
  const view = HistoryOperationView({ flow: f.flow, frame: f.frame() });
  if (!isValidElement<{ actions: ConfirmDialogAction[] }>(view))
    throw new Error("Expected confirmation element");
  const details = view.props.actions.find((action) => action.id === "details")!.run;
  await f.flow.cancelVisit(s.visit!);
  await f.controller.select(0, 20);
  await f.confirm();
  details();
  expect(f.flow.getSnapshot().details).toBe(false);
});
test("aborted Apply retains actual readback and shutdown waits for its settlement", async () => {
  const f = await createTestFlow();
  await f.confirm();
  const s = f.flow.getSnapshot();
  const result = deferredTestFlow<ExtensionVcsMutationResult>();
  let signal: AbortSignal | undefined;
  f.runtime.apply = async (_id, nextSignal) => {
    signal = nextSignal;
    return result.promise;
  };
  f.flow.apply(s.visit!, s.attempt);
  let stopped = false;
  const shutdown = f.flow.shutdown().then(() => {
    stopped = true;
  });
  await tickTestFlow();
  expect(signal?.aborted).toBe(true);
  expect(stopped).toBe(false);
  result.resolve({
    kind: "ran",
    process: {
      started: true,
      exitCode: null,
      signal: "SIGTERM",
      wasInterrupted: true,
      terminal: "captured",
      terminalRestored: true,
      text: "Interrupted",
    },
    change: { kind: "unread", reason: "Test readback unavailable" },
    verdict: {
      outcome: "failed",
      headline: "Interrupted after starting",
      notes: [],
      warnings: [],
      named: [],
    },
    isWorkingCopyStale: false,
  });
  await shutdown;
  expect(f.flow.getSnapshot().result?.kind).toBe("ran");
  expect(f.controller.getSnapshot().marks).toHaveLength(0);
});

test("rejected preview disposal reports recovery, never sticks or leaks an unhandled rejection", async () => {
  const f = await createTestFlow();
  await f.confirm();
  const s = f.flow.getSnapshot();
  f.runtime.dispose = async () => {
    throw new Error("Test cleanup failure");
  };
  await f.flow.cancelConfirmation(s.visit!, s.attempt);
  expect(f.flow.getSnapshot().phase).toBe("destination");
  expect(f.flow.getSnapshot().reason).toContain("Could not discard the preview");
  expect(f.flow.indicator("A")).toBe("✓");
  await f.flow.cancelVisit(s.visit!);
  expect(f.flow.getSnapshot().phase).toBe("result");
  expect(f.flow.getSnapshot().visit).toBeNull();
  expect(await f.flow.beginSources("squash")).toBe(false);
  f.runtime.dispose = async (id) => {
    f.disposed.push(id);
  };
  await f.flow.retryRefresh();
  expect(f.flow.getSnapshot().refreshFailed).toBe(false);
  expect(await f.flow.beginSources("squash")).toBe(true);
});
test("rejected toggle disposal retains the same sources with a visible reason", async () => {
  const f = await createTestFlow();
  await f.confirm("rebase");
  const s = f.flow.getSnapshot();
  f.runtime.dispose = async () => {
    throw new Error("Test cleanup failure");
  };
  await f.flow.toggleSkipEmptied(s.visit!, s.attempt);
  expect(f.flow.getSnapshot().phase).toBe("destination");
  expect(f.flow.getSnapshot().reason).toContain("Could not discard");
  expect(f.flow.indicator("A")).toBe("✓");
  f.runtime.dispose = async () => {};
});

test("a refused source edit does not block progression for the still-valid explicit source", async () => {
  const f = await createTestFlow();
  await f.flow.beginSources("rebase");
  const visit = f.flow.getSnapshot().visit!;
  f.controller.getSnapshot().rows[2]!.commit.isImmutable = true;
  f.flow.toggleSource(visit, "C");
  await tickTestFlow();
  expect(f.flow.sourceState().notice).toContain("immutable");
  expect(f.flow.sourceState().continueRefusal).toBeUndefined();
  f.flow.continueSources(visit);
  await tickTestFlow();
  expect(f.flow.getSnapshot().phase).toBe("destination");
});
test("old source Cancel and destination callbacks cannot end or alter a newer preparation attempt", async () => {
  const f = await createTestFlow();
  await f.flow.beginSources("rebase");
  const sourceState = f.flow.getSnapshot();
  const actions = f.flow.sourceActions(f.frame());
  f.flow.continueSources(sourceState.visit!);
  await tickTestFlow();
  const destinationState = f.flow.getSnapshot();
  await f.controller.select(1, 20);
  f.flow.previewDestination(destinationState.visit!, destinationState.attempt);
  await tickTestFlow();
  const confirmed = f.flow.getSnapshot();
  actions.cancel();
  f.flow.choosePlacement(destinationState.visit!, "before", destinationState.attempt);
  await tickTestFlow();
  expect(f.flow.getSnapshot().phase).toBe("confirmation");
  expect(f.flow.getSnapshot().attempt).toBe(confirmed.attempt);
  expect(f.flow.getSnapshot().placement).toBe("onto");
  expect(f.flow.indicator("A")).toBe("✓");
});

/** Wait for automatic inline preparation rather than assuming one event-loop tick. */
async function readySquashTest(f: Awaited<ReturnType<typeof createTestFlow>>) {
  for (let i = 0; i < 30 && !f.flow.squashDestinationReady(); i++) await tickTestFlow();
  expect(f.flow.squashDestinationReady()).toBe(true);
}
test("Squash prepares in the graph and Enter executes once without a confirmation modal", async () => {
  const f = await createTestFlow();
  await f.flow.beginSources("squash");
  const visit = f.flow.getSnapshot().visit!;
  f.flow.continueSources(visit);
  await tickTestFlow();
  await f.controller.select(1, 20);
  await readySquashTest(f);
  expect(f.flow.getSnapshot().phase).toBe("destination");
  expect(f.flow.getSnapshot().modal?.presentation).toBe("docked");
  f.flow.previewDestination(visit);
  f.flow.previewDestination(visit);
  for (let i = 0; i < 10; i++) await tickTestFlow();
  expect(f.applied).toHaveLength(1);
  expect(f.flow.getSnapshot().phase).toBe("result");
  expect(f.flow.getSnapshot().modal?.presentation).toBe("docked");
  expect(f.controller.getSnapshot().marks).toHaveLength(0);
});
test("Squash disposes an obsolete candidate preview and never enables its handle", async () => {
  const f = await createTestFlow();
  const pending = deferredTestFlow<ExtensionVcsMutationPreparation>();
  let stale: ExtensionVcsMutationPrepared | undefined;
  f.runtime.prepare = async (request) => {
    if (request.kind === "squash" && request.destination.revisionId === "B") {
      stale = f.prepareTest(request);
      return pending.promise;
    }
    return { kind: "ready", prepared: f.prepareTest(request) };
  };
  await f.flow.beginSources("squash");
  f.flow.continueSources(f.flow.getSnapshot().visit!);
  await tickTestFlow();
  await f.controller.select(1, 20);
  for (let i = 0; i < 5 && !stale; i++) await tickTestFlow();
  expect(stale).toBeDefined();
  await f.controller.select(2, 20);
  expect(f.flow.squashDestinationReady()).toBe(false);
  pending.resolve({ kind: "ready", prepared: stale! });
  await readySquashTest(f);
  expect(f.disposed).toContain(stale!.handleId);
  const prepared = f.flow.getSnapshot().prepared!;
  expect(prepared.request.kind).toBe("squash");
  if (prepared.request.kind === "squash") expect(prepared.request.destination.revisionId).toBe("C");
  expect(f.applied).toHaveLength(0);
});
test("Squash rejects routine Details and a changed final preview requires a fresh Enter", async () => {
  const f = await createTestFlow();
  await f.flow.beginSources("squash");
  const visit = f.flow.getSnapshot().visit!;
  f.flow.continueSources(visit);
  await tickTestFlow();
  await f.controller.select(1, 20);
  await readySquashTest(f);
  const first = f.flow.getSnapshot();
  f.flow.updateView({ details: true }, first);
  expect(f.flow.getSnapshot().details).toBe(false);
  expect(f.flow.getSnapshot().modal?.presentation).toBe("docked");
  expect(f.controller.getSnapshot().marks).toHaveLength(0);
  f.flow.updateView({ details: false });
  f.runtime.apply = async (id) => {
    f.applied.push(id);
    return {
      kind: "not-run",
      reason: "changed",
      detail: "changed",
      revisions: [],
      refreshed: {
        kind: "ready",
        prepared: f.prepareTest(first.prepared!.request),
      },
    };
  };
  f.flow.previewDestination(visit);
  for (let i = 0; i < 8; i++) await tickTestFlow();
  expect(f.applied).toHaveLength(1);
  expect(f.flow.getSnapshot().phase).toBe("destination");
  expect(f.flow.getSnapshot().reason).toContain("press Enter again");
  f.flow.apply(visit, first.attempt);
  expect(f.applied).toHaveLength(1);
  expect(f.flow.getSnapshot().attempt).toBeGreaterThan(first.attempt);
});

/** Drain queued provider/navigation microtasks without advancing the feedback deadline. */
async function settleTestProgress() {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
}
/** Keep real operation/controller state and defer only the provider boundary. */
async function createTestPendingSquash() {
  const f = await createTestFlow();
  const pending: Array<{
    request: ExtensionVcsMutationRequest;
    signal?: AbortSignal;
    settle: ReturnType<typeof deferredTestFlow<ExtensionVcsMutationPreparation>>;
  }> = [];
  f.runtime.prepare = (request, signal) => {
    const settle = deferredTestFlow<ExtensionVcsMutationPreparation>();
    pending.push({ request, signal, settle });
    return settle.promise;
  };
  jest.useFakeTimers();
  await f.flow.beginSources("squash");
  f.flow.continueSources(f.flow.getSnapshot().visit!);
  await settleTestProgress();
  await f.controller.select(1, 20);
  await settleTestProgress();
  expect(pending).toHaveLength(1);
  const close = async () => {
    f.runtime.prepare = async (request) => ({ kind: "ready", prepared: f.prepareTest(request) });
    for (const item of pending)
      item.settle.resolve({ kind: "ready", prepared: f.prepareTest(item.request) });
    await settleTestProgress();
    await f.flow.shutdown();
    jest.useRealTimers();
  };
  return { ...f, pending, close, dock: () => squashDockLayout(f.flow, f.frame()) };
}

test("Squash feedback waits400ms while keyboard execution stays blocked", async () => {
  const f = await createTestPendingSquash();
  try {
    expect(f.dock().lines).toEqual([]);
    expect(f.dock().actions.map((a) => a.id)).toEqual(["cancel"]);
    jest.advanceTimersByTime(399);
    expect(f.dock().lines).toEqual([]);
    f.flow.handleKey({ name: "enter" } as KeyEvent, f.frame());
    expect(f.applied).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(f.dock().lines).toEqual(["Checking squash…"]);
    expect(f.dock().actions.map((a) => a.id)).toEqual(["cancel"]);
    f.flow.handleKey({ name: "enter" } as KeyEvent, f.frame());
    expect(f.applied).toEqual([]);
    f.pending[0]!.settle.resolve({ kind: "ready", prepared: f.prepareTest(f.pending[0]!.request) });
    await settleTestProgress();
    expect(f.dock().lines).toEqual(["1 revision will be squashed."]);
    expect(f.dock().actions.map((a) => a.id)).toEqual(["squash", "cancel"]);
    jest.advanceTimersByTime(1_000);
    expect(f.flow.getSnapshot().squashCheckingVisible).toBe(false);
    await f.controller.select(2, 20);
    await settleTestProgress();
    expect(f.dock().lines).toEqual([]);
    expect(f.dock().actions.map((a) => a.id)).toEqual(["cancel"]);
  } finally {
    await f.close();
  }
});

for (const outcome of ["ready", "refused", "error"] as const)
  test(`Squash ${outcome} before400ms never leaves delayed feedback`, async () => {
    const f = await createTestPendingSquash();
    try {
      jest.advanceTimersByTime(399);
      const item = f.pending[0]!;
      if (outcome === "error") item.settle.reject(new Error("Preview could not be read."));
      else
        item.settle.resolve(
          outcome === "ready"
            ? {
                kind: "ready",
                prepared: {
                  ...f.prepareTest(item.request),
                  projection: {
                    headline: "Ready",
                    named: [],
                    warnings: [],
                    notes: ["One additional effect."],
                  },
                },
              }
            : { kind: "refused", reason: "Destination is unavailable." },
        );
      await settleTestProgress();
      expect(f.dock().lines.join("\n")).toContain(
        outcome === "ready"
          ? "One additional effect."
          : outcome === "error"
            ? "Preview could not be read."
            : "Destination is unavailable.",
      );
      jest.advanceTimersByTime(2_000);
      expect(f.dock().lines.join("\n")).not.toContain("Checking squash");
      expect(f.flow.getSnapshot().squashCheckingVisible).toBe(false);
    } finally {
      await f.close();
    }
  });

test("destination replacement clears old progress and restarts the full400ms delay", async () => {
  const f = await createTestPendingSquash();
  try {
    jest.advanceTimersByTime(400);
    expect(f.dock().lines).toEqual(["Checking squash…"]);
    await f.controller.select(2, 20);
    expect(f.pending[0]!.signal?.aborted).toBe(true);
    expect(f.dock().lines).toEqual([]);
    jest.advanceTimersByTime(1_000);
    expect(f.dock().lines).toEqual([]);
    const first = f.pending[0]!;
    first.settle.resolve({ kind: "ready", prepared: f.prepareTest(first.request) });
    await settleTestProgress();
    expect(f.pending).toHaveLength(2);
    const second = f.pending[1]!.request;
    if (second.kind !== "squash") throw new Error("Expected the current Squash request");
    expect(second.destination.revisionId).toBe(f.controller.getSelectedRow()!.commit.revisionId);
    expect(f.flow.squashDestinationReady()).toBe(false);
    jest.advanceTimersByTime(399);
    expect(f.dock().lines).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(f.dock().lines).toEqual(["Checking squash…"]);
    expect(f.applied).toEqual([]);
  } finally {
    await f.close();
  }
});

for (const end of ["cancel", "shutdown"] as const)
  test(`${end} removes the pending Squash feedback timer`, async () => {
    const f = await createTestPendingSquash();
    try {
      jest.advanceTimersByTime(399);
      const done =
        end === "cancel" ? f.flow.cancelVisit(f.flow.getSnapshot().visit!) : f.flow.shutdown();
      expect(jest.getTimerCount()).toBe(0);
      jest.advanceTimersByTime(2_000);
      expect(f.flow.getSnapshot().squashCheckingVisible).toBe(false);
      f.pending[0]!.settle.resolve({
        kind: "ready",
        prepared: f.prepareTest(f.pending[0]!.request),
      });
      await settleTestProgress();
      await done;
      expect(f.flow.getSnapshot().squashCheckingVisible).toBe(false);
    } finally {
      await f.close();
    }
  });

test("Rebase preparation never owns a delayed Squash feedback timer", async () => {
  const f = await createTestFlow();
  const pending = deferredTestFlow<ExtensionVcsMutationPreparation>();
  let request!: ExtensionVcsMutationRequest;
  f.runtime.prepare = (value) => {
    request = value;
    return pending.promise;
  };
  jest.useFakeTimers();
  try {
    await f.flow.beginSources("rebase");
    f.flow.continueSources(f.flow.getSnapshot().visit!);
    await settleTestProgress();
    await f.controller.select(1, 20);
    f.flow.previewDestination(f.flow.getSnapshot().visit!);
    await settleTestProgress();
    expect(f.flow.getSnapshot().phase).toBe("preparing");
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(2_000);
    expect(f.flow.getSnapshot().squashCheckingVisible).toBe(false);
    pending.resolve({ kind: "ready", prepared: f.prepareTest(request) });
    await settleTestProgress();
    expect(f.flow.getSnapshot().phase).toBe("confirmation");
  } finally {
    if (request) pending.resolve({ kind: "ready", prepared: f.prepareTest(request) });
    await settleTestProgress();
    await f.flow.shutdown();
    jest.useRealTimers();
  }
});

test("Squash captures explicit selection directly, wins a range and preserves intent on cancel", async () => {
  const f = await createTestFlow();
  f.controller.toggleMark(2);
  f.controller.toggleMark(0);
  await f.controller.select(1, 20, { extend: true });
  expect(await f.flow.beginSources("squash")).toBe(true);
  expect(f.flow.getSnapshot().phase).not.toBe("sources");
  expect(f.flow.getSnapshot().sources.map((c) => c.revisionId)).toEqual(["A", "C"]);
  await f.flow.cancelVisit(f.flow.getSnapshot().visit!);
  expect(f.controller.getSnapshot().marks.map((m) => m.mark.revisionId)).toEqual(["C", "A"]);
});

test("primary Squash captures without seeding persistent selection", async () => {
  const f = await createTestFlow();
  await f.flow.beginSources("squash");
  expect(f.flow.getSnapshot().sources.map((c) => c.revisionId)).toEqual(["A"]);
  expect(f.controller.getSnapshot().marks).toHaveLength(0);
  expect(f.flow.getSnapshot().phase).toBe("destination");
});

test("selected Into is excluded before singleton provider preparation", async () => {
  const f = await createTestFlow();
  f.controller.toggleMark(0);
  f.controller.toggleMark(1);
  await f.controller.select(1, 20);
  await f.flow.beginSources("squash");
  for (let i = 0; i < 12; i++) await tickTestFlow();
  expect(f.flow.squashDestinationReady()).toBe(true);
  const request = f.flow.getSnapshot().prepared!.request;
  if (request.kind !== "squash") throw new Error("Expected Squash request");
  expect(request.sources.map((r) => r.revisionId)).toEqual(["A"]);
  expect(f.controller.getSnapshot().marks).toHaveLength(2);
});

test("Squash freezes its sources before deferred availability and never follows later focus", async () => {
  const f = await createTestFlow();
  const available = deferredTestFlow<Awaited<ReturnType<HistoryMutationRuntime["availability"]>>>();
  f.runtime.availability = () => available.promise;
  const entering = f.flow.beginSources("squash");
  await tickTestFlow();
  await f.controller.select(2, 20);
  available.resolve({ kind: "supported", kinds: ["squash"], providerVersion: "test" });
  await entering;
  expect(f.flow.getSnapshot().sources.map((c) => c.revisionId)).toEqual(["A"]);
  expect(f.controller.getSnapshot().marks).toHaveLength(0);
});

for (const outcome of ["completed", "failed", "unread"] as const)
  test(`Squash ${outcome} readback prunes only proved removals after refresh`, async () => {
    const f = await createTestFlow();
    f.controller.toggleMark(0);
    f.controller.toggleMark(1);
    await f.controller.select(1, 20);
    await f.flow.beginSources("squash");
    await readySquashTest(f);
    const prepared = f.flow.getSnapshot().prepared!;
    const source = prepared.facts.revisions.find((r) => r.revisionId === "A")!;
    const originalRefresh = f.controller.refreshAfterMutation.bind(f.controller);
    let refreshCount = 0;
    f.controller.refreshAfterMutation = async (apply, removed) => {
      refreshCount++;
      expect(f.controller.getSnapshot().marks).toHaveLength(2);
      return outcome === "completed" && refreshCount === 1
        ? false
        : originalRefresh(apply, removed);
    };
    f.runtime.apply = async () => ({
      kind: "ran",
      process: {
        started: true,
        exitCode: outcome === "failed" ? 1 : 0,
        signal: null,
        wasInterrupted: false,
        terminal: "captured",
        terminalRestored: true,
        text: "actual test output",
      },
      change:
        outcome === "unread"
          ? { kind: "unread", reason: "readback unavailable" }
          : {
              kind: "read",
              value: {
                operations: [],
                bookmarks: [],
                revisions: [{ before: [source], after: [] }],
              },
            },
      verdict: {
        outcome: outcome === "unread" ? "unexpected" : outcome,
        headline: "Actual result",
        notes: [],
        warnings: [],
        named: [],
      },
      isWorkingCopyStale: false,
    });
    f.flow.previewDestination(f.flow.getSnapshot().visit!);
    for (let i = 0; i < 12; i++) await tickTestFlow();
    if (outcome === "completed") {
      expect(f.flow.getSnapshot().refreshFailed).toBe(true);
      expect(f.controller.getSnapshot().marks).toHaveLength(2);
      await f.flow.retryRefresh();
    }
    expect(f.controller.getSnapshot().marks.map((m) => m.mark.revisionId)).toEqual(
      outcome === "unread" ? ["A", "B"] : ["B"],
    );
    expect(refreshCount).toBe(outcome === "completed" ? 2 : 1);
  });

test("Squash refuses unresolved intent inline without falling back to a ready highlight", async () => {
  const f = await createTestFlow();
  f.controller.toggleMark(0);
  f.controller.getSnapshot().rows[0]!.commit.revisionId = "replacement";
  expect(await f.flow.beginSources("squash")).toBe(false);
  expect(f.flow.getSnapshot().reason).toContain("unresolved");
  expect(f.flow.getSnapshot().modal?.presentation).toBe("docked");
  expect(f.controller.getSnapshot().marks).toHaveLength(1);
  expect(f.applied).toHaveLength(0);
});

for (const cleanupFails of [false, true])
  test(`clean Squash notice waits for cleanup and retains full result (${cleanupFails})`, async () => {
    const f = await createTestFlow();
    let prepared!: ExtensionVcsMutationPrepared;
    f.runtime.prepare = async (request) => ({
      kind: "ready",
      prepared: (prepared = f.prepareTest(request)),
    });
    f.runtime.apply = async () => {
      const result = createTestCleanSquashResult(prepared);
      result.verdict.notes.push("1 other revision rebased.");
      return result;
    };
    const cleanup = deferredTestFlow<void>();
    f.runtime.dispose = async () => {
      await cleanup.promise;
    };
    await f.flow.beginSources("squash");
    await f.controller.select(1, 20);
    await tickTestFlow();
    const { visit, attempt } = f.flow.getSnapshot();
    f.flow.apply(visit!, attempt);
    await tickTestFlow();
    const beforeCleanup = f.flow.getSnapshot().resultNotice;
    if (cleanupFails) cleanup.reject(new Error("cleanup failed"));
    else cleanup.resolve();
    expect(beforeCleanup).toBeNull();
    await tickTestFlow();
    await tickTestFlow();
    if (cleanupFails) {
      expect(f.flow.getSnapshot().phase).toBe("result");
      expect(f.flow.getSnapshot().refreshFailed).toBe(true);
      expect(f.flow.getSnapshot().resultNotice).toBeNull();
      f.flow.closeResult();
      f.flow.openResult();
      expect(
        planHistoryOperationOverlay(f.flow, f.frame()).actions.map((action) => action.label),
      ).toContain("Retry refresh");
      f.runtime.dispose = async () => {};
      f.flow.getSnapshot().modal!.handleKey({ name: "r" } as KeyEvent, f.frame());
      await tickTestFlow();
      expect(f.flow.getSnapshot().refreshFailed).toBe(false);
      expect(f.flow.getSnapshot().fullResult).toBe(true);
    } else {
      expect(f.flow.getSnapshot().phase).toBe("idle");
      expect(f.flow.getSnapshot().modal).toBeNull();
      expect(f.flow.getSnapshot().resultNotice).toBe("1 revision was squashed.");
      f.flow.dismissResultNotice(attempt - 1);
      expect(f.flow.getSnapshot().resultNotice).not.toBeNull();
      f.flow.dismissResultNotice(attempt);
      expect(f.flow.getSnapshot().resultNotice).toBeNull();
      f.flow.openResult();
      expect(f.flow.getSnapshot().fullResult).toBe(true);
      expect(f.flow.getSnapshot().result).toBeTruthy();
      expect(f.flow.getSnapshot().modal?.presentation).toBe("overlay");
      f.flow.closeResult();
      expect(f.flow.getSnapshot().resultNotice).toBeNull();
    }
  });
