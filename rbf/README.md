---
title: hunk-rbf
---

Fork-specific product guidance for Hunk. The upstream project README remains at the repository root.

# 🔵⋯ Versions

`hunk --version`, `hunk -v`, and `hunk version` all print the same single line, naming both identities:

```text
$ hunk --version
hunk 0.23.0 (Hunk RBF 0.12.0)
```

The first number is the upstream Hunk release this fork is built against. The parenthetical is the fork's own release. They advance independently, so neither is "ahead" of the other — quote the whole line in a bug report and it says exactly which build you have.

If one source is malformed, only that value reads `0.0.0-unknown`. The other still shows its real version, and neither ever substitutes for the other.

## 🟠⋯ Reading a version from a script

**From `v0.7.0` on, no version command prints a bare semver.** A script that runs `hunk --version` and compares the output to a version number will stop matching. There is no flag to restore the old shape; read the value you want instead:

| What you want                          | How to read it                                                  |
| :------------------------------------- | :-------------------------------------------------------------- |
| Upstream compatibility version         | `hunk --version \| awk '{print $2}'`                            |
| Fork release, from an installed binary | `hunk --version \| awk -F'Hunk RBF ' '{print $2}' \| tr -d ')'` |
| Fork release, inside a checkout        | `cat rbf/RBF_VERSION`                                           |

The middle read is the one to use when all you have is the binary — an installed Hunk RBF does not ship `rbf/RBF_VERSION`.

One known consequence: the upstream `install.sh` already-current check reduces this line to a value that never matches a bare version, so it re-downloads instead of skipping. It prints no error and installs correctly; it just does redundant work. Hunk RBF is installed with `bun run install:bin`, so this affects only an upstream installer pointed at a fork binary.

## 🟠⋯ Where each version lives

- The fork release version lives in `rbf/RBF_VERSION`
- The upstream package version lives in `packages/hunk/package.json`, which upstream owns for its packaging and synchronization
- Local fork releases update `rbf/RBF_VERSION` and `rbf/CHANGELOG.md` together without rewriting upstream release metadata

# 🔵⋯ Focus JJ working history

Ordinary `hunk log --vcs jj` keeps the configured JJ `trunk()` revision and work on every
visible branch while hiding older mainline ancestry. Protected branches and branches based
before mainline remain visible. Filters and limits narrow that working history.

Each deliberately omitted direct parent ends with a nonselectable `~` row. The explanation
`~ older history hidden` appears once above the status line, or after static output. Graph
mode preserves the connection; the ordinary timeline shows the same markers. If an entry
is taller than the window, use Page Up/Down or the mouse wheel to scroll its cutoff rows.
Arrow keys still select real commits, and Enter compares the selected commit with its real parent.

When `trunk()` has no usable revision or resolves to several revisions, Hunk shows visible
history and keeps an unavailable or ambiguous explanation above the status line. Static
output writes it once to stderr, including when filters produce no commits. Invalid JJ
configuration and process/read failures remain errors. A failed refresh retains the previous
rows and their explanation.

Use `hunk log --vcs jj --all` for full visible ancestry, or pass a revision/revset explicitly
to inspect its ancestry. Those explicit requests keep their previous behavior. Git and
Sapling history are unchanged. HK-93 is recorded in the local Hunk RBF 0.11.0 release; installation and remote publication remain pending.

# 🔵⋯ Start history auto-refresh from config

Put `history_auto_refresh = true` at the top level of `~/.config/hunk/config.toml` or a repository's `.hunk/config.toml` to start interactive `hunk log` with automatic refresh on. The built-in default is off. Repository config takes precedence over user config. Write the key above the first `[table]` header in the file: below a header, TOML assigns it to that table, where Hunk ignores it or rejects it.

F10 can turn automatic refresh on or off for the current log session without changing either config file. This setting applies only to interactive history; review `watch` is separate. If a history provider cannot report changes, manual Refresh remains available.

# 🔵⋯ Follow appearance

`theme = "system"` and `--theme system` choose `github-light-default` for light appearance and `github-dark-default` for dark appearance. On macOS, Hunk treats the system appearance as authoritative and switches an open review live when macOS changes between light and dark. Elsewhere, or when native appearance is unavailable, Hunk follows the controlling terminal background. Existing `auto` values remain accepted as an alias for `system`. If `theme` is absent, Hunk keeps its existing `github-dark-default` default without following appearance.

To follow appearance with your own exact built-in themes, configure a complete pair:

```toml
theme = { light = "catppuccin-latte", dark = "nord" }
```

Both members are required and must name available themes, including built-in, named custom, and `terminal` themes. Each config layer replaces the whole `theme` value, so a later scalar or complete pair wins without inheriting one member from an earlier pair. Hunk switches between the configured members as the authoritative appearance changes. A failed native refresh keeps the last known appearance; when neither native nor terminal appearance is available at startup, Hunk selects the configured dark member.

# 🔵⋯ Configure the history theme

