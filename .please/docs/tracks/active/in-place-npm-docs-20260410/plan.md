# Plan: In-place npm docs

> Track: in-place-npm-docs-20260410
> Spec: [spec.md](./spec.md)

## Overview

- **Source**: /please:new-track --plan → /please:plan
- **Track**: in-place-npm-docs-20260410
- **Issue**: TBD
- **Created**: 2026-04-10
- **Approach**: Extend the discovery result type with an `inPlace: true` marker and an absolute `docsDir`. In `install.ts:installOne`, branch on that marker: skip `saveDocs`, still call `generateSkill({ docsDir })` (already supported), stamp the resolved-cache entry with `materialization: 'in-place'` + `inPlacePath: <project-relative>`. In `agents.ts:generateAgentsMd`, read `materialization` and emit a differentiated AGENTS.md block for in-place entries. Add `--no-in-place` CLI flag and `inPlace?: boolean` ask.json field for opt-out.

## Purpose

Stop duplicating `node_modules/<pkg>/<subdir>` into `.ask/docs/<pkg>@<v>/` when the package ships its own docs. Point AGENTS.md at the `node_modules` path directly so `bun install` automatically refreshes what the agent reads, and eliminate the "two sources of truth" problem for discovery-detected npm docs.

## Context

- `packages/cli/src/discovery/` already has three local adapters (`local-ask.ts`, `local-intent.ts`, `local-conventions.ts`) that return a discovery result with a `docsDir` field. The current orchestrator reads `files` from that result and calls `saveDocs` — it ignores the signal that the docs already live under `node_modules/`.
- `packages/cli/src/skill.ts:22-28` already defines `GenerateSkillOptions.docsDir` and the `inPlace: options.docsDir !== undefined` branch (line 40). The skill file generation path is ready; only the install orchestrator needs to start passing `docsDir` through.
- `packages/cli/src/agents.ts:generateAgentsMd` currently emits one kind of block shape. It needs a small conditional to switch the "Documentation" path and the wording for in-place entries.
- `packages/schema/src/resolved.ts` has the `ResolvedEntrySchema`. If `global-docs-store-20260410` lands first, `materialization` will already exist as an enum; this track extends that enum with `'in-place'`. If this track lands first, it introduces the enum with two values (`'copy' | 'in-place'`) and the store track adds `'link' | 'ref'` later.
- `packages/cli/src/storage.ts:saveDocs` handles the "remove old version directory" cleanup today. That cleanup needs to run unchanged for the in-place path, so old vendored copies get cleaned up automatically on the first in-place install.

## Architecture Decision

**Chosen: tag the discovery result, branch at the install seam, differentiate at the AGENTS.md seam.**

Three options considered:

1. **Tag at discovery, branch at install (chosen)** — Minimal cross-cutting change. Discovery adapters grow an `inPlace: true` field on their result. `installOne` checks it and either copies-or-skips `saveDocs`. `agents.ts` reads `materialization` from the resolved cache and picks the right path. Tests are localized per seam.

2. **Rewrite `saveDocs` to accept a "don't copy" flag** — rejected. Pushes policy into the storage layer, which should stay dumb about WHY files might not need saving. Leaks the in-place concept into a module that otherwise only cares about writing files.

3. **Move the in-place decision into `discovery/*`** — rejected. Discovery should answer "where are the docs?" not "should they be copied?". The second question depends on caller policy (opt-out flag, registry vs discovery, etc.), which discovery doesn't know about.

**Opt-out precedence**: `--no-in-place` CLI flag > `ask.json` `inPlace: false` > default `true`. Matches the precedence used by the sibling `emitSkill` track for consistency.

**Version change semantics**: When `bun install` bumps a version, the discovery adapter returns a new `docsDir` with the new version embedded (usually by reading `node_modules/<pkg>/package.json`). The resolved cache entry is updated, AGENTS.md regenerates with the new version, and any stale `.ask/docs/<pkg>@<old>/` directory is removed by the existing `storage.ts` cleanup.

## Key Files

