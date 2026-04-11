# Plan: Lazy `ask src` and `ask docs` Commands

> Track: lazy-ask-src-docs-20260411
> Spec: [spec.md](./spec.md)

## Overview

- **Source**: /please:plan
- **Track**: lazy-ask-src-docs-20260411
- **Issue**: (pending)
- **Created**: 2026-04-11
- **Approach**: Pure consumer of existing infrastructure. Two new commands in a new `commands/` subdirectory; zero changes to existing fetch/store/lock/atomic-write code.

## Purpose

Expose ASK's existing global GitHub checkout cache (`~/.ask/github/checkouts/<o>__<r>/<ref>/`) through two new lazy CLI commands so coding agents can do ad-hoc source/docs exploration without needing entries in `ask.json`. Both commands fetch on cache miss using the existing `GithubSource.fetch()` pipeline (which already handles bare-clone reuse, atomic writes, and tar.gz fallback) and emit absolute paths suitable for shell substitution `$(ask src react)`.

## Context

The existing eager pipeline (`ask install`/`ask add`) handles the declarative use case: "these are the libraries my project depends on, vendor their docs into `.ask/docs/` and list them in AGENTS.md". The lazy use case — "the agent just hit an unknown library and wants to look at it for one minute" — is currently unsupported.

After 12 turns of design discussion against the vendored opensrc submodule (`vendor/opensrc/`, analyzed in `.please/docs/references/opensrc.md`), we confirmed:

- ASK's `~/.ask/` global store already holds full GitHub checkouts (verified at `packages/cli/src/sources/github.ts:123-149`)
- The bare-clone-shared-across-refs pattern (`packages/cli/src/store/github-bare.ts:32-37`) is more sophisticated than opensrc's per-ref shallow clones
- Atomic writes, file locks, and content hashing already exist in `packages/cli/src/store/index.ts`
- 8 ecosystem resolvers already extract `owner/repo` from upstream metadata in `packages/cli/src/resolvers/`

The gap is purely the **agent UX layer** — a command that resolves a spec, ensures the cache is populated, and prints the absolute path. No new fetch logic, no new cache, no new schema.

## Architecture Decision

**Two new top-level commands sharing one helper, registry-free.**

Why two commands instead of one with a flag:
- Output cardinality differs intentionally: `ask src` is single-line (one path), `ask docs` is multi-line (many candidate paths). A single command with `--docs` flag would change output shape based on a flag, which is harder for agents to compose with `$()`
- Intent is clearer: "give me source" vs "give me docs candidates" map directly to two distinct agent goals
- Top-level pollution is minimal (4 → 6 commands)

Why registry-free:
- The lazy use case is for *unknown* libraries; requiring curated registry entries would defeat the ergonomic
- This is the first registry-free entry point in ASK — a deliberate first step toward the long-term direction of registry-free `ask install` (out-of-scope tracks D, E)
- Eager mode trusts curation; lazy mode trusts convention + agent intelligence

