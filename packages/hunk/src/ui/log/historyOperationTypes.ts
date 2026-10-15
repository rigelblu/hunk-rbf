/** Declare retained operation presentation state without importing its implementation. */
import type {
  ExtensionVcsHistoryCommit,
  ExtensionVcsMutationPrepared,
  ExtensionVcsMutationRequest,
  ExtensionVcsMutationResult,
} from "../../extension-api/types";
import type { HistoryMutationModal, HistoryMutationModalFrame } from "./mutationFlow";
import type { RevisionSourcePanelActions, RevisionSourcePanelState } from "./RevisionSourcePanel";
export type HistoryOperationKind = "squash" | "rebase";
export interface HistoryInspectionToken {
  readonly visit: symbol;
  readonly inspection: number;
}
export type HistoryOperationPhase =
  | "idle"
  | "sources"
  | "destination"
  | "preparing"
  | "confirmation"
  | "applying"
  | "result";
export interface HistoryOperationSnapshot {
  readonly phase: HistoryOperationPhase;
  readonly visit: symbol | null;
  readonly attempt: number;
  readonly operation: HistoryOperationKind | null;
  readonly suspended: boolean;
  /** Reveal only the current Squash preparation after its short feedback delay. */
  readonly squashCheckingVisible: boolean;
  readonly sources: readonly ExtensionVcsHistoryCommit[];
  readonly placement: "onto" | "after" | "before";
  readonly prepared: ExtensionVcsMutationPrepared | null;
  readonly request: ExtensionVcsMutationRequest | null;
  readonly result: ExtensionVcsMutationResult | null;
  readonly reason: string;
  readonly providerText: string;
  readonly details: boolean;
  /** Distinguish the on-demand receipt from nested failure output. */
  readonly fullResult: boolean;
  /** Retain dismissible success presentation without holding the modal slot. */
  readonly resultNotice: string | null;
  readonly focus: number;
  readonly scroll: number;
  readonly refreshFailed: boolean;
  readonly modal: HistoryMutationModal | null;
}

/** Let the views issue only the operation transitions they actually expose. */
export interface HistoryOperationViewFlow {
  getSnapshot(): HistoryOperationSnapshot;
  sourceState(): RevisionSourcePanelState;
  sourceActions(frame: HistoryMutationModalFrame): RevisionSourcePanelActions;
  destinationRefusal(commit: ExtensionVcsHistoryCommit | null): string | null;
  previewDestination(visit: symbol, attempt?: number): void;
  squashDestinationReady(): boolean;
  choosePlacement(visit: symbol, placement: "onto" | "after" | "before", attempt?: number): void;
  cancelVisit(visit: symbol, attempt?: number): Promise<void>;
  cancelConfirmation(visit: symbol, attempt: number): Promise<void>;
  toggleSkipEmptied(visit: symbol, attempt: number): Promise<void>;
  apply(visit: symbol, attempt: number): void;
  updateView(
    update: Pick<Partial<HistoryOperationSnapshot>, "focus" | "details" | "scroll">,
    expected?: Pick<HistoryOperationSnapshot, "visit" | "attempt" | "phase">,
  ): void;
  closeResult(attempt?: number): void;
  retryRefresh(attempt?: number): Promise<void>;
}
