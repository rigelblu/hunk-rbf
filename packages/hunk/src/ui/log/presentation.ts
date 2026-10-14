/** Describe display preferences shared by entry fitting and viewport planning. */
export interface LogPresentation {
  graph: boolean;
  unicode: boolean;
  author: boolean;
  date: boolean;
  decorations: boolean;
  /** Optional in older caller snapshots; absence uses the enabled default. */
  workspaceNames?: boolean;
}
