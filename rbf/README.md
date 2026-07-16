# hunk-rbf

Fork-specific product guidance for Hunk. The upstream project README remains at the repository root.

## Versions

- The fork version lives in `rbf/RBF_VERSION` and is reported by `hunk --version`.
- The upstream package version remains in the root `package.json` for upstream packaging and synchronization.
- Local fork releases update `rbf/RBF_VERSION` and `rbf/CHANGELOG.md` together without rewriting upstream release metadata.

## Follow terminal appearance

`theme = "system"` and `--theme system` query the controlling terminal background at startup, choose `github-light-default` for light backgrounds and `github-dark-default` for dark backgrounds, and fall back to `github-dark-default` if the terminal does not answer. Existing `auto` values remain accepted as an alias for `system`. If `theme` is absent, Hunk keeps its existing `github-dark-default` default without querying the terminal.

To follow terminal appearance with your own exact built-in themes, configure a complete pair:

```toml
theme = { light = "catppuccin-latte", dark = "nord" }
```

Both members are required and must be built-in theme ids. Each config layer replaces the whole `theme` value, so a later scalar or complete pair wins without inheriting one member from an earlier pair. A missing or unusable terminal response selects the configured dark member. Hunk chooses once at startup; changing terminal appearance while a review is open does not switch it live.