`hunk log` reads the root `theme` value from global and repository configuration. A `[show]` theme applies to `hunk show` and leaves history's palette unchanged. A review opened from history keeps the theme history is showing. An explicit `hunk log --theme <id>` takes precedence over configuration.

For example, this configuration opens history and the reviews opened from it in Nord, and `hunk show` in GitHub Dark Dimmed:

```toml
theme = "nord"

[show]
theme = "github-dark-dimmed"
```

History retains its existing startup behavior for complete appearance pairs: it selects the configured dark member. Press `t` to inspect or change the active history theme. Color suppression, including `--color never`, still applies.

# 🔵⋯ Use the terminal palette

Set `theme = "terminal"` or pass `--theme terminal` to draw from the terminal's foreground, background, and ANSI palette. Palette notifications and window resizes refresh those colors during the session, including changes between two palettes with the same light/dark mode. Terminals that do not answer color queries use a bounded xterm-style fallback palette.

A complete appearance pair can include `terminal`. Successful macOS reads choose the pair member; the terminal member draws from the terminal's actual colors even when its palette differs from macOS appearance. Later native read failures keep the last native mode. A theme accepted in the picker overrides the configured preference until quit; automatic appearance changes do not create a preference-save request.

# 🔵⋯ Use multiple named custom themes

Define personal or project-owned palettes in Hunk's normal global or repository config, then select a named id directly or use named ids in the startup appearance pair:

```toml
theme = { light = "my-light", dark = "my-dark" }

[themes.my-light]
base = "github-light-default"
label = "My Light"
background = "#f8f8f8"

[themes.my-dark]
base = "github-dark-default"
label = "My Dark"
background = "#181818"
```

Named ids appear in the theme selector and work anywhere a theme id is accepted. Global and repository definitions merge field-by-field, with repository values taking precedence. Custom themes inherit only from built-in themes. The existing singular `[custom_theme]` table and `theme = "custom"` remain supported.

# 🔵⋯ Dogfood a personal light/dark pair

Use the focused theme fixture to compare both members of a personal pair against the same review:

```sh
hunk diff --files test/fixtures/themes/rose-pine/before.ts test/fixtures/themes/rose-pine/after.ts
```

Inside a jj repository, `hunk diff <a> <b>` compares two revisions, so `--files` is what compares two files.

Press `t` to select each named theme, then inspect diff meaning, selection, line numbers, and syntax in light and dark terminal appearances. Keep personal palette values in user configuration rather than copying them into Hunk source or release artifacts.

# 🔵⋯ Derive readable diff surfaces

Named custom themes can provide semantic add and remove colors instead of hand-tuning every diff surface:

```toml
[themes.my-light]
base = "github-light-default"
diffAddedColor = "#3daa8e"
diffRemovedColor = "#b4647a"
```

Hunk derives omitted row and word-highlight backgrounds from those colors. Explicit component values such as `addedBg`, `removedBg`, `addedContentBg`, and `removedContentBg` still take precedence. Before terminal output, syntax foregrounds that would fail Hunk's 4.5:1 readability target are adjusted by the smallest passing amount across row, word, selection, interactive, and static review states.

# 🔵⋯ Reuse alpha word-highlight colors

Custom themes accept alpha-last `#RRGGBBAA` values for added and removed word highlights:

```toml
[themes.my-dark]
base = "github-dark-default"
addedContentBg = "#2e9e4859"
removedContentBg = "#78081acc"
```

Hunk composites partial alpha over the actual ordinary or moved diff row, then applies selection and readable foreground contrast. Existing six-digit colors remain exact, and opaque eight-digit colors are accepted anywhere a custom-theme color is valid. Partial alpha is intentionally limited to `addedContentBg` and `removedContentBg`; validation errors name any unsupported key.

# 🔵⋯ Empty JJ revisions

Since Hunk RBF 0.10.0, Hunk shows `(empty)` before a JJ revision's description in interactive, compact, and medium history. JJ reports whether the whole revision contributes changes against its auto-merged parents. A described revision can be empty; an undescribed revision can contain changes. Ref, graph, and ASCII controls leave the empty label visible.

Git reporting remains unknown in this slice. Hunk RBF product work covers JJ and Git; Sapling is out of scope.

# 🔵⋯ Identify workspace heads in JJ history

Run `hunk log --vcs jj` to see where each workspace's recorded head sits in history. The default view labels every workspace head it includes; add `--all` to reach heads on the older history that view hides. Repositories with multiple workspaces show names such as `@default` and `@feature` on their revisions. A repository with one workspace shows only the current-revision marker `@`.

Run `hunk log --vcs jj --all` to see where each workspace's recorded head sits in history. Repositories with multiple workspaces show names such as `@default` and `@feature` on their revisions. A repository with one workspace shows only the current-revision marker `@`.

Several workspace names can share a revision. The separate `@` marker identifies the current revision; it does not identify which named workspace opened Hunk. A recorded head can be stale, so its label does not mean someone is actively working there.

