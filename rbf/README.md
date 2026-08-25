---
title: hunk-rbf
---

Fork-specific product guidance for Hunk. The upstream project README remains at the repository root.

# 🔵⋯ Versions

`hunk --version`, `hunk -v`, and `hunk version` all print the same single line, naming both identities:

```text
$ hunk --version
hunk 0.19.0 (Hunk RBF 0.7.0)
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
- The upstream package version remains in the root `package.json` for upstream packaging and synchronization
- Local fork releases update `rbf/RBF_VERSION` and `rbf/CHANGELOG.md` together without rewriting upstream release metadata

# 🔵⋯ Follow appearance

`theme = "system"` and `--theme system` choose `github-light-default` for light appearance and `github-dark-default` for dark appearance. On macOS, Hunk treats the system appearance as authoritative and switches an open review live when macOS changes between light and dark. Elsewhere, or when native appearance is unavailable, Hunk follows the controlling terminal background. Existing `auto` values remain accepted as an alias for `system`. If `theme` is absent, Hunk keeps its existing `github-dark-default` default without following appearance.

To follow appearance with your own exact built-in themes, configure a complete pair:

```toml
theme = { light = "catppuccin-latte", dark = "nord" }
```

Both members are required and must be built-in theme ids. Each config layer replaces the whole `theme` value, so a later scalar or complete pair wins without inheriting one member from an earlier pair. Hunk switches between the configured members as the authoritative appearance changes. A failed native refresh keeps the last known appearance; when neither native nor terminal appearance is available at startup, Hunk selects the configured dark member.

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
hunk diff test/fixtures/themes/rose-pine/before.ts test/fixtures/themes/rose-pine/after.ts
```

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
