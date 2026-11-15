/**
 * Lists the kinds of history change the JJ provider offers.
 *
 * `availability().kinds` and the runner's lookup both read this record, so a
 * kind exists once it has an entry here. Keep one entry per line, in
 * alphabetical order, so parallel additions merge without conflict.
 */
import type { ExtensionVcsMutationKind } from "hunkdiff/extension";
import { abandonKind } from "./mutationAbandon";
import type { JjMutationKind } from "./mutationKind";
import { rebaseKind } from "./mutationRebase";
import { squashKind } from "./mutationSquash";

export const JJ_MUTATION_KINDS: {
  readonly [Kind in ExtensionVcsMutationKind]?: JjMutationKind<Kind>;
} = {
  abandon: abandonKind,
  rebase: rebaseKind,
  squash: squashKind,
};

/** Returns the registered kind names in alphabetical order. */
export function listJjMutationKinds(): ExtensionVcsMutationKind[] {
  return (Object.keys(JJ_MUTATION_KINDS) as ExtensionVcsMutationKind[]).sort();
}
