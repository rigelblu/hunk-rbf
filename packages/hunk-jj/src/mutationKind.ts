/**
 * Declares what one kind of history change supplies to the JJ mutation runner.
 *
 * A kind names the revisions it needs observed, turns a request into jj
 * arguments, words the confirm step and judges what was read back. The runner
 * owns every process, every read and the final check. A kind module stays
 * pure: it imports only `hunkdiff/extension` types and this file.
 */
import type {
  ExtensionVcsMutationChange,
  ExtensionVcsMutationFacts,
  ExtensionVcsMutationKind,
  ExtensionVcsMutationProcessOutcome,
  ExtensionVcsMutationProjection,
  ExtensionVcsMutationRequest,
  ExtensionVcsMutationRevisionRef,
  ExtensionVcsMutationVerdict,
} from "hunkdiff/extension";

/** A revision named in a kind's arguments. The runner substitutes the id form. */
export interface JjRevisionArgument {
  revision: ExtensionVcsMutationRevisionRef;
}
export type JjMutationArgument = string | JjRevisionArgument;

/** Why the kind will not run this request. */
export interface JjMutationRefusal {
  /** One sentence the user reads, without jj's wording. */
  refused: string;
  /** jj's own text, when you have it. The runner fills it from a failed dry run when you leave it out. */
  providerText?: string;
}

/** How this request runs. */
export interface JjMutationPlan {
  /** The jj arguments after `jj`, without global flags. The runner adds those. */
  args: readonly JjMutationArgument[];
  /** dry-run: the runner runs `args` with `--no-integrate-operation` and reads the change. facts-only: no dry run, because the command needs the user's input. */
  preview: "dry-run" | "facts-only";
  /** The command needs the terminal. The runner hands it over for the whole command. */
  interactive: boolean;
  /** The composed description, when the kind writes one. */
  description?: string;
}

/** What the dry run gave. `text` is jj's own output in every case. */
export type JjDryRun =
  | { kind: "change"; change: ExtensionVcsMutationChange; text: string }
  /** jj exited 0 and named no operation. Call it a no-op only when you recognise `text`; otherwise refuse. */
  | { kind: "no-operation"; text: string }
  | { kind: "failed"; exitCode: number | null; text: string };

export interface JjMutationKind<Kind extends ExtensionVcsMutationKind = ExtensionVcsMutationKind> {
  readonly kind: Kind;
  /** The revisions the runner observes for this request. `facts.revisions` holds them in this order. */
  revisions(
    request: Extract<ExtensionVcsMutationRequest, { kind: Kind }>,
  ): readonly ExtensionVcsMutationRevisionRef[];
  /** Check the request against the facts. Return the plan, or a refusal. */
  plan(input: {
    request: Extract<ExtensionVcsMutationRequest, { kind: Kind }>;
    facts: ExtensionVcsMutationFacts;
  }): JjMutationPlan | JjMutationRefusal;
  /** Word the confirm step. `dryRun` is null for a facts-only plan. */
  project(input: {
    request: Extract<ExtensionVcsMutationRequest, { kind: Kind }>;
    facts: ExtensionVcsMutationFacts;
    plan: JjMutationPlan;
    dryRun: JjDryRun | null;
  }): ExtensionVcsMutationProjection | JjMutationRefusal;
  /** Judge what was read back. Compare `change` with `preview` to word a difference. */
  judge(input: {
    request: Extract<ExtensionVcsMutationRequest, { kind: Kind }>;
    facts: ExtensionVcsMutationFacts;
    plan: JjMutationPlan;
    process: ExtensionVcsMutationProcessOutcome;
    /** What the confirm step showed. Null for a facts-only plan. */
    preview: ExtensionVcsMutationChange | null;
    /** Null when the read-back failed. Return `unexpected`, with a headline saying the result could not be read back. */
    change: ExtensionVcsMutationChange | null;
  }): ExtensionVcsMutationVerdict;
}

/** Tells a refusal from a plan or a projection. */
export function isJjMutationRefusal(value: object): value is JjMutationRefusal {
  return "refused" in value;
}
