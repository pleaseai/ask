# Default deny-list — packages excluded from `setup-docs` by default

`setup-docs` reads this file and drops any dependency whose name matches one
of the patterns below **before** showing the confirmation plan. The goal is
to keep `AGENTS.md` focused on libraries an AI agent will actually reference
when writing application code — not on the toolchain that builds or lints it.

Matching is glob-style (`*` = any characters, `?` = one character). Matching
is applied to the **package name** (not version), case-sensitive, and works
across ecosystems — entries that are npm-specific (`@types/*`) simply don't
match non-npm names.

Users can always override:

- `include-dev` — also pulls in `devDependencies` / dev-scope equivalents
  (still subject to the deny-list below).
- `include <name>` — force-include a specific package from any skipped
  bucket. Works whether the package was dropped by the deny-list, by the
  default dev/peer-deps exclusion, or both. Comma-separated names are
  allowed: `include foo,bar`.
- `all` — disable the deny-list **and** include `devDependencies` /
  `peerDependencies` in a single shot. Use when you explicitly want the
  previous exhaustive behavior.

## Categories

### Type-only packages

AI agents read types from the compiler, not from a separate docs tarball.

- `@types/*`

### Linters / formatters / style

The tool itself rarely needs docs at code-writing time. If the user is
writing an ESLint plugin or a Prettier config, they will ask for
`add-docs eslint` explicitly.

- `eslint`
- `eslint-*`
- `eslint-config-*`
- `eslint-plugin-*`
- `@eslint/*`
- `@typescript-eslint/*`
- `@stylistic/*`
- `@antfu/eslint-config`
- `prettier`
- `prettier-plugin-*`
- `@prettier/*`
- `biome`
- `@biomejs/*`
- `stylelint`
- `stylelint-*`
- `dprint`
- `rome`

### Build tools / bundlers / transpilers

- `vite`
- `@vitejs/*`
- `webpack`
- `webpack-*`
- `rollup`
- `rollup-*`
- `@rollup/*`
- `esbuild`
- `esbuild-*`
- `tsup`
- `unbuild`
- `parcel`
- `@parcel/*`
- `turbo`
- `nx`
- `@nx/*`
- `tsx`
- `ts-node`
- `typescript` (types come from the compiler itself)
- `swc`
- `@swc/*`
- `babel`
- `@babel/*`
- `babel-*`

### Test runners / testing libraries

- `vitest`
- `@vitest/*`
- `jest`
- `@jest/*`
- `jest-*`
- `ts-jest`
- `mocha`
- `ava`
- `tap`
- `node-tap`
- `@testing-library/*`
- `playwright`
- `@playwright/test`
- `cypress`

### Git hooks / commit tooling / release automation

- `husky`
- `lint-staged`
- `commitlint`
- `@commitlint/*`
- `release-please`
- `release-please-*`
- `semantic-release`
- `@semantic-release/*`
- `changeset`
- `@changesets/*`

### Polyfills / runtime shims

- `core-js`
- `core-js-*`
- `regenerator-runtime`
- `tslib`

## How to extend

If you keep hitting the same noisy package in multiple projects, append it
to the relevant category above. Keep the list sorted within each section
alphabetically to make diffs easy to review.

If a user reports that a denied package actually does need docs in their
workflow, don't silently edit the list — tell them to pass `include <name>`
so the decision stays explicit and project-scoped.
