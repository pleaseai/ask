# Plan: PM-driven install flow with `ask.json`

> Track: pm-driven-install-20260410
> Spec: [spec.md](./spec.md)

## Overview
- **Source**: /please:plan
- **Track**: pm-driven-install-20260410
- **Issue**: TBD
- **Created**: 2026-04-10
- **Approach**: Single-track refactor that introduces `ask.json` + `ask install` as the new top-level architecture, retires `.ask/config.json`/`.ask/ask.lock`/`ask docs *`, and reuses existing source adapters unchanged.

## Purpose

Make the project's package manager lockfile the single source of truth for dependency versions and reposition ASK as a downstream tool of the user's package manager. Eliminates a class of drift bugs by construction and unlocks `postinstall` integration.

## Context

Today `ask docs add` writes a per-package source config into `.ask/config.json`, then `ask docs sync` walks that config and re-fetches. Versions live in `.ask/ask.lock`, which the user must remember to refresh after `bun install`. The `manifest/` reader exists only as a one-shot "infer version on add" helper. We want the version flow inverted: declare intent in `ask.json`, resolve at `install` time, and treat `.ask/resolved.json` as a disposable cache.

Github source code is **not touched** in this track — it stays on the current tarball fetcher. PyPI/Pub/Cargo/Go ecosystems are also out of scope and will be added per-ecosystem in follow-up tracks. The git+sparse fetcher is a separate follow-up track.

## Architecture Decision

**Layered orchestration with unchanged source adapters.**

Three new layers stack on top of the existing source adapters:

1. **Schema layer** (`packages/schema/src/ask-json.ts`, `resolved.ts`) — validates `ask.json` and `.ask/resolved.json` via Zod. `ask.json` is forward-extensible: ecosystem identifier lives in the `spec` string (`npm:`, `github:`), so adding pypi/pub later does not break v1.
2. **Lockfile reader layer** (`packages/cli/src/lockfiles/`) — generalizes the existing `manifest/` helpers into per-format readers (`bun.ts`, `npm.ts`, `pnpm.ts`, `yarn.ts`) and a combined npm-ecosystem facade that probes them in priority order. This is the **only** path that translates a PM-driven entry into a concrete version.
3. **Install orchestrator** (`packages/cli/src/install.ts`) — reads `ask.json`, resolves each entry (lockfile for A, `ref` for B), short-circuits via `.ask/resolved.json` content hash, calls existing source adapters unchanged, writes `.ask/docs/`, and updates `AGENTS.md` + skill files. Implements warn-and-skip policy and exit-0 semantics. Reattaches the existing intent-skills second-pass.

The CLI surface is flattened in place: the `docs` parent command and its `add/sync/remove/list` (plus `deprecatedDocsListCmd`) are deleted, replaced with top-level `install/add/remove/list`. No alias for `sync`.

Existing source adapters (`sources/npm.ts`, `sources/github.ts`, `sources/web.ts`, `sources/llms-txt.ts`) and the registry resolver (`registry.ts`) are unchanged. The current `npm.ts` local-first behavior is preserved end-to-end.

## Architecture Diagram

```
                ask.json (root, committed)             package.json + lockfile
                       │                                      │
                       ▼                                      ▼
           ┌──────────────────────────────────────────┐
           │            install orchestrator           │
           │  (packages/cli/src/install.ts) runInstall │
           └┬──────────────┬──────────────┬───────────┘
            │ entry A      │ entry B      │ cache hit?
            ▼              ▼              ▼
   lockfiles/index.ts   ref → fetch    .ask/resolved.json
   (bun → npm → pnpm     directly      (short-circuit)
    → yarn)              from spec
            │              │
            └────┬─────────┘
                 ▼
           sources/* (unchanged)
                 │
                 ▼
      .ask/docs/<name>@<ver>/  +  AGENTS.md block  +  .claude/skills/<name>-docs/
```

## Tasks

