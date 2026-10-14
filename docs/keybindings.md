# Keybindings

Every keyboard shortcut is a named command, and the `[keybindings]` table maps
command ids to the keys you want them on:

```toml
[keybindings]
"hunk.app.quit" = "ctrl+x"               # one chord
"hunk.review.nextHunk" = ["]", "ctrl+n"] # several chords for one command
"hunk.review.focusFilter" = "/"          # takes "/" back from content search
"hunk.view.toggleMenuBar" = false        # unbind it entirely
"myext.toggle" = "ctrl+g"                # extension commands too
```

Every id starts with the name of whoever owns the command: Hunk's own commands
live under `hunk.`, and an extension's live under its extension id. That split
is structural — `hunk` is a reserved extension id, so an extension can never
mint a command id that shadows a built-in, whatever Hunk adds later. Extension commands currently
run on review surfaces; history resolves its built-in command set without claiming review-only extension chords.

Rules worth knowing:

- **User bindings replace defaults.** Listing chords for a command is the
  complete set of keys it answers to, not an addition to the shipped ones.
- **A key you bind is yours.** Any command that held the same chord only as a
  default gives it up, keeping its other keys. Above, `hunk.search.find` hands
  `/` to the filter while `n` / `N` still step search matches.
- **`false` (or `[]`) unbinds a command**, leaving its keys doing nothing.
- **Unbound commands are one line away.** The file filter ships without a key
  (Tab and the File menu reach it), as do `hunk.review.nextNote` /
  `previousNote` (`}` / `{` step through annotated hunks); one `[keybindings]`
  line gives any of them a chord.
- Two entries claiming one chord is a conflict: the first in the file wins and
  the session reports the other. Unknown command ids and unusable chords are
  reported the same way, and the rest of the table still applies.
- **Escape clears an active visual selection contextually** after overlays and
  extension modes have had their normal ownership. Without a selection, Escape
  remains available to extension commands because clear-selection is unbound.

Chords are `ctrl`, `alt`/`option`, `cmd`/`meta`, and `shift` joined with `+`
around a base key: a character (`"y"`, `"["`), an uppercase letter for its
shifted form (`"G"`), or a named key (`"tab"`, `"pageup"`, `"left"`, `"f2"`).
`shift` applies to letters and named keys only — for a shifted symbol or digit,
write the character the shift produces (`"!"`, not `"shift+1"`), since that is
what terminals report. `ctrl+<letter>` also matches an unnamed bare control
byte; named Tab and Enter events stay distinct. `alt`/`option` matches both
explicit Alt events and the Escape-prefixed form used by legacy terminals. A
legacy terminal cannot distinguish Alt from Meta, so `alt+n` and `meta+n` may
overlap there; Kitty keyboard events keep them distinct.

Inline saved notes also expose clickable **Edit**, **Reply**, and (for reply-free user notes)
**Delete** actions. `E` edits the first editable user note in the selected hunk and `R` replies
to its first visible stored note. Replies inherit the code anchor and may be nested without a
product depth limit. Static sidecar annotations are not reply targets, and a parent cannot be
deleted until its replies are removed.

The built-in commands and the keys they ship with:

On a terminal, `hunk log` opens its read-only history browser automatically. Its `hunk.history.*`
commands use the same configurable keybinding resolver as review while retaining history-specific effects.
Shared application commands such as `hunk.app.quit`, `hunk.app.toggleHelp`, and
`hunk.view.openThemeSelector` keep the same ids on both surfaces. `F10` opens File, View, Navigate, Commit, and Help menus;
View includes Hunk's shared theme selector and an optional **Graph view** that replaces the default
day-grouped timeline with commit-topology lanes. It uses `Up`/`Down` or `j`/`k` to move; press `v` first to
extend a contiguous commit selection with those same keys. `Shift+Up`/`Shift+Down` or uppercase `K`/`J` extend
directly, and `Escape` collapses the selection. `PageUp`/`PageDown`, `b`/`f`, or `Shift+Space`/`Space` page
through history; `u`/`d` or `Ctrl-U`/`Ctrl-D` move by half a page; `g`/`G` or `Home`/`End` jump,
`/` to search, `n`/`N` for matches, `t` to choose a theme, `r` to refresh, `y` to copy the focused commit's full id,
`Enter` to open the selection in normal Hunk review, and `q` or `Ctrl-C` to quit. With a mouse, Shift-click a row to extend the
selection when the terminal forwards modifiers, click a commit id to open it immediately, click the adjacent copy
icon to copy its full immutable id, click elsewhere on a row to select it, or double-click a row to open it.
Range selection is unavailable with `--all` or author, message, date, and path filters because those traversals
can interleave unrelated commits or hide intermediate commits. Quitting the opened review returns to the retained history selection and viewport. The Commit menu's
**Compare with first parent** and **Compare with parent…** actions compare the selected commit against
an ordered provider-owned parent; they do not navigate the history selection to that parent.