- `packages/cli/src/discovery/index.ts` — MODIFIED. Discovery result type grows `inPlace?: true` marker.
- `packages/cli/src/discovery/local-intent.ts` — MODIFIED. Set `inPlace: true` on result.
- `packages/cli/src/discovery/local-conventions.ts` — MODIFIED. Set `inPlace: true` on result.
- `packages/cli/src/discovery/local-ask.ts` — MODIFIED. Set `inPlace: true` on result when the opt-in `package.json.ask.docsPath` resolves under `node_modules/`.
- `packages/cli/src/install.ts` — MODIFIED. `installOne` branches on `inPlace`; skips `saveDocs`, still calls `generateSkill({ docsDir })`, stamps resolved entry with `materialization: 'in-place'` and `inPlacePath`.
- `packages/cli/src/agents.ts` — MODIFIED. `generateAgentsMd` reads each resolved entry's `materialization`; emits a differentiated block for `'in-place'` with "shipped by the package, kept in sync by `bun install`" wording.
- `packages/cli/src/index.ts` — MODIFIED. Add `--no-in-place` flag to `installCmd` and `addCmd`. Pass through to `runInstall`.
- `packages/cli/src/install.ts` — MODIFIED (second pass). `runInstall` resolves `inPlace` precedence (CLI > ask.json > default `true`) once, threads through `installOne`.
- `packages/schema/src/ask-json.ts` — MODIFIED. Add `inPlace?: boolean` to `AskJsonSchema`.
- `packages/schema/src/resolved.ts` — MODIFIED. Add `inPlacePath?: string` and extend `materialization` enum to include `'in-place'` (union with anything the store track adds).
- `packages/cli/src/storage.ts` — UNCHANGED API; but the "clean up old version directory on version change" branch is re-exercised by the in-place path's transition from copy to in-place.
- `packages/cli/test/install.in-place.test.ts` — NEW. Integration tests for SC-1 through SC-8.
- `packages/cli/test/agents.in-place.test.ts` — NEW. `generateAgentsMd` emits differentiated block for in-place entries.
- `packages/cli/test/discovery/*.test.ts` — MODIFIED. Assert `inPlace: true` on local adapter results.
- `packages/cli/CHANGELOG.md` — MODIFIED. Unreleased entry.
- `README.md` — MODIFIED. Note in-place behavior for npm discovery.

## Tasks