- [x] T001 [P] Define `AskJsonSchema` (libraries[]: PM-driven `{spec}` and standalone `{spec, ref, docsPath?}`) (file: packages/schema/src/ask-json.ts)
- [x] T002 [P] Define `ResolvedJsonSchema` (per-entry resolved version + content hash + last fetch time) (file: packages/schema/src/resolved.ts)
- [x] T003 Export `AskJson`, `ResolvedJson` from schema package; remove `Config`/`Lock` exports (file: packages/schema/src/index.ts) (depends on T001 T002)
- [x] T004 Rename `packages/cli/src/manifest/` to `packages/cli/src/lockfiles/`; update all imports (file: packages/cli/src/lockfiles/index.ts)
- [x] T005 [P] Implement `pnpm-lock.yaml` reader (file: packages/cli/src/lockfiles/pnpm.ts) (depends on T004)
- [x] T006 [P] Implement `yarn.lock` (classic v1) reader (file: packages/cli/src/lockfiles/yarn.ts) (depends on T004)
- [x] T007 Combined npm-ecosystem facade probing `bun.lock` → `package-lock.json` → `pnpm-lock.yaml` → `yarn.lock` (file: packages/cli/src/lockfiles/index.ts) (depends on T005 T006)
- [x] T008 Add `getAskJsonPath`/`readAskJson`/`writeAskJson`/`getResolvedJsonPath`/`readResolvedJson`/`writeResolvedJson`; remove `getConfigPath`/`getLockPath`/`readLock`/`upsertLockEntry`/`removeLockEntries` (file: packages/cli/src/io.ts) (depends on T003)
- [x] T009 Rewrite `listDocs` to source from `ask.json` + `.ask/resolved.json` instead of `ask.lock` (file: packages/cli/src/storage.ts) (depends on T008)
- [x] T010 Implement `runInstall(projectDir)` main loop — entry resolution (A/B), source adapter dispatch, `.ask/docs/` write, `AGENTS.md` upsert, skill generation, `.ask/resolved.json` short-circuit, bootstrap empty `ask.json`, warn-and-skip per-entry policy, exit 0 (file: packages/cli/src/install.ts) (depends on T007 T008)
- [x] T011 Reattach intent-skills second-pass to install orchestrator for entries flagged `format: 'intent-skills'` via discovery (file: packages/cli/src/install.ts) (depends on T010)
- [x] T012 Add `installCmd` (file: packages/cli/src/index.ts) (depends on T010)
- [x] T013 Add `addCmd` — parse spec, append to `ask.json`, scoped `runInstall` for new entry (file: packages/cli/src/index.ts) (depends on T010)
- [x] T014 Add `removeCmd` — delete entry from `ask.json`, remove `.ask/docs/<name>@*/`, remove `.claude/skills/<name>-docs/`, update `AGENTS.md` (file: packages/cli/src/index.ts) (depends on T010)
- [x] T015 Update existing `listCmd` data source to read `ask.json` + `.ask/resolved.json` via `list/aggregate.ts` (file: packages/cli/src/list/aggregate.ts) (depends on T009)
- [x] T016 Delete `docsCmd`, legacy `addCmd`, `syncCmd`, legacy `removeCmd`, `deprecatedDocsListCmd`, and `docs` entry in main `subCommands` (file: packages/cli/src/index.ts) (depends on T012 T013 T014 T015)
- [x] T017 Update `manageIgnoreFiles` to manage `.ask/resolved.json` ignore entry alongside `.ask/docs/` (file: packages/cli/src/ignore-files.ts) (depends on T010)
- [x] T018 [P] Delete legacy schema file (file: packages/schema/src/config.ts) (depends on T008)
- [x] T019 [P] Delete legacy schema file (file: packages/schema/src/lock.ts) (depends on T008)
- [x] T020 [P] Delete any `.ask/config.json` and `.ask/ask.lock` fixtures and update fixture references to `ask.json` (file: packages/cli/test/fixtures/) (depends on T016)
- [x] T021 [P] Schema validation tests for `AskJson` and `ResolvedJson` (file: packages/schema/test/ask-json.test.ts) (depends on T001 T002)
- [x] T022 [P] Lockfile reader unit tests for bun/npm/pnpm/yarn (file: packages/cli/test/lockfiles/readers.test.ts) (depends on T007)
- [x] T023 Install orchestrator tests — happy path, missing lockfile entry warn-skip, fetch failure warn-skip, bootstrap empty `ask.json`, idempotent short-circuit, mixed A/B entries, intent-skills second-pass (file: packages/cli/test/install/install.test.ts) (depends on T011)
- [x] T024 [P] CLI integration test for `ask install` (file: packages/cli/test/cli/install.test.ts) (depends on T012)
- [x] T025 [P] CLI integration test for `ask add` (file: packages/cli/test/cli/add.test.ts) (depends on T013)
- [x] T026 [P] CLI integration test for `ask remove` (file: packages/cli/test/cli/remove.test.ts) (depends on T014)
- [x] T027 Update existing list command test to read from `ask.json` + `.ask/resolved.json` (file: packages/cli/test/list/cli.test.ts) (depends on T015)
- [x] T028 [P] Update README with new `ask.json` + `ask install/add/remove/list` usage; remove `ask docs *` references (file: README.md) (depends on T016)
- [x] T029 [P] Update CLAUDE.md gotchas: remove `ask docs list` and `ask.lock` notes; add `ask.json`/`install` architecture notes and warn-and-skip semantics (file: CLAUDE.md) (depends on T016)

