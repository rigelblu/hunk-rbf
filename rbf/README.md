---
title: hunk-rbf
---

Fork-specific product guidance for Hunk. The upstream project README remains at the repository root.

# 🔵⋯ Versions
- The fork version lives in `rbf/RBF_VERSION` and is reported by `hunk --version`
- The upstream package version remains in the root `package.json` for upstream packaging and synchronization
- Local fork releases update `rbf/RBF_VERSION` and `rbf/CHANGELOG.md` together without rewriting upstream release metadata

# 🔵⋯ Follow terminal appearance
`theme = "system"` and `--theme system` query the controlling terminal background at startup, choose `github-light-default` for light backgrounds and `github-dark-default` for dark backgrounds, and fall back to `github-dark-default` if the terminal does not answer. Existing `auto` values remain accepted as an alias for `system`. If `theme` is absent, Hunk keeps its existing `github-dark-default` default without querying the terminal.

To follow terminal appearance with your own exact built-in themes, configure a complete pair:

```toml
theme = { light = "catppuccin-latte", dark = "nord" }
```

Both members are required and must be built-in theme ids. Each config layer replaces the whole `theme` value, so a later scalar or complete pair wins without inheriting one member from an earlier pair. A missing or unusable terminal response selects the configured dark member. Hunk chooses once at startup; changing terminal appearance while a review is open does not switch it live.

# 🔵⋯ Use multiple named custom themes
Define personal or project-owned palettes in Hunk's normal global or repository config, then select a named id directly or use named ids in the startup appearance pair:

```toml
theme = { light = "my-light", dark = "my-dark" }

[custom_themes.my-light]
base = "github-light-default"
label = "My Light"
background = "#f8f8f8"

[custom_themes.my-dark]
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
[custom_themes.my-light]
base = "github-light-default"
diffAddedColor = "#3daa8e"
diffRemovedColor = "#b4647a"
```

Hunk derives omitted row and word-highlight backgrounds from those colors. Explicit component values such as `addedBg`, `removedBg`, `addedContentBg`, and `removedContentBg` still take precedence. Before terminal output, syntax foregrounds that would fail Hunk's 4.5:1 readability target are adjusted by the smallest passing amount across row, word, selection, interactive, and static review states.

# 🔵⋯ Reuse alpha word-highlight colors
Custom themes accept alpha-last `#RRGGBBAA` values for added and removed word highlights:

```toml
[custom_themes.my-dark]
base = "github-dark-default"
addedContentBg = "#2e9e4859"
removedContentBg = "#78081acc"
```

Hunk composites partial alpha over the actual ordinary or moved diff row, then applies selection and readable foreground contrast. Existing six-digit colors remain exact, and opaque eight-digit colors are accepted anywhere a custom-theme color is valid. Partial alpha is intentionally limited to `addedContentBg` and `removedContentBg`; validation errors name any unsupported key.
