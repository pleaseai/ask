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

## Outcomes & Retrospective

### What Was Shipped

- `parseDocSpec` discriminated union in `packages/cli/src/registry.ts` covering `github` / `ecosystem` / `name` shapes
- github fast-path branch in `packages/cli/src/index.ts` `add` command — skips registry lookup entirely when input matches `owner/repo[@ref]`
- 25 unit tests (16 shape tests + 9 regression tests for the 6 shipped registry entries)
- README updated with the identifier-syntax table
- PR #10

### What Went Well

- Clean separation: `parseDocSpec` is pure, no I/O, fully unit-testable
- The `parseSpec` collision the plan worried about did not materialize because the new export was named `parseDocSpec`; the local helper kept its name unchanged
- Regression test (T-6) is enumerated, not derived — surfaces immediately if a future registry entry accidentally matches the github shape

### What Could Improve

- `parseEcosystem` is now redundant in the `add` flow (parseDocSpec handles its job) but kept for caller compatibility — could be removed in a follow-up
- T-4 real-network smoke test deferred — should be added once an offline-friendly fixture or mocked github source is available

### Tech Debt Created

- `parseEcosystem` redundancy in `registry.ts` (low priority, isolated)
- `parseSpec` local helper in `index.ts` is now only used by the `remove` command — candidate for inlining
