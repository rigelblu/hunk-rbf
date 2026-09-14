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
