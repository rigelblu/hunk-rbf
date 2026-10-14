import { isValidElement } from "react";
import type { ConfirmDialogAction } from "../components/chrome/ConfirmDialog";
import { afterEach, expect, test } from "bun:test";
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
import { HistoryOperationView } from "./HistoryOperationView";

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
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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
  const confirm = async (kind: "squash" | "rebase" = "squash") => {
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
  expect(await f.flow.beginSources("squash")).toBe(true);
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
  await f.flow.beginSources("squash");
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
  await f.flow.beginSources("squash");
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
  await f.flow.beginSources("squash");
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