Why multi-path output for `ask docs`:
- Coding agents can fan out across multiple paths (`Read`, `Grep`, `rg`)
- Picking ONE "correct" docs path requires either a curation registry (we don't want) or a brittle priority list (`docs > website/docs > apps/docs > ...`) that must be maintained as new conventions emerge
- Trust the consumer: emit all candidates, let the LLM judge
- Cost: a few extra paths per call. Benefit: zero priority-list maintenance

Why a `commands/` subdirectory:
- Two new files (`src.ts`, `docs.ts`) plus two helper files (`ensure-checkout.ts`, `find-doc-paths.ts`) is enough to justify a folder
- Existing flat layout (`install.ts`, `agents.ts`, etc. at top of `src/`) is left untouched per NFR-1
- Future related commands (`ask gc`, `ask path`, etc. — if added) have a natural home

## Architecture Diagram

```
   ask src <spec>                              ask docs <spec>
        |                                           |
        v                                           v
   commands/src.ts                           commands/docs.ts
        |                                           |
        +--------- ensureCheckout(spec) ------------+
                          |
                          v
        commands/ensure-checkout.ts (NEW)
                          |
                +---------+----------+----------+
                |         |          |          |
                v         v          v          v
           parseSpec  getResolver  npmEcosystem  resolveAskHome
           (existing) (existing)   Reader        + githubCheckoutPath
                                   (existing)    (existing)
                          |
                          v
              cache hit? → return path
              cache miss → GithubSource.fetch() (existing)
                                |
                                v
                  ~/.ask/github/checkouts/<o>__<r>/<ref>/
                  (already populated by existing pipeline)

   For ask docs:
        ensureCheckout returns checkoutDir
              |
              v
        commands/find-doc-paths.ts (NEW) walker
              |
              +-- node_modules/<pkg>/ (only npm-ecosystem specs)
              +-- checkoutDir
              |
              v
        all *doc* dirs + roots, one per stdout line
```

All boxes marked "existing" are read-only consumers — NFR-1 enforced.

## Tasks

- [x] T001 [P] Implement `ensureCheckout` helper (file: packages/cli/src/commands/ensure-checkout.ts) (test: packages/cli/test/commands/ensure-checkout.test.ts) — TDD cases: cache hit returns existing path without calling fetch; cache miss calls GithubSource.fetch and returns path; version resolution priority (explicit @version > lockfile > resolver latest); throws clear error when resolver cannot extract owner/repo. ~50 LOC src + ~100 LOC tests.

- [x] T002 [P] Implement `findDocLikePaths` walker helper (file: packages/cli/src/commands/find-doc-paths.ts) (test: packages/cli/test/commands/find-doc-paths.test.ts) — TDD cases: matches directory basename `/doc/i` case-insensitive; skips `node_modules`/`.git`/`.next`/`.nuxt`/`dist`/`build`/`coverage`/dotdirs; depth limit 4; returns empty list for non-existent root (no throw); always includes root as first element. ~40 LOC src + ~80 LOC tests.

- [x] T003 [P] Extend `generateAgentsMd` with substitution guide section (file: packages/cli/src/agents.ts) (test: packages/cli/test/agents-search-block.test.ts) — TDD cases: new "Searching across cached libraries" subsection appears at end of `<!-- BEGIN:ask-docs-auto-generated -->` block; existing per-library file listing is preserved unchanged; subsection contains the three substitution examples (rg/cat/fd) verbatim from FR-10. ~20 LOC modify + ~60 LOC tests.

- [x] T004 Implement `ask src` command (file: packages/cli/src/commands/src.ts) (test: packages/cli/test/commands/src.test.ts) (depends on T001) — TDD cases: cache hit prints path and exits 0; cache miss triggers fetch via ensureCheckout, prints path, exits 0; `--no-fetch` + cache miss prints stderr message and exits 1; `--no-fetch` + cache hit prints path and exits 0; explicit `react@18.2.0` ignores lockfile; resolver error prints stderr and exits 1. Use citty `defineCommand`. ~40 LOC src + ~150 LOC tests.

- [x] T005 Implement `ask docs` command (file: packages/cli/src/commands/docs.ts) (test: packages/cli/test/commands/docs.test.ts) (depends on T001, T002) — TDD cases: npm-ecosystem spec walks both `node_modules/<pkg>/` and checkout dir, output is multi-line; non-npm spec (`pypi:`, `github:`) skips node_modules walk entirely; cache miss with `--no-fetch` exits 1; empty docs result still prints checkout root as first line; explicit `@version` ignores lockfile; resolver error exits 1. Use citty `defineCommand`. ~50 LOC src + ~150 LOC tests.

- [x] T006 Wire `ask src` and `ask docs` into root CLI (file: packages/cli/src/index.ts) (test: packages/cli/test/cli/commands.test.ts extension) (depends on T004, T005) — TDD cases: `ask src --help` lists the command in subcommand list; `ask docs --help` lists the command; spawning a subprocess `node dist/cli.js src nonexistent-package-xyz-12345` exits non-zero with stderr containing the helpful hint. Modify the citty `subCommands` block in index.ts. ~20 LOC modify + ~60 LOC tests.

- [x] T007 Cache-sharing integration test (file: packages/cli/test/commands/cache-sharing.test.ts) (depends on T006) — Verifies AC-6: after running `ask install` for a fixture library that populates `~/.ask/github/checkouts/<o>__<r>/<ref>/`, then running `ask src <spec>` hits the SAME directory (zero duplication). Use a small fixture or `vi.mock`/`bun:test` mock filesystem with `ASK_HOME` redirected to a temp dir. ~120 LOC tests, no production code.

## Dependencies

Wave 1 (fully parallel): T001, T002, T003
Wave 2 (after T001, T002): T004, T005 (T004 needs T001; T005 needs T001 + T002)
Wave 3 (after T004, T005): T006
Wave 4 (after T006): T007

T003 (agents.ts extension) is fully independent of T001/T002/T004/T005/T006/T007 because it touches only `agents.ts`.

## Key Files

**New files** (all under `packages/cli/`):

- `src/commands/ensure-checkout.ts` — shared resolution helper (T001)
- `src/commands/find-doc-paths.ts` — convention walker (T002)
- `src/commands/src.ts` — `ask src` command (T004)
- `src/commands/docs.ts` — `ask docs` command (T005)
- `test/commands/ensure-checkout.test.ts` (T001)
- `test/commands/find-doc-paths.test.ts` (T002)
- `test/commands/src.test.ts` (T004)
- `test/commands/docs.test.ts` (T005)
- `test/commands/cache-sharing.test.ts` (T007)
- `test/agents-search-block.test.ts` (T003)

**Modified files** (new code only, no existing logic touched):

- `src/index.ts` — add two `subCommands` entries (T006)
- `src/agents.ts` — append substitution guide section to auto-block (T003)
- `test/cli/commands.test.ts` — add subprocess smoke test for new commands (T006)

**Reused files** (read-only):

- `src/spec.ts:parseSpec`
- `src/resolvers/index.ts:getResolver`
- `src/lockfiles/index.ts:npmEcosystemReader`
- `src/sources/github.ts:GithubSource.fetch`
- `src/store/index.ts:resolveAskHome, githubCheckoutPath, acquireEntryLock, writeEntryAtomic, cpDirAtomic, stampEntry, verifyEntry`
- `src/store/github-bare.ts:withBareClone`

## Verification

**Per-task verification** (TDD flow):

1. RED: Write failing test that defines expected behavior
2. GREEN: Minimal implementation to pass
3. REFACTOR: Clean up while keeping tests green
4. COMMIT: One conventional commit per task (e.g., `feat(cli): add ensureCheckout helper for lazy commands`)

**Track-level acceptance** (run before final commit / PR):

```bash
bun run --cwd packages/cli lint    # NFR-4: zero ESLint errors
bun run --cwd packages/cli build   # tsc clean
bun run test                       # all tests including new + existing passing
```

**Manual smoke test** before marking the track complete:

```bash
# Build
bun run --cwd packages/cli build

# In a project that already has ask installed for some library
node packages/cli/dist/cli.js src react           # should print path
node packages/cli/dist/cli.js src react --no-fetch  # should hit cache
node packages/cli/dist/cli.js docs babel          # should print multiple paths
node packages/cli/dist/cli.js src nonexistent-xyz  # should exit 1 with hint
```

All 10 acceptance criteria (AC-1 through AC-10) must be confirmed before merge.

## Progress

- [x] T001 — completed (87a8b77)
- [x] T002 — completed (fec2e16)
- [x] T003 — completed (a48bc41)
- [x] T004 — completed (1b384c3)
- [x] T005 — completed (9c1ef28)
- [x] T006 — completed (a704fe6)
- [x] T007 — completed (3bf6a4a)
- [x] (2026-04-11 KST) Review fixes applied (SHA: `91a9ef1`)

## Decision Log

- **2026-04-11**: Approved spec and plan after 12 turns of design discussion comparing ASK with vercel-labs/opensrc. Key decisions: two commands not one (cardinality differs), registry-free (escape hatch use case), multi-path output for `ask docs` (trust agent), `commands/` subdirectory layout, `spec@version` syntax only (no `--ref` flag), npm-only node_modules walk for `ask docs`.
- **2026-04-11**: Confirmed via direct code reading that `~/.ask/github/checkouts/<o>__<r>/<ref>/` already holds the FULL extracted tree (not just docsPath subset) per `sources/github.ts:123-129`. This collapses the implementation — the lazy command is purely a UX layer over existing infrastructure.
- **2026-04-11**: Decided NOT to add `--ref` flag, NOT to migrate `~/.ask/` layout, NOT to add metadata index in this track. All deferred to separate tracks (B/C/D/E/F/G/H/I) tracked in spec's Out of Scope section.

## Surprises & Discoveries

- The full extracted tree at `~/.ask/github/checkouts/<o>__<r>/<ref>/` was already in place from a previous track — this collapsed the implementation from "build a new cache layer" to "expose the existing one as two new commands". Verified by direct read of `sources/github.ts:123-129` before the spec was finalized.
- `tsserver` diagnostic warnings on the test files (`Cannot find module 'node:fs'`, etc.) are stale and not from the actual `bun run --cwd packages/cli build`. The diagnostics surface in the editor but real `bun run lint` and `bun run test` are clean. Pre-existing tsc errors in `install.ts`/`storage.ts`/`agents.ts` (around `materialization`/`inPlacePath`/`StoreMode`) are NOT from this track and reproduce on `main` — verified via `git stash` test.
- Repo label naming is inconsistent: `status/draft` uses `/` but `status:in-progress` uses `:` (and the `status:review` / `status/review` variants are both missing). Issue label sync failed during finalize and was treated as non-blocking.

## Outcomes & Retrospective

### What Was Shipped

Two new lazy CLI commands (`ask src <spec>` and `ask docs <spec>`) plus their shared infrastructure:

- `commands/ensure-checkout.ts` — `ensureCheckout` helper + `splitExplicitVersion` parser + `NoCacheError` class
- `commands/find-doc-paths.ts` — depth-4 walker with skip set and `/doc/i` matcher
- `commands/src.ts` — `runSrc` + citty wrapper
- `commands/docs.ts` — `runDocs` + citty wrapper
- `agents.ts` — extended with "Searching across cached libraries" subsection
- `index.ts` — wired both commands into the root `subCommands` map
- README.md — added "Lazy commands for ad-hoc exploration" section under Usage
- product.md — updated Core Value Proposition with the lazy escape hatch

10 commits, 65 new tests (129 expect() calls), all green. Lint clean. Spec compliance review and code review both pass with all Important issues fixed in iteration 1.

### What Went Well

- **Direct code reading before spec finalization** caught the "full tree already at the right path" surprise, which collapsed scope from a multi-PR track to a single ~150 LOC commit. The 12-turn design discussion was front-loaded into spec quality, not implementation rework.
- **Dependency injection seam pattern** (`*Deps` interfaces) made every test a unit test — no network, no real `~/.ask/`, no subprocess spawning. The test suite runs in 200ms.
- **Atomic TDD task pacing** (RED → GREEN → REFACTOR → COMMIT per task) produced clean commit history that maps 1:1 to plan.md tasks. Each commit passes lint and tests in isolation.
- **Cache-sharing pin (T007)** was added as a structural test against `githubCheckoutPath()` rather than an end-to-end install/src sequence — this caught the actual invariant ("eager and lazy share the same path key") at the right abstraction layer.

### What Could Improve

- **Pre-existing tsc errors** in `install.ts`/`storage.ts`/`agents.ts` blocked the `bun run build` step. Verifying they were pre-existing required a `git stash` cycle — a faster check (e.g. `git log -p` of the offending files) would have been less disruptive.
- **First commit on the branch lost files** when `gh issue develop --checkout` cut the branch from `origin/main` instead of local `main`. Recovery via `git checkout main -- <file>` worked, but the workflow should warn before re-creating a branch from remote when local has unpushed commits.
- **Repo label naming inconsistency** (`status/draft` vs `status:in-progress`) caused two label sync failures during the workflow. Worth normalizing in a follow-up.
- **The first review iteration found 3 Important issues** that would have been caught earlier with a "is the test discriminating between the two cases I think it tests?" pre-commit check. Specifically, `docs.test.ts:113` tested an ambiguous condition. Adding a "test must distinguish from its sibling" review heuristic to the TDD checklist would help.

### Tech Debt Created

- **EC-6 (corrupted cache entry → re-fetch)** is documented in the spec but not implemented in `ensureCheckout`. The current behavior matches the existing `GithubSource.fetch` cache check (bare `fs.existsSync`), so this is consistent with the repo state — but it's a known limitation. Worth a follow-up track that adds `verifyEntry` to the cache-hit path here AND in install.ts symmetrically.
- **`EnsureCheckoutResult.npmPackageName` could be a discriminated union** to express the "present iff npm ecosystem" invariant at the type level. Current shape is `string | undefined`, which works but allows callers to forget the undefined check. Type-analyzer flagged at confidence 85 — deferred as a non-blocking design refinement.
- **Pre-existing tsc errors** in `install.ts`/`storage.ts`/`agents.ts` (around `materialization`, `inPlacePath`, `storePath`, `StoreMode`) need a separate cleanup track. They're from the in-place npm docs feature merged in `d05025f` and reproduce on `main`.
