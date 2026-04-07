# Plan: CLI Identifier Syntax Extension

## Architecture

Replace `parseEcosystem` in `packages/cli/src/registry.ts` with a broader `parseDocSpec` function whose result is a discriminated union:

```ts
type ParsedDocSpec =
  | { kind: 'github', owner: string, repo: string, ref?: string }
  | { kind: 'ecosystem', ecosystem: string, name: string, version: string }
  | { kind: 'name', name: string, version: string }
```

> **Naming collision**: `packages/cli/src/index.ts:76` already defines a private `parseSpec(spec): { name, version }`. The new export from `registry.ts` is named `parseDocSpec` to avoid the collision; the existing local `parseSpec` should be either removed during migration or renamed (e.g. `parseNameVersion`). Resolving this collision is the core of T-2.

The `add` command in `src/index.ts` branches on the parsed `kind`:
- `github` → `getSource('github').fetch({ source: 'github', repo: 'owner/repo', tag: ref, name, version })`, registry skipped
- `ecosystem` / `name` → existing `resolveFromRegistry` path

(`getSource(type)` is a single-arg factory; the actual config is passed to the returned `DocSource.fetch(options)`. See `packages/cli/src/sources/index.ts:54`.)

## Files

| Change | File | Notes |
|---|---|---|
| Modify | `packages/cli/src/registry.ts` | Extend `parseEcosystem` into `parseDocSpec`. Union type, github/ecosystem/name discrimination. |
| Modify | `packages/cli/src/index.ts` | Call `parseDocSpec` in the `add` command; skip registry lookup when `kind === 'github'`. Remove or rename the local `parseSpec`. |
| Add | `packages/cli/test/registry.test.ts` | Unit tests for `parseDocSpec` — every kind plus error cases. |
| Modify | `packages/cli/README.md` | Document the new identifier syntax with examples. |

## Tasks

- **T-1** [test] Write unit tests for `parseDocSpec` — github/ecosystem/name branches plus invalid input
- **T-2** [impl] Implement `parseDocSpec`, migrate `parseEcosystem` callers, resolve the `parseSpec` collision in `index.ts` (remove or rename the existing local function)
- **T-3** [impl] Add the github fast-path branch to the `add` command, calling `getSource('github').fetch(...)` and skipping the registry lookup
- **T-4** [test] End-to-end smoke test for `ask docs add vercel/next.js` (real network or mocked)
- **T-5** [docs] Add a new syntax section to README
- **T-6** [chore] Regression test — verify the 6 existing registry entries still resolve

## Risks

- The `owner/repo` pattern could collide with future aliases like `org/team-name` → restrict strictly to "exactly one slash, no colon"
- `@ref` looks identical to npm dist-tags (`@canary`) → in github mode it is always interpreted as a git ref; ecosystem mode is fully disambiguated by the prefix

## Dependencies

- None. Independently shippable.
- Can run in parallel with `registry-meta-20260407` and `ecosystem-resolvers-20260407`.
