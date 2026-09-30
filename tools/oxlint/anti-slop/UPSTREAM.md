# anti-slop

Owned copy of the anti-slop Oxlint rules. Edit the rules freely; this file records where they came from so upstream fixes can be merged later.

- Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (2026-09-10), MIT.
- Copied from: `skills/install-anti-slop/assets/anti-slop` at that commit. It is identical to upstream `src/` without the `*.test.ts` files, which were not copied.
- Entry points: `index.ts` (`anti-slop`) and `effect/index.ts` (`anti-slop-effect`), registered in the root `vite.config.ts`.
- `vendor/eslint-stylistic/` keeps its own `LICENSE` and `UPSTREAM.md`.

## Local deviations

- Imports use `vite-plus/lint/plugins` instead of `@oxlint/plugins`, so the plugin API always matches the Oxlint bundled with Vite+ and no second pinned package is needed.
- `rules/require-readable-spacing.ts`: consecutive re-exports (`export * from`, `export { x } from`) stay grouped like imports.
- `shared/dictionary-types.ts`: `unsafeMembers[0] ?? null` satisfies this repo's `noUncheckedIndexedAccess`.

To update, check out an upstream revision, diff it against the commit above, and port changes while keeping the deviations listed here.
