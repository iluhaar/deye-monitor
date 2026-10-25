# Vendored anti-slop

- Source: https://github.com/dmmulroy/anti-slop
- Revision: `13909c9e07590f5a85d93c62712259fe14a883f7`
- Imported: 2026-10-25
- Copied from: `skills/install-anti-slop/assets/anti-slop/`
- License: MIT; see `LICENSE`.

The generic and Effect plugin entry points are registered in
`server/.oxlintrc.json`. All 18 generic rules and all five Effect rules are
enabled, along with native `oxc/no-accumulating-spread`.

Oxlint and `@oxlint/plugins` are pinned together at `1.89.0` in the server's
development dependencies. Vendored source is excluded from application linting.
The `vendor/eslint-stylistic/` subtree retains its own license and provenance.

No rule-source customizations were made during installation. Compare local
changes against this revision before updating; do not overwrite customizations
blindly.