## Dependencies

```
T001,T002 → T003 → T008 → T009 → T015 ┐
T004 → T005,T006 → T007                │
                  T008 + T007 → T010 → T011
                                T010 → T012,T013,T014,T017
                                            └──────────────────────┐
                                                                   ▼
                  T012,T013,T014,T015 → T016 → T020,T028,T029
T008 → T018,T019
T001,T002 → T021
T007 → T022
T011 → T023
T012 → T024;  T013 → T025;  T014 → T026;  T015 → T027
```

## Key Files

**New**
- `packages/schema/src/ask-json.ts` — `AskJsonSchema`
- `packages/schema/src/resolved.ts` — `ResolvedJsonSchema`
- `packages/cli/src/install.ts` — `runInstall` orchestrator
- `packages/cli/src/lockfiles/{pnpm,yarn}.ts` — new lockfile readers

**Renamed**
- `packages/cli/src/manifest/` → `packages/cli/src/lockfiles/`

**Modified**
- `packages/cli/src/io.ts` — swap `ask.lock`/`config.json` helpers for `ask.json`/`resolved.json` helpers
- `packages/cli/src/storage.ts` — `listDocs` reads new files
- `packages/cli/src/index.ts` — flat command surface
- `packages/cli/src/list/aggregate.ts` — new data source
- `packages/cli/src/ignore-files.ts` — manage `.ask/resolved.json`
- `packages/schema/src/index.ts` — export rotation

**Deleted**
- `packages/schema/src/config.ts`
- `packages/schema/src/lock.ts`
- All `.ask/config.json` and `.ask/ask.lock` fixtures

**Untouched (intentionally)**
- `packages/cli/src/sources/*` — source adapters unchanged
- `packages/cli/src/registry.ts` — registry resolver unchanged
- `packages/cli/src/agents.ts`, `agents-intent.ts` — AGENTS.md writers unchanged
- `packages/cli/src/discovery/*` — convention-based discovery unchanged (its outputs feed into the new install loop the same way)

## Verification

- `bun run --cwd packages/cli build && bun run --cwd packages/cli lint && bun run --cwd packages/cli test` passes
- `bun run --cwd packages/schema test` passes
- Manual smoke: in a fresh dir with `bun init` + `bun add next`, run `ask add npm:next && ask install`. Verify `.ask/docs/next@<ver>/`, `AGENTS.md` block, `.claude/skills/next-docs/SKILL.md` are produced and version matches `bun.lock`.
- Manual smoke: in a non-JS dir, declare `{ "libraries": [{ "spec": "github:vercel/next.js", "ref": "v14.2.3", "docsPath": "docs" }] }`, run `ask install`. Verify `.ask/docs/next.js@v14.2.3/` is populated.
- Repository search confirms zero hits for `.ask/config.json`, `.ask/ask.lock`, `ask docs add`, `getConfigPath`, `getLockPath`, `readLock` (AC-10).
- `ask install` run twice in a row prints "already up to date" (or equivalent) on second run with no source fetches (NFR-1, AC-9).

## Progress

- [x] Phase A (T001-T003): Schemas
- [x] Phase B (T004-T007): Lockfile readers
- [x] Phase C (T008-T009): io + storage
- [x] Phase D (T010-T011): Install orchestrator
- [x] Phase E (T012-T016): CLI surface
- [x] Phase F (T017-T020): Cleanup
- [x] Phase G (T021-T027): Tests
- [x] Phase H (T028-T029): Docs

## Decision Log

- **2026-04-10** — Chose PM lockfile as single source of truth instead of maintaining `ask.lock` because version drift was a recurring class of bugs and the lockfile is already where users think versions live.
- **2026-04-10** — Chose flat command surface (`install/add/remove/list`) over keeping `docs` namespace because the project is in development and the namespace adds no value once `docs` is the only domain.
- **2026-04-10** — Chose warn-and-skip + exit 0 over fail-fast for `ask install` to keep `postinstall` integration robust against transient failures.
- **2026-04-10** — Deferred git+sparse github fetcher to a separate follow-up track to keep this track scoped on the architecture shift, not source mechanism.
- **2026-04-10** — Bootstrap empty `ask.json` rather than introduce a separate `ask init` command — reduces surface area, matches the user's mental model of "just run install".

## Surprises & Discoveries

_(populated during implementation)_
