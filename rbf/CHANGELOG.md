---
title: Changelog
---

Fork releases use the version in `rbf/RBF_VERSION`; upstream release history remains in the root `CHANGELOG.md`.

# 🔵⋯ [Unreleased]

## 🟠⋯ Fixed for Technical Users

- 2026-09-14 - doc (fix technical) | the generated config reference lists the `custom_theme.diffAddedColor` and `custom_theme.diffRemovedColor` keys the fork added, so the website check passes again (#hk-13)
- 2026-09-14 - ci (fix technical) | `rbf/scripts/upstream-sync.sh` runs `check:docs` in its default verify command, so a sync can't pass with stale generated docs (#hk-13)

---

# 🔵⋯ v0.8.0 (2026-09-14)

## 🟠⋯ 🚨 Breaking Changes for End Users

- 2026-09-14 - feat (BREAKING ux) | compare two files inside a jj repository with `hunk diff --files <a> <b>` — there, `hunk diff <a> <b>` now compares two revisions (#hk-13)
- 2026-09-14 - feat (BREAKING ux) | press `1` for the unified layout and `2` for split, and read `unified` where the layout used to say `stack` — `mode = "stack"` still works (#hk-13)

## 🟠⋯ Added for End Users

- 2026-09-14 - big feat (ux) | use upstream Hunk 0.22.0 plus ten unreleased upstream commits (`ee556ac8`), with every Hunk RBF feature working as before (#hk-13)
- 2026-09-14 - feat (ux) | find text in a review with `/` search (#hk-13)
- 2026-09-14 - feat (ux) | browse history in the redesigned `hunk log`, with its menu and theme picker (#hk-13)
- 2026-09-14 - feat (ux) | see review status and answer inline prompts in the new status line (#hk-13)
- 2026-09-14 - feat (ux) | set how far the mouse wheel scrolls (#hk-13)
- 2026-09-14 - feat (ux) | check or restart the session daemon with `hunk daemon status` and `hunk daemon restart` (#hk-13)
- 2026-09-14 - feat (ux) | read syntax-highlighted code in extension file views (#hk-13)

## 🟠⋯ Improved for End Users

The sync changed these Hunk RBF behaviors to fit upstream's new code. Their commits keep their original messages, so this list records what each one does now.

- 2026-09-14 - feat (improve ux) | a review opened from `hunk log` follows macOS appearance with your light/dark pair, unless you picked a theme or passed `hunk log --theme`; the history list itself uses the pair's dark theme — ported in `hk-3` and `hk-1` (#hk-13)
- 2026-09-14 - feat (improve ux) | a custom theme's word-highlight backgrounds come from its explicit `addedContentBg` or `removedContentBg`, then from `diffAddedColor` or `diffRemovedColor`, then from its base theme's upstream-tinted backgrounds — ported in `hk-6` (#hk-13)
- 2026-09-14 - feat (improve ux) | highlighted code keeps 4.5:1 contrast on the extension current line under `--transparent-background`, and text an extension dims on purpose can drop to upstream's 1.6:1 floor — ported in `hk-6` (#hk-13)
- 2026-09-14 - feat (improve ux) | diff signs keep Hunk RBF's 1%-step contrast rescue instead of upstream's 2% steps, so 10 of 65 built-in themes differ from upstream by at most 4 RGB units in sign-derived colors — ported in `hk-6` (#hk-13)

## 🟠⋯ Fixed for End Users

- 2026-09-14 - fix (ux) | a light/dark pair keeps following macOS appearance after `r`, a watch reload, or returning from the editor — before, the first refresh froze it — ported in `hk-3` (#hk-13)
- 2026-09-14 - fix (ux) | Hunk exits cleanly when its terminal disconnects, instead of exiting 1 while turning focus reporting off — ported in `hk-3` (#hk-13)

## 🟠⋯ 🚨 Breaking Changes for Technical Users

- 2026-09-14 - feat (BREAKING technical) | extensions receive `theme_changed` only when the user commits a theme, as upstream documents — an appearance switch no longer sends it — ported in `hk-3` (#hk-13)

## 🟠⋯ Improved for Technical Users

- 2026-09-14 - feat (improve technical) | an extension line mark that sets a background replaces the alpha word overlay, and a dim mark keeps it — ported in `hk-7` (#hk-13)

---

# 🔵⋯ v0.7.0 (2026-08-24)

## 🟠⋯ 🚨 Breaking Changes for Technical Users

- 2026-08-24 - feat (technical) | read either version from a script without a bare semver to parse — no version command prints one any more; take the first field after `hunk` for upstream, or the `Hunk RBF` parenthetical for the fork (#hk-10)

## 🟠⋯ Added for End Users

- 2026-08-24 - feat (ux) | see both upstream compatibility and fork release identity when I check the version (#hk-10)

---

# 🔵⋯ v0.6.0 (2026-08-23)

## 🟠⋯ 🚨 Breaking Changes for End Users

- 2026-08-23 - config (technical) | rename `[custom_themes.<id>]` tables to the upstream-native `[themes.<id>]` form (#hk-9)

## 🟠⋯ Fixed for Technical Users

- 2026-08-23 - fix (technical) | report the fork release version instead of the upstream package version

---

# 🔵⋯ v0.5.0 (2026-07-22)

## 🟠⋯ Added for End Users

- 2026-07-22 - feat (ux) | keep appearance-following themes synchronized with macOS light and dark mode while a review stays open (#hk-3)

---

# 🔵⋯ v0.4.0 (2026-07-22)

## 🟠⋯ Added for End Users

- 2026-07-22 - feat (ux) | reuse editor alpha-last colors for added and removed word highlights without manually flattening them (#hk-7)

## 🟠⋯ Improved for Technical Users

- 2026-07-22 - config (technical) | accept opaque eight-digit colors across custom themes and role-aware partial alpha for word highlights (#hk-7)

---

# 🔵⋯ v0.3.0 (2026-07-22)

## 🟠⋯ Improved for End Users

- 2026-07-22 - feat (ux) | keep custom-theme syntax readable across derived row, word, and selection highlights (#hk-6)

## 🟠⋯ Added for Technical Users

- 2026-07-22 - config (technical) | derive omitted add and remove surfaces from semantic theme colors while preserving explicit overrides (#hk-6)

---

# 🔵⋯ v0.2.1 (2026-07-22)

## 🟠⋯ Added for Builders

- 2026-07-22 - data (ux) | compare a personal light/dark theme pair against the same focused review fixture (#hk-5)

---

# 🔵⋯ v0.2.0 (2026-07-22)

## 🟠⋯ Added for End Users

- 2026-07-22 - feat (ux) | load multiple named custom themes and use them directly or in a light/dark pair (#hk-2)

---

# 🔵⋯ v0.1.0 (2026-07-16)

## 🟠⋯ Added for End Users

- 2026-07-22 - feat (ux) | open each review in the chosen light or dark theme for the current terminal appearance (#hk-1)

## 🟠⋯ Improved for Technical Users

- 2026-07-22 - config (technical) | identify the installed fork release independently from upstream Hunk