Interactive history uses two rows normally. Workspace names fit beside author/time when possible, with a separate current/bookmark group such as `(@, main)`. Names that need more space use one extra row, shared with any real graph join. Plain graph continuations add no row. An ending `…` marks a clipped list. **View → Decorations** controls their visibility. Press `r` to refresh, or enable **File → Auto-refresh history** to follow workspace moves. Refresh keeps the focused revision near its previous screen row; press **Home** to see new commits above it.

`hunk log --vcs jj --static` uses the existing scrollback format. Terminal output fits the terminal width; output piped to a file includes every name.

# 🔵⋯ Edit the active JJ revset

In interactive `hunk log --vcs jj`, history shows the complete revset above the list, with the mode and the row limit:

```text
Revset: (((trunk()..visible_heads()) | trunk()) ~ root())
Launch policy · Limit: 100
```

Press `L`, or choose **View → Edit revset…**, to edit that revset. `F2` applies it exactly as written: no hidden author, date or path filters and no extra ancestry are added, and the row limit from `-n` stays separate. Applying text that has not changed closes the editor and changes nothing. `F3` restores the launch policy, including the mainline default and its fallback. `Esc`, `Ctrl-C` or a click outside cancels, and none of them quits Hunk from the editor. While a revset is being applied or restored, the first `Esc` or `Ctrl-C` aborts it and keeps your draft; a second one closes the editor.

Revsets you applied earlier in this session are listed under **Previous inputs**, newest first. `Tab`/`Shift+Tab`, `Up`/`Down` or `Ctrl-N`/`Ctrl-P` highlight one, and `Enter` inserts it into the field without applying it; `Enter` with nothing highlighted applies the field. The list holds up to 50 revsets, survives opening a diff from history and returning, and is cleared when you quit. Nothing is saved to disk. A failed apply, a Reset and the launch revset are not added.

If JJ rejects a revset, the editor stays open with your draft and shows JJ's reason as `Revset not applied: …`, without the source-diagram rows; `PgUp`/`PgDn` scroll a long reason. History behind the editor does not change.

After a successful apply, focus stays on the revision you had selected if it is among the first rows of the new result; otherwise the newest row is selected and the status line says `Selected newest; previous not loaded.` While a custom revset is active, history draws no graph links, and range selection and range review are unavailable (`Custom revset: graph links and range review unavailable.`), because a custom set can leave out commits between two rows. **Reset** brings both back. On terminals shorter than 15 rows, launch policy adds nothing to the history screen, and a custom revset adds one `Custom revset: …` row.

Other providers do not offer the editor. Completion of revset functions, aliases and names is not part of this change.

# 🔵⋯ Select revisions for Squash or Rebase

In interactive `hunk log --vcs jj`, choose **Commit → Squash revision…** (`S`) or **Rebase revision…** (`R`). The highlighted revision starts selected. Press **Space** or click its checkmark to select or unselect an exact revision. Ctrl-click also toggles a source, including on the revision ID and copy icon. The checkmark shows membership; `>` shows the highlighted row. Selecting keeps your highlight and any review range in place.

Press **I** or **i** to inspect the highlighted revision's diff. Close that review to return to the same selection and reading position. **Enter Continue** advances with one selected, resolved source. No selection and multiple selections show a reason and cannot continue. **Esc Cancel** ends the operation selection. Ordinary history retains Space paging and Enter highlighted or contiguous-range review.

In the destination view, highlight a different loaded revision and press **Enter Preview**. Rebase offers **o Onto**, **A After** and **B Before**. The preview shows the source, destination, descriptions, warnings and predicted effects. **Details** shows the full provider facts. When the body overflows, its line indicator shows **↑↓ / PgUp / PgDn Scroll**; Home and End reach the first and last lines. Confirmation starts on **Cancel**; use Tab or click to choose **Apply**. Cancelling the confirmation returns to the destination with the same sources. A changed final preview needs another explicit confirmation.

For Rebase, **s** toggles **Abandon the moved revision if this empties it**; it starts off each time. JJ decides which protected revisions a placement would rewrite. The result reports the operation that actually ran and its readback, including failures and unexpected effects. Reopen it with **File → Operation result…**. Its reversal command is conditional on that operation remaining the latest; other tools can change the repository.

Refresh preserves exact source IDs first. In a complete, unlimited, unfiltered, unchanged history scope, a unique logical change ID can preserve a rewritten revision. A revision expression or `--first-parent` prevents that rewrite following. Missing, ambiguous or incompletely checked sources block Continue; **r Review marks** lets you inspect or explicitly remove unresolved marks. While source selection is ready, **r** refreshes history. Automatic refresh waits during an operation, and source edits/query changes/refresh remain locked after Continue until the operation settles or you cancel it. Sources live only in this running session.

Providers without the mutation capability report that Squash/Rebase are unavailable. Extension API 33 adds typed mutation preparation, confirmed-handle Apply, disposal and actual-result reporting. Existing providers keep their history and review behavior.