- [ ] T001 [P] Add `inPlace?: boolean` to `AskJsonSchema`; export inferred type (file: packages/schema/src/ask-json.ts)
- [ ] T002 [P] Add `inPlacePath?: string` to `ResolvedEntrySchema` and extend `materialization` to include `'in-place'` (file: packages/schema/src/resolved.ts)
- [ ] T003 Add schema tests for the new optional fields (file: packages/schema/test/*.test.ts) (depends on T001, T002)
- [ ] T004 [P] Extend discovery result type with `inPlace?: true` marker (file: packages/cli/src/discovery/index.ts)
- [ ] T005 Update `local-intent.ts` to set `inPlace: true` (file: packages/cli/src/discovery/local-intent.ts) (depends on T004)
- [ ] T006 Update `local-conventions.ts` to set `inPlace: true` (file: packages/cli/src/discovery/local-conventions.ts) (depends on T004)
- [ ] T007 Update `local-ask.ts` to set `inPlace: true` when the opt-in path resolves under `node_modules/` (file: packages/cli/src/discovery/local-ask.ts) (depends on T004)
- [ ] T008 Add discovery tests asserting `inPlace: true` on local-adapter results (file: packages/cli/test/discovery/*.test.ts) (depends on T005, T006, T007)
- [ ] T009 Resolve `inPlace` precedence (CLI > ask.json > true) once per `runInstall` and thread into `installOne` (file: packages/cli/src/install.ts) (depends on T001)
- [ ] T010 In `installOne`, branch on `discoveryResult.inPlace && resolvedInPlace`: remove any prior vendored docs for the library (e.g. `.ask/docs/<pkg>@*`), skip `saveDocs`, call `generateSkill({ docsDir: <project-rel path> })`, upsert resolved cache with `materialization: 'in-place'` and `inPlacePath` (file: packages/cli/src/install.ts) (depends on T002, T004, T009)
- [ ] T011 Update `agents.ts:generateAgentsMd` to read `materialization` from resolved entries and emit a differentiated AGENTS.md block for `'in-place'` with "shipped by the package" wording (file: packages/cli/src/agents.ts) (depends on T002, T010)
- [ ] T012 Add `--no-in-place` boolean flag to `installCmd` and `addCmd` and pass through to `runInstall` options (file: packages/cli/src/index.ts) (depends on T009)
- [ ] T013 Integration test SC-1: in-place install does NOT create `.ask/docs/next@<v>/`, AGENTS.md points at `node_modules/next/dist/docs/` (file: packages/cli/test/install.in-place.test.ts) (depends on T010, T011)
- [ ] T014 Integration test SC-2: AGENTS.md block for in-place entries contains the "shipped by the package" / "bun install keeps them in sync" wording (file: packages/cli/test/agents.in-place.test.ts) (depends on T011)
- [ ] T015 Integration test SC-3: version bump in `node_modules` → second `ask install` updates resolved version and AGENTS.md without stale `.ask/docs/<old>/` leftovers (file: packages/cli/test/install.in-place.test.ts) (depends on T010)
- [ ] T016 Integration test SC-4: npm package without shipped docs (`lodash` fixture) falls through to the tarball/copy path unchanged (file: packages/cli/test/install.in-place.test.ts) (depends on T010)
- [ ] T017 Integration test SC-5/SC-6: `--no-in-place` flag and `ask.json` `inPlace: false` force the copy path for a normally-in-place package (file: packages/cli/test/install.in-place.test.ts) (depends on T012)
- [ ] T018 Integration test SC-7: `ask remove npm:next` on an in-place entry removes the resolved entry + AGENTS.md block without touching `node_modules/next/` (file: packages/cli/test/install.in-place.test.ts) (depends on T010, T011)
- [ ] T019 Integration test SC-8: pre-existing `.ask/docs/next@<old-v>/` from a prior copy install is removed on the first in-place install (file: packages/cli/test/install.in-place.test.ts) (depends on T010)
- [ ] T020 Update CHANGELOG under unreleased `@pleaseai/ask` with the in-place default, the `--no-in-place` flag, and `ask.json` `inPlace` field (file: packages/cli/CHANGELOG.md) (depends on T010, T011, T012)
- [ ] T021 Update root README with a short "In-place npm docs" paragraph under Architecture explaining the default behavior + opt-out (file: README.md) (depends on T020)
- [ ] T022 Run `bun run build && bun test` across all workspaces; manually verify `example/` produces the in-place AGENTS.md pointing at `node_modules/next/dist/docs/` (depends on T013–T019)

## Dependencies

```
T001 ─┐
T002 ─┼─ T003 (schema tests)
      │
T004 ─┼─ T005, T006, T007 ── T008 (discovery tests)
      │
T001 ─ T009 ─ T010 ─┬─ T011 ── T013, T014, T018
                    │
                    ├─ T015, T016, T017, T019
                    │
                    └─ T012 ─ T017

T010, T011, T012 ── T020 ─ T021

T013–T019 ── T022
```

## Verification

- **Functional**:
  - `example/` project (Next.js 16.2.3 with `dist/docs`): `ask install` → no `.ask/docs/next@16.2.3/`, AGENTS.md has "Documentation: `node_modules/next/dist/docs/`".
  - Bump to `next@16.2.4` via `bun install`, re-run `ask install` → AGENTS.md updates to `16.2.4`, no stale dirs.
  - `ask install --no-in-place` on the same project → `.ask/docs/next@16.2.3/` appears, AGENTS.md points at it.
  - Add `{ "inPlace": false }` to `ask.json`, drop the flag, re-run → same as the `--no-in-place` case.
  - Replace with a package that does NOT ship docs (e.g. `lodash`) → falls through to the current tarball fetch + copy path unchanged.
  - `ask remove npm:next` on an in-place entry → `node_modules/next/` untouched, `.ask/resolved.json` entry gone, AGENTS.md block gone.
- **Non-regression**:
  - `bun test` across all packages green.
  - `github:` and `web:` entries unaffected (still copy through `saveDocs`).
  - `example/.gitignore` still correct (no `.ask/docs` to ignore in the in-place case, but it stays listed because it may exist for mixed projects).
- **Docs**:
  - CHANGELOG describes: default flip to in-place for npm discovery, `--no-in-place` flag, `inPlace` ask.json field, AGENTS.md wording difference.
  - README mentions the behavior under Architecture and links to the CHANGELOG.

## Progress

- Spec drafted
- Plan drafted

## Decision Log

- 2026-04-10: Chose to tag discovery results rather than push the decision into `saveDocs` or discovery itself. Minimal cross-cutting surface; respects module boundaries.
- 2026-04-10: Default flipped to `inPlace: true` because copying is net-negative for discovery-detected npm docs (disk waste + stale-after-bun-install). Opt-out is one flag / one field.
- 2026-04-10: AGENTS.md wording must differ for in-place vs copied entries. Users (and agents) need to know the lifecycle owner to reason about freshness and what to do when the path 404s.
- 2026-04-10: This track is independent of `global-docs-store-20260410`. If the store track lands first, the `materialization` enum already has `'copy' | 'link' | 'ref'`; this track adds `'in-place'`. If this track lands first, the enum starts as `'copy' | 'in-place'` and the store track extends it.

## Surprises & Discoveries

- (empty — to be populated during implementation)