With a provider that accepts revset expressions (Jujutsu), `L` or **View → Edit revset…** opens an editor for the
complete active revset: `F2` or `Enter` applies it, `F3` restores the launch policy, `Esc` or `Ctrl-C` cancels (neither quits Hunk from the editor), and
`Tab`/`Shift+Tab`, `Up`/`Down` or `Ctrl-N`/`Ctrl-P` highlight a revset applied earlier in the session, which `Enter` then
inserts without applying it. Custom revsets retain direct graph connections and mark omitted parents with `~`;
range selection remains unavailable.
View → Graph view (jj style) displays JJ’s native projected graph for the same revset.

History-specific commands:

| Command id                             | Does                                    | Default keys                 |
| -------------------------------------- | --------------------------------------- | ---------------------------- |
| `hunk.history.openSelection`           | Open the selected commit(s)             | `enter`                      |
| `hunk.history.copyRevision`            | Copy the focused commit id              | `y`                          |
| `hunk.history.refresh`                 | Refresh repository history              | `r`                          |
| `hunk.history.previousCommit`          | Move to the previous commit             | `up`, `k`                    |
| `hunk.history.nextCommit`              | Move to the next commit                 | `down`, `j`                  |
| `hunk.history.toggleRevisionSelection` | Select or unselect the focused revision | `m`                          |
| `hunk.history.clearRevisionSelection`  | Clear selected revisions                | `M`                          |
| `hunk.history.startVisualSelection`    | Start a review range                    | `v`                          |
| `hunk.history.clearSelection`          | Clear the review range                  | `escape`                     |
| `hunk.history.extendPrevious`          | Extend review range upward              | `shift+up`, `K`              |
| `hunk.history.extendNext`              | Extend review range downward            | `shift+down`, `J`            |
| `hunk.history.pageUp`                  | Move up one page                        | `pageup`, `b`, `shift+space` |
| `hunk.history.pageDown`                | Move down one page                      | `pagedown`, `space`, `f`     |
| `hunk.history.halfPageUp`              | Move up half a page                     | `u`, `ctrl+u`                |
| `hunk.history.halfPageDown`            | Move down half a page                   | `d`, `ctrl+d`                |
| `hunk.history.jumpToFirst`             | Jump to the first commit                | `home`, `g`                  |
| `hunk.history.jumpToLast`              | Jump to the last commit                 | `end`, `G`                   |
| `hunk.history.search`                  | Search history                          | `/`                          |
| `hunk.history.nextMatch`               | Select the next match                   | `n`                          |
| `hunk.history.previousMatch`           | Select the previous match               | `N`                          |
| `hunk.history.editRevset`              | Edit the history revset                 | `L`                          |
| `hunk.history.toggleGraph`             | Toggle graph presentation               | _(none)_                     |
| `hunk.history.toggleNativeGraph`       | Toggle Graph view (jj style)            | `ctrl+g`                     |
| `hunk.history.toggleUnicode`           | Toggle Unicode graph lines              | _(none)_                     |
| `hunk.history.toggleAuthor`            | Toggle author metadata                  | _(none)_                     |
| `hunk.history.toggleDate`              | Toggle date metadata                    | _(none)_                     |
| `hunk.history.toggleWorkspaceNames`    | Toggle workspace names                  | _(none)_                     |
| `hunk.history.toggleDecorations`       | Toggle ref decorations                  | _(none)_                     |
| `hunk.history.squash`                  | Squash selected or focused revisions    | `S`                          |
| `hunk.history.rebase`                  | Choose rebase sources                   | `R`                          |
| `hunk.history.operationResult`         | Open the last action result             | _(none)_                     |
| `hunk.history.openFirstParent`         | Compare with first parent               | _(none)_                     |
| `hunk.history.openParent`              | Choose a parent to compare              | _(none)_                     |
| `hunk.history.showAbout`               | Show application information            | _(none)_                     |

Review and shared commands:

