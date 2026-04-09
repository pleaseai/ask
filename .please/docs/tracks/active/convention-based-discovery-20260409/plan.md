# Plan: Convention-based Docs Discovery

> Track: convention-based-discovery-20260409
> Spec: [spec.md](./spec.md)

## Overview

- **Source**: /please:plan
- **Track**: convention-based-discovery-20260409
- **Issue**: (pending)
- **Created**: 2026-04-09
- **Approach**: Adapter pipeline with discriminated-union result; Intent
  format installed via its native `intent-skills:start/end` marker
  block; local npm hits reference files in place via `installPath`.

## Purpose

Decouple `ask docs add` from the central registry for the majority
case, wire TanStack Intent-format packages through their native
installation model, and stop producing duplicate copies of docs that
already live in `node_modules`. The deliverable is a CLI that resolves
most popular OSS libraries with zero registry curation while staying
interchangeable with `bunx @tanstack/intent install` for Intent
packages.

## Context

This refactor replaces the current auto-detect branch in
`packages/cli/src/index.ts`. Today it calls
`resolveFromRegistry(effectiveSpec, projectDir)` first and falls back
to ecosystem resolvers on miss. Registry downtime therefore blocks
every resolution that isn't explicitly `owner/repo`. After the
refactor, a new `runLocalDiscovery` step runs before the registry, and
a new `runRepoDiscovery` step runs inside the github-fast-path after
the tarball is downloaded. Both return a `DiscoveryResult` discriminated
union so the dispatcher can branch cleanly on `docs` vs
`intent-skills`.

