# Plan: Monorepo Tag Pattern Support

> Track: monorepo-tag-pattern-20260413
> Spec: [spec.md](./spec.md)

## Overview
- **Source**: /please:plan
- **Track**: monorepo-tag-pattern-20260413
- **Created**: 2026-04-13
- **Approach**: Cascade tag resolution — npm metadata inference → static fallback chain → git ls-remote probe

## Purpose

Enable `ask src` and `ask install` to resolve monorepo packages (vercel/ai, tanstack/*, trpc, effect, etc.) that use `<pkg>@<version>` tag patterns instead of `v<version>`.

## Context

The npm resolver (`resolvers/npm.ts`) returns `ref: v{version}` and `fallbackRefs: [{version}]`, but:
1. `ensure-checkout.ts` drops `fallbackRefs` — only passes `ref` to `GithubSource`
2. `GithubSourceOptions` has no `fallbackRefs` field
3. `refCandidates()` in `github.ts` only tries `[ref]` or `[ref, v{ref}]`
4. Monorepo tags like `ai@6.0.158` are never attempted

## Architecture Decision

**Cascade strategy with 4 layers**, each adding candidates only when prior layers are insufficient:

1. **npm metadata inference** (NpmResolver): Read `repository.directory` from npm registry — if present, package is in a monorepo. Generate `<pkgName>@<version>` and `<pkgName>@v<version>` as additional `fallbackRefs`.
2. **Plumbing** (ensure-checkout → GithubSourceOptions): Thread `fallbackRefs` through to the github source.
3. **Static candidate chain** (refCandidates): Merge `fallbackRefs` into the candidate list. Order: `[...fallbackRefs, ref, v{ref}]` — monorepo candidates first since they're more specific.
4. **Dynamic probe** (git ls-remote): Last resort when all static candidates fail. Query `git ls-remote --tags <repo>` filtered by version string, pick the best match.

This approach minimizes network overhead (metadata is already fetched; ls-remote only fires on total miss) and is backward-compatible (no `fallbackRefs` = existing behavior).

## Tasks

- [ ] T001 [P] Extend NpmResolver to detect monorepo and generate pkg-name fallbackRefs (file: packages/cli/src/resolvers/npm.ts)
  - Read `repository.directory` from npm metadata
  - If present, add `<pkgName>@<version>` and `<pkgName>@v<version>` to `fallbackRefs`
  - Acceptance: NpmResolver.resolve('ai', '6.0.158') returns fallbackRefs containing 'ai@6.0.158'
  - Tests: packages/cli/test/resolvers/npm.test.ts

- [ ] T002 [P] Add fallbackRefs to GithubSourceOptions (file: packages/cli/src/sources/index.ts)
  - Add optional `fallbackRefs?: string[]` field to `GithubSourceOptions`
  - Acceptance: Type compiles, no runtime behavior change yet
  - Tests: type-level only

- [ ] T003 Thread fallbackRefs from ensure-checkout to GithubSource (file: packages/cli/src/commands/ensure-checkout.ts) (depends on T002)
  - Pass `result.fallbackRefs` from resolver result into `GithubSourceOptions`
  - Acceptance: ensureCheckout passes fallbackRefs through to fetcher.fetch()
  - Tests: packages/cli/test/commands/ensure-checkout.test.ts

- [ ] T004 Expand refCandidates() and cloneAtTag() to use fallbackRefs (file: packages/cli/src/sources/github.ts) (depends on T002)
  - Modify `refCandidates()` to accept optional extra candidates
  - `GithubSource.fetch()` reads `opts.fallbackRefs` and passes them through
  - Store-hit loop also checks fallbackRef candidates
  - `fetchFromTarGz` iterates expanded candidates
  - Acceptance: GithubSource tries ai@6.0.158 before giving up
  - Tests: packages/cli/test/sources/github.test.ts

- [ ] T005 Add git ls-remote fallback probe (file: packages/cli/src/sources/github.ts) (depends on T004)
  - When all static candidates fail in cloneAtTag(), run `git ls-remote --tags <repo>` filtered by version
  - Parse output to find matching tag (prefer exact `*@<version>` match)
  - Single network call, gated by `hasGit()`
  - Acceptance: discovers `ai@6.0.158` tag when static candidates miss
  - Tests: packages/cli/test/sources/github.test.ts

- [ ] T006 Integration test with real monorepo package (file: packages/cli/test/sources/github-monorepo.test.ts) (depends on T001, T003, T004, T005)
  - End-to-end test: NpmResolver + GithubSource for a monorepo package
  - Verify no regression for standard v-prefixed repos
  - Tests: new test file

## Key Files

| File | Role |
|------|------|
| `packages/cli/src/resolvers/npm.ts` | npm resolver — monorepo detection + fallbackRefs generation |
| `packages/cli/src/resolvers/index.ts` | ResolveResult type (already has fallbackRefs) |
| `packages/cli/src/sources/index.ts` | GithubSourceOptions type — add fallbackRefs |
| `packages/cli/src/sources/github.ts` | refCandidates(), cloneAtTag(), GithubSource.fetch() |
| `packages/cli/src/commands/ensure-checkout.ts` | Plumbing: resolver → source |

## Verification

1. `bun run --cwd packages/cli build` — TypeScript compiles
2. `bun run test` — all tests pass
3. `bun run lint` — no lint errors
4. Manual: `bunx @pleaseai/ask src npm:ai` resolves successfully
5. Manual: `bunx @pleaseai/ask src npm:react` still works (regression check)

## Progress

| Phase | Status |
|-------|--------|
| T001 NpmResolver monorepo detection | ⬜ pending |
| T002 GithubSourceOptions type | ⬜ pending |
| T003 ensure-checkout plumbing | ⬜ pending |
| T004 refCandidates expansion | ⬜ pending |
| T005 git ls-remote fallback | ⬜ pending |
| T006 Integration test | ⬜ pending |

## Decision Log

- Candidate order: `[...fallbackRefs, ref, v{ref}]` — monorepo-specific candidates first, since `v{version}` is already tried last by existing logic
- git ls-remote probe runs only after all static candidates fail (NFR-1: at most one extra network call)
- Scoped packages (e.g. `@vercel/ai`): use unscoped name for tag pattern (`ai@6.0.158`, not `@vercel/ai@6.0.158`) per changesets convention

## Surprises & Discoveries

- `fallbackRefs` was already defined in `ResolveResult` but never plumbed through to GithubSource
- NpmResolver already fetches full registry metadata but ignores `repository.directory`
- tar.gz fallback path in `fetchFromTarGz` only tries the original ref, not even the `v{ref}` fallback