| Command id                                     | Does                                           | Default keys                 |
| ---------------------------------------------- | ---------------------------------------------- | ---------------------------- |
| `hunk.app.openAgentSkill`                      | Show agent skill                               | _(none)_                     |
| `hunk.app.quit`                                | Quit                                           | `q`                          |
| `hunk.app.refresh`                             | Refresh the review                             | `r`                          |
| `hunk.app.toggleFocusArea`                     | Switch focus between files and filter          | `tab`                        |
| `hunk.app.toggleHelp`                          | Toggle help                                    | `?`                          |
| `hunk.review.alignCurrentLineBottom`           | Align current line to viewport bottom          | _(none)_                     |
| `hunk.review.alignCurrentLineCenter`           | Center current line in viewport                | _(none)_                     |
| `hunk.review.alignCurrentLineTop`              | Align current line to viewport top             | _(none)_                     |
| `hunk.review.clearSelection`                   | Clear the active visual selection              | _(none)_                     |
| `hunk.review.copySelection`                    | Copy the active visual selection               | `y`                          |
| `hunk.review.deleteActiveNote`                 | Delete active review note                      | `D`                          |
| `hunk.review.editActiveNote`                   | Edit active review note                        | `E`                          |
| `hunk.review.editSelectedFile`                 | Open the selected file in your editor          | `e`                          |
| `hunk.review.focusFilter`                      | Focus the file filter                          | _(none)_                     |
| `hunk.review.halfPageDown`                     | Scroll down half a page                        | `d`, `ctrl+d`                |
| `hunk.review.halfPageUp`                       | Scroll up half a page                          | `u`, `ctrl+u`                |
| `hunk.review.jumpToBottom`                     | Jump to end                                    | `G`, `end`                   |
| `hunk.review.jumpToTop`                        | Jump to start                                  | `g`, `home`                  |
| `hunk.review.nextAnnotatedFile`                | Next annotated file                            | _(none)_                     |
| `hunk.review.nextAnnotatedHunk`                | Next annotated hunk                            | `}`                          |
| `hunk.review.nextFile`                         | Next file                                      | `.`                          |
| `hunk.review.nextHunk`                         | Next hunk                                      | `]`                          |
| `hunk.review.nextNote`                         | Next review note                               | _(none)_                     |
| `hunk.review.pageDown`                         | Scroll down one page                           | `pagedown`, `space`, `f`     |
| `hunk.review.pageUp`                           | Scroll up one page                             | `pageup`, `b`, `shift+space` |
| `hunk.review.previousAnnotatedFile`            | Previous annotated file                        | _(none)_                     |
| `hunk.review.previousAnnotatedHunk`            | Previous annotated hunk                        | `{`                          |
| `hunk.review.previousFile`                     | Previous file                                  | `,`                          |
| `hunk.review.previousHunk`                     | Previous hunk                                  | `[`                          |
| `hunk.review.previousNote`                     | Previous review note                           | _(none)_                     |
| `hunk.review.replyToActiveNote`                | Reply to active review note                    | `R`                          |
| `hunk.review.scrollCodeLeft`                   | Scroll code left (shifted scrolls fast)        | `left`, `shift+left`         |
| `hunk.review.scrollCodeRight`                  | Scroll code right (shifted scrolls fast)       | `right`, `shift+right`       |
| `hunk.review.startNote`                        | Add a review note                              | `c`                          |
| `hunk.review.startVisualSelection`             | Start visual line selection                    | `v`                          |
| `hunk.review.stepDown`                         | Move down one line or note                     | `down`, `j`                  |
| `hunk.review.stepUp`                           | Move up one line or note                       | `up`, `k`                    |
| `hunk.review.toggleHunkGap`                    | Expand or collapse the selected context        | `z`                          |
| `hunk.search.find`                             | Search diff content                            | `/`                          |
| `hunk.search.next`                             | Next search match                              | `n`                          |
| `hunk.search.previous`                         | Previous search match                          | `N`                          |
| `hunk.view.applyFilePresentationToAllMatching` | Apply current file presentation to all matches | _(none)_                     |
| `hunk.view.cursorLineNumber`                   | Mark the current line number                   | _(none)_                     |
| `hunk.view.cursorLineOff`                      | Hide the current-line marker                   | _(none)_                     |
| `hunk.view.cursorLineRow`                      | Highlight the current row                      | _(none)_                     |
| `hunk.view.layoutAuto`                         | Auto layout                                    | `0`                          |
| `hunk.view.layoutSplit`                        | Split layout                                   | `2`                          |
| `hunk.view.layoutUnified`                      | Unified layout                                 | `1`                          |
| `hunk.view.openThemeSelector`                  | Choose theme                                   | `t`                          |
| `hunk.view.toggleAgentNotes`                   | Toggle agent notes                             | `a`                          |
| `hunk.view.toggleCopyDecorations`              | Toggle copy decorations                        | _(none)_                     |
| `hunk.view.toggleFilesPane`                    | Toggle files pane                              | `s`                          |
| `hunk.view.toggleHunkHeaders`                  | Toggle hunk headers                            | `m`                          |
| `hunk.view.toggleLineNumbers`                  | Toggle line numbers                            | `l`                          |
| `hunk.view.toggleLineWrap`                     | Toggle line wrapping                           | `w`                          |
| `hunk.view.toggleMenuBar`                      | Toggle menu bar                                | `M`                          |