The existing local-first path inside `NpmSource.tryLocalRead` (from
`npm-tarball-docs-20260408`) is reused as the underlying file
collector — it already handles version match, traversal guards, and
symlink realpath checks. The new adapters in `discovery/` are thin
wrappers that pick a `docsPath` (from `ask.docsPath`, the convention
table, or Intent's scan) and delegate the actual read.

## Architecture Decision

**Why a discriminated-union `DiscoveryResult`**

The two formats have structurally different installation models:

- `docs` — a set of files that either already sit in `node_modules` or
  need to be copied into `.ask/docs/<name>@<ver>/`. Wired by generating
  a Claude Code skill file at `.claude/skills/<name>-docs/SKILL.md`
  and updating the existing `<!-- BEGIN:ask-docs-auto-generated -->`
  block in `AGENTS.md`.
- `intent-skills` — a list of `{task, loadPath}` entries pointing at
  SKILL.md files that stay in `node_modules/<pkg>/skills/`. Wired by
  updating an `<!-- intent-skills:start -->` / `<!-- intent-skills:end -->`
  block in `AGENTS.md`. No file copy, no `.claude/skills/` generation.

A discriminated union keeps the two paths statically typed at the
dispatcher and eliminates the "optional everything" shape an
undiscriminated result would force. The dispatcher becomes a clean
`switch (result.kind)` with two arms.

**Why reuse `@tanstack/intent` as a runtime dep**

`scanLibrary`, `findSkillFiles`, `parseFrontmatter`, and
`checkStaleness` are already published as programmatic exports from
`@tanstack/intent/src/index.ts`. Re-implementing them would mean
tracking Intent's frontmatter schema and staleness heuristics on our
own, with no upside. We only import read-path helpers; write-path
APIs (`runEditPackageJson`, `runSetupGithubActions`, CLI install
logic) are deliberately avoided so we keep control of the marker
block writer and can guarantee it does not collide with the ASK
block in `AGENTS.md`. The marker block format itself
(`<!-- intent-skills:start -->` / `...:end -->` around a YAML
`skills:` list) is reproduced from
`@tanstack/intent/src/commands/install.ts` so output is byte-identical
to Intent's CLI.

**Why `npm` local hits do not copy**

Copying is a leftover from when ASK only knew how to fetch tarballs.
Once the package is already in `node_modules`, maintaining a second
copy in `.ask/docs/<name>@<ver>/` means:

1. `ask docs sync` has to detect upgrades and re-copy.
2. Users see two versions of the same files on disk.
3. `AGENTS.md` and the skill file point at a path that is effectively
   frozen to whatever was installed at `ask docs add` time.

Referencing `installPath` directly makes `ask docs sync` a no-op when
the installed version matches (the docs update automatically with
`bun install`), keeps disk usage minimal, and matches Intent's model
for its own skill files.

**Registry remains as fallback**

The registry is not removed. After local discovery misses, the
existing `resolveFromRegistry` path still runs. Its role narrows to
"libraries with non-conventional layouts or alias mappings the scan
cannot infer". This is the minimum change that unblocks growth
without invalidating existing curated entries.

## Architecture Diagram

```
ask docs add npm:<pkg>
       │
       ▼
┌─────────────────────────┐
│  runLocalDiscovery      │   ← new
│                         │
│   1. local-ask          │   → ask.docsPath override → kind: 'docs'
│   2. local-intent       │   → @tanstack/intent.scanLibrary → kind: 'intent-skills'
│   3. local-conventions  │   → dist/docs → docs → README → kind: 'docs'
└───────────┬─────────────┘
            │ null
            ▼
┌─────────────────────────┐
│  resolveFromRegistry    │   ← existing, demoted to fallback
└───────────┬─────────────┘
            │ miss
            ▼
┌─────────────────────────┐
│  ecosystem resolver     │   ← existing
│                         │
│  (downloads repo tar.gz)│
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│  runRepoDiscovery       │   ← new, post-download
│                         │
│  docs/                  │   ┐
│  website/docs/          │   │
│  apps/docs/             │   │ convention scan
│  packages/docs/         │   │ + quality score
│  src/content/docs/      │   │
│  docs/src/content/docs/ │   ┘
└───────────┬─────────────┘
            │
            ▼
     DiscoveryResult
            │
            ▼
┌─────────────────────────┐
│  dispatcher             │
│                         │
│  kind: 'docs'           │ → existing pipeline
│   ├─ saveDocs (unless   │
│   │   installPath set)  │
│   ├─ addDocEntry        │
│   ├─ upsertLockEntry    │
│   ├─ generateSkill      │
│   └─ generateAgentsMd   │
│                         │
│  kind: 'intent-skills'  │ → new pipeline
│   ├─ upsertLockEntry    │
│   │   (format:'intent-  │
│   │    skills')         │
│   └─ upsertIntentSkills │
│       Block(AGENTS.md)  │
└─────────────────────────┘
```

## Tasks

- [x] T001 [P] Add `format?: 'docs' | 'intent-skills'` to `NpmLockEntry` (file: packages/schema/src/lock.ts)
- [x] T002 [P] Add `@tanstack/intent` as an exact-pinned runtime dep of `packages/cli` (file: packages/cli/package.json)
- [x] T003 [P] Define discovery types: `DiscoveryResult` discriminated union, `IntentSkillEntry`, `QualityScore`, adapter interface (file: packages/cli/src/discovery/types.ts)
- [x] T004 [P] Define convention path tables for local tarball and GitHub repo scans (file: packages/cli/src/discovery/conventions.ts)
- [x] T005 Implement quality scoring + exclude filter with ≥3 md or ≥4KB threshold (file: packages/cli/src/discovery/quality.ts) (depends on T003, T004)
- [x] T006 [P] Implement `local-ask` adapter reading `package.json.ask.docsPath` (file: packages/cli/src/discovery/local-ask.ts) (depends on T003)
- [x] T007 Implement `local-intent` adapter wrapping `@tanstack/intent.scanLibrary` with zod runtime validation (file: packages/cli/src/discovery/local-intent.ts) (depends on T002, T003)
- [x] T008 Implement `local-conventions` adapter scanning `dist/docs/`, `docs/`, `README.md` using `NpmSource.tryLocalRead` as file collector (file: packages/cli/src/discovery/local-conventions.ts) (depends on T003, T004, T005)
- [x] T009 Implement `repo-conventions` adapter scanning a downloaded repo tree (file: packages/cli/src/discovery/repo-conventions.ts) (depends on T003, T004, T005)
- [x] T010 Orchestrate `runLocalDiscovery` and `runRepoDiscovery` with the documented adapter priority order (file: packages/cli/src/discovery/index.ts) (depends on T006, T007, T008, T009)
- [ ] T011 Extend `generateSkill` to accept optional `docsDir` parameter that overrides the `.ask/docs/` reference and skips the "docs not found" fallback section (file: packages/cli/src/skill.ts) (depends on T001)
- [ ] T012 Implement `upsertIntentSkillsBlock` and `removeFromIntentSkillsBlock` helpers that manage the `<!-- intent-skills:start --> / :end -->` block in `AGENTS.md` with byte-identical output to `@tanstack/intent/src/commands/install.ts` (file: packages/cli/src/agents-intent.ts) (depends on T003)
- [ ] T013 Dispatch `DiscoveryResult` in the `add` command: call `runLocalDiscovery` before `resolveFromRegistry`, branch on `kind`, skip `saveDocs` when `installPath` is set, call `upsertIntentSkillsBlock` for `intent-skills` (file: packages/cli/src/index.ts) (depends on T010, T011, T012)
- [ ] T014 Wire `runRepoDiscovery` into the ecosystem-resolver fall-through so github-tarball fetches use convention scan for their download root (file: packages/cli/src/index.ts) (depends on T010)
- [ ] T015 Branch `ask docs sync` behavior on the lock entry's `format`: `'intent-skills'` entries call `@tanstack/intent.checkStaleness` and update the marker block, `'docs'` with `installPath` short-circuits on version match (file: packages/cli/src/index.ts) (depends on T012)
- [ ] T016 Branch `ask docs remove` behavior on the lock entry's `format`: `'intent-skills'` entries call `removeFromIntentSkillsBlock`, `'docs'` entries preserve existing delete path (file: packages/cli/src/index.ts) (depends on T012)
- [ ] T017 [P] Add fixture `pkg-ask-manifest` under `packages/cli/test/fixtures/` with `package.json.ask.docsPath` and populated docs tree (file: packages/cli/test/fixtures/pkg-ask-manifest/)
- [ ] T018 [P] Add fixture `pkg-intent` with `keywords: ['tanstack-intent']` + `skills/usage/SKILL.md` (file: packages/cli/test/fixtures/pkg-intent/)
- [ ] T019 [P] Add fixture `pkg-conventional` with `dist/docs/*.md` containing ≥3 meaningful files (file: packages/cli/test/fixtures/pkg-conventional/)
- [ ] T020 [P] Add fixture `pkg-noise` containing only `CONTRIBUTING.md` + `CHANGELOG.md` (file: packages/cli/test/fixtures/pkg-noise/)
- [ ] T021 Unit tests for each adapter in isolation: feed each fixture through every adapter and assert match/non-match plus the returned `DiscoveryResult` shape (file: packages/cli/test/discovery/adapters.test.ts) (depends on T006, T007, T008, T009, T017, T018, T019, T020)
- [ ] T022 Unit tests for quality scoring: noise-only fixture scores below threshold, conventional fixture scores above (file: packages/cli/test/discovery/quality.test.ts) (depends on T005, T019, T020)
- [ ] T023 Unit tests for `agents-intent.ts`: upsert is idempotent, remove preserves sibling entries, output is byte-identical to a captured `@tanstack/intent install` reference snapshot (file: packages/cli/test/agents-intent.test.ts) (depends on T012, T018)
- [ ] T024 Unit tests for the orchestration priority in `runLocalDiscovery`: ask-manifest beats intent, intent beats conventions, conventions beats registry miss (file: packages/cli/test/discovery/orchestration.test.ts) (depends on T010, T017, T018, T019)
- [ ] T025 Integration coverage: existing `ask docs add/sync/remove` tests still pass without modification; new integration test exercises `add npm:<fixture>` against each fixture shape (file: packages/cli/test/add-discovery.test.ts) (depends on T013, T014, T015, T016, T021, T022, T023, T024)
- [ ] T026 [P] Registry coverage audit script: iterate `apps/registry/content/registry/**/*.md`, fetch each entry twice (registry on / registry off), diff the resulting file lists, report the coverage percentage (file: packages/cli/scripts/audit-coverage.ts)
- [ ] T027 Run the coverage audit locally and verify SC-1 (≥80% of current entries resolve via convention scan alone); record the result in `Surprises & Discoveries` (depends on T025, T026)
- [ ] T028 Verify SC-2: install a real `tanstack-intent` keyword package, run `ask docs add npm:<pkg>` and `bunx @tanstack/intent install`, diff `AGENTS.md` — must be byte-identical inside the `intent-skills` block (depends on T013, T025)
- [ ] T029 Run `bun run --cwd packages/cli build` and `bun run --cwd packages/cli lint`; fix any violations (depends on T013, T014, T015, T016)
- [ ] T030 Update `CLAUDE.md` with the new discovery pipeline, `ask.docsPath` manifest field, and the dual AGENTS.md marker setup (file: CLAUDE.md) (depends on T029)

## Dependencies

The task graph is mostly linear inside each area with a few parallel
prefixes. The `[P]` markers on T001-T004, T017-T020, T026 indicate
tasks that can be started in parallel with their siblings because
they do not share files. After the adapter set (T005-T009), T010
fans-in to orchestrate them. After T010 + T011 + T012, the
dispatcher (T013) and its command cousins (T014-T016) are a single
sequential chain through `index.ts`. Tests (T021-T025) sit on top of
their respective implementations. T027-T030 are verification and
closeout.

Critical chain (longest path, roughly):
T001 → T011 → T013 → T015/T016 → T025 → T027/T028 → T029 → T030.

## Key Files

- `packages/cli/src/index.ts` — `add`, `sync`, `remove` commands; the
  auto-detect branch that currently calls `resolveFromRegistry` first.
- `packages/cli/src/sources/npm.ts` — `NpmSource.tryLocalRead`, reused
  by `local-conventions` and `local-ask` adapters for actual file
  reads with traversal + symlink guards already in place.
- `packages/cli/src/agents.ts` — existing `generateAgentsMd` with the
  `<!-- BEGIN:ask-docs-auto-generated -->` / `<!-- END:... -->`
  block. Untouched; the new `agents-intent.ts` handles a disjoint
  region of the same file.
- `packages/cli/src/skill.ts` — `generateSkill`; gains optional
  `docsDir` param so the skill file can point at an `installPath`
  instead of `.ask/docs/<name>@<ver>/`.
- `packages/cli/src/registry.ts` — `resolveFromRegistry`,
  `fetchRegistryEntry`, `parseDocSpec`; unchanged in behavior, just
  called later in the pipeline.
- `packages/schema/src/lock.ts` — `NpmLockEntry` gains optional
  `format: 'docs' | 'intent-skills'`.
- `packages/cli/src/storage.ts` — `saveDocs`, `getLibraryDocsDir`,
  `listDocs`; consulted when deciding whether to copy on install.
- `apps/registry/content/registry/**/*.md` — 37 curated entries, used
  by the coverage audit (T026).
- `packages/cli/test/` — existing bun:test suite; new fixtures land
  under `packages/cli/test/fixtures/`, new adapter suites under
  `packages/cli/test/discovery/`.

## Verification

**Build and lint**
```bash
bun run --cwd packages/cli build
bun run --cwd packages/cli lint
```

**Unit tests**
```bash
bun run --cwd packages/cli test
```
Expected: all new discovery/adapters/orchestration/quality/agents-intent
suites green; existing agents/schemas/lock-pipeline/markers/
concurrency/io-utils/ignore-files/manifest suites still green.

**Coverage audit (SC-1)**
```bash
bun run packages/cli/scripts/audit-coverage.ts
```
Expected: ≥80% of entries in `apps/registry/content/registry/` resolve
to the same file list via convention scan alone.

**Intent parity (SC-2)**
```bash
mkdir /tmp/parity && cd /tmp/parity
bun init -y
bun add <some-tanstack-intent-package>
# ask path
node /path/to/ask/packages/cli/dist/cli.js docs add npm:<pkg>
cp AGENTS.md AGENTS-ask.md
# reset
sed -n '/<!-- intent-skills:start -->/,/<!-- intent-skills:end -->/d' AGENTS-ask.md > AGENTS.md
bunx @tanstack/intent install
diff AGENTS.md AGENTS-ask.md
```
Expected: zero diff inside the `intent-skills` block.

**Fixtures integration (SC-3, SC-4)**
```bash
bun run --cwd packages/cli test -- add-discovery
```
Expected: `pkg-noise` fixture is not selected; existing `ask docs
add/sync/remove` tests continue to pass unchanged.

## Progress

- [ ] Phase 1: Schema + deps (T001, T002)
- [ ] Phase 2: Discovery adapters (T003-T010)
- [ ] Phase 3: Writers + dispatcher (T011-T016)
- [ ] Phase 4: Tests + fixtures (T017-T025)
- [ ] Phase 5: Audit + verification + docs (T026-T030)

## Decision Log

- **2026-04-09** — Chose adapter-with-discriminated-union over a single
  generic `fetch` interface. Two genuinely different installation
  models (`docs` copy/reference vs `intent-skills` reference-only)
  would force every caller to carry optional fields that only apply
  to one arm. The union keeps both arms statically typed.
- **2026-04-09** — Chose to add `@tanstack/intent` as a runtime
  dependency rather than re-implement `scanLibrary` / `parseFrontmatter`.
  Intent already ships a programmatic API; reuse reduces our surface
  and keeps us automatically compatible with their frontmatter
  schema. The write-path APIs are avoided so our marker block writer
  stays under our control.
- **2026-04-09** — Chose to skip file copy on `npm` local hits.
  Maintaining a second copy of docs that already live in
  `node_modules` is pure cost; the skill file and lock entry
  reference `installPath` directly.
- **2026-04-09** — The two AGENTS.md blocks (existing
  `<!-- BEGIN:ask-docs-auto-generated -->` and new
  `<!-- intent-skills:start -->`) are managed by independent writers
  on disjoint byte ranges. Neither writer touches the other region.

## Surprises & Discoveries

(populated during implementation)
