import type { HistoryQueryReplacement } from "../../core/history/queryReplacement";
import type { HistoryCommandInput } from "../../core/run/commandInputs";
import type { PersistedViewPreferences, UserKeyBinding } from "../../core/run/config";
import type { InteractiveSessionInitialization } from "../../core/session/initialization";
import type { VcsHistorySource } from "../../core/vcs/types";
import type { ExtensionSession } from "../../extensions/session";
import type {
  ExtensionVcsHistoryCommit,
  ExtensionVcsHistoryRangeReviewAction,
  ExtensionVcsHistoryRangeSelection,
  ExtensionVcsHistoryReviewAction,
  ExtensionVcsHistoryReviewOptions,
  ExtensionVcsMutationCapability,
  ExtensionVcsMutationPreparation,
  ExtensionVcsMutationRequest,
  ExtensionVcsMutationResult,
  ExtensionVcsWatchPlan,
  NamedCustomThemeConfig,
} from "../../extension-api/types";

/**
 * History changes the active provider can prepare and apply, as the history view calls them.
 *
 * The view names a request and a handle. The repository, the command's process
 * and the one-at-a-time rule stay with the session that built this.
 */
export interface HistoryMutationRuntime {
  availability(signal?: AbortSignal): ReturnType<ExtensionVcsMutationCapability["availability"]>;
  /** Reads facts and previews. Moves nothing the user can see. */
  prepare(
    request: ExtensionVcsMutationRequest,
    signal?: AbortSignal,
  ): Promise<ExtensionVcsMutationPreparation>;
  /** Runs a confirmed preparation once. Aborting `signal` stops the command; the result is still read back. */
  apply(handleId: string, signal: AbortSignal): Promise<ExtensionVcsMutationResult>;
  dispose(handleId: string): Promise<void>;
}

/** Renderer-facing history resources with cursor data and command-owned extension authority. */
export interface HistoryRuntime {
  input: HistoryCommandInput;
  source: VcsHistorySource;
  providerId: string;
  providerName: string;
  /** Invocation cwd used to resolve explicit extension paths for embedded reviews. */
  startupCwd?: string;
  repoRoot: string;
  notices: readonly string[];
  customThemes: readonly NamedCustomThemeConfig[];
  /** User command overrides resolved by the active interactive surface. */
  keybindings: Readonly<Record<string, UserKeyBinding>>;
  /** Resolved launch preferences retained while history owns the session-wide quit flow. */
  initialViewPreferences: PersistedViewPreferences;
  viewPreferencesConfigPath?: string;
  promptSaveViewPreferences: boolean;
  /** Command-owned extension authority borrowed by embedded reviews. */
  extensionSession: ExtensionSession;
  /** Theme named by `hunk log --theme`, which reviews opened from history keep as CLI authority. */
  cliThemeOverride?: string;
  planReview(
    commit: ExtensionVcsHistoryCommit,
    options?: ExtensionVcsHistoryReviewOptions,
    signal?: AbortSignal,
  ): Promise<ExtensionVcsHistoryReviewAction>;
  planRangeReview?(
    selection: ExtensionVcsHistoryRangeSelection,
    options?: ExtensionVcsHistoryReviewOptions,
    signal?: AbortSignal,
  ): Promise<ExtensionVcsHistoryRangeReviewAction>;
  /** Absent when the provider offers no history changes. */
  mutations?: HistoryMutationRuntime;
  historyWatchPlan?: ExtensionVcsWatchPlan;
  historyWatchSignature?: (signal?: AbortSignal) => string | Promise<string>;
  /** Present only when the provider accepts expression input. */
  queryReplacement?: HistoryQueryReplacement;
  /** Replace the current provider cursor for an explicit interactive refresh. */
  reopenSource(signal?: AbortSignal): Promise<VcsHistorySource>;
  /** Commit a successfully primed replacement cursor and close the prior cursor. */
  acceptSource?(source: VcsHistorySource): Promise<void>;
  close(): Promise<void>;
}

/** Add launch inputs required only while history participates in an interactive routed session. */
export interface InteractiveHistoryRuntime extends HistoryRuntime {
  initialization: InteractiveSessionInitialization;
}