The files-pane command follows the named `hunk:files` role. If an extension
replaces that role, the command and **View → Files pane** toggle the resolved
replacement on any terminal edge without changing unrelated panes. Remapping or
unbinding `hunk.view.toggleFilesPane` changes that role-aware action, not an
extension pane's own commands. The former `hunk.view.toggleSidebar` id remains a
compatibility alias; prefer the files-pane name in new config and extension
code. Likewise, `hunk.view.layoutStack` remains a deprecated alias for
`hunk.view.layoutUnified`, so existing keybindings and extension command calls
continue to select the canonical unified layout.

Commands marked _(none)_ ship without a key: they remain callable by command id
and can be assigned a shortcut through `[keybindings]`. Some also appear in a
menu, while semantic commands such as current-line alignment do not need a menu
entry.

The menus and the controls help dialog (`?`) show the keys for the commands they
present, so remapping something changes what they advertise. Unbinding a menu
command keeps its menu item and simply stops showing a key.

Extension commands are named `<extensionId>.<commandId>` and remap the same way
(see [docs/extensions.md](extensions.md)). An explicitly activated extension
keyboard mode is a routing layer rather than a second command table: it may
consume a key, pass it to these resolved bindings, or consume it and exit. Its
multi-key grammar and counts are extension-owned, but resolved actions should
invoke these same public `hunk.*` commands.

Routing precedence is host prompts and dialogs, menus/overlays, focused text
inputs, an interactive file-view mode, a session extension keyboard mode, then
the command table and focused review widget. Keys that belong to a dialog,
menu, or focused text input — `Esc`, `Enter`, `Ctrl-S` while writing a note —
are part of those widgets rather than commands, and are not remappable. Escape
is also the reserved exit from each active extension mode, so an extension
cannot trap the keyboard.

`[keybindings]` is read from your user config only — never from a repository's
`.hunk/config.toml`. Which keys do what is a property of your keyboard and your
habits, so a checkout you review cannot rearrange them.

Ordinary history uses m to select/unselect the focused revision and M to clear selected revisions; Navigate exposes the same actions. Focus, explicit revision selection, and the v/Shift review range remain separate. Space pages and Enter opens the highlighted revision or review range.

Commit > Squash revision… (S) captures the resolved explicit selection once, or the settled highlighted revision when there is no selection or review range, then opens destination choice directly. Checking, failed, or unresolved selection refuses the whole capture. A review range alone is not a Squash source. Selected Into is excluded from the effective sources before provider capability checks. Enter Squash runs the existing provider command when the destination is ready; Escape cancels. Squash has no source picker, Continue, Inspect, or separate confirmation. Selection survives cancellation and completion; after history refresh, actual readback removes only revision IDs proved removed. Surviving selected revisions, including Into, remain selected.

Commit > Rebase revision… (R) retains editable source selection: Space or a primary checkmark click toggles membership, I (or i) inspects the highlighted diff and returns to that selection, and Enter Continue locks a single source before destination choice. PageUp/PageDown and history navigation remain available. Lowercase r opens mark recovery when needed; otherwise it refreshes history. File > Refresh history is available during source selection. Rebase's operation membership clears when its visit ends; destination choice locks edits. Confirmation starts focused on Cancel; Tab/Shift-Tab choose Cancel, Apply or Details, Enter activates the focused choice, and Escape returns to the destination. Rebase offers Onto (o), After (A), Before (B), and the s abandon-if-empty toggle.

Operation results report actual readback and are available again under File > Operation result…. Clean Squash success shows a persistent nonblocking source-count/destination notice: ordinary history keys work immediately, and Esc Dismiss consumes only dismissal. File > Operation result… retains the full actual effects and exact recovery command. Refusals and attention results stay inline, with o Error output for failure diagnostics and r Retry refresh when needed, including a reopened result. Jujutsu owns final-description handling and opens its configured editor only when its native command requires it.
