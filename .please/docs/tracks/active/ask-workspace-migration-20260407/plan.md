# Plan: ASK Workspace Migration to `.ask/` + Lockfile + Type-safe Config

> Track: ask-workspace-migration-20260407
> Spec: [spec.md](./spec.md)

## Overview

- **Source**: [spec.md](./spec.md)
- **Issue**: TBD
- **Created**: 2026-04-07
- **Approach**: Incremental migration — schemas first, then storage paths, then lockfile, then sync, then legacy migration

## Purpose

After this change, anyone running `@pleaseai/ask` will store all ASK-managed artifacts under `.ask/` (instead of the shared `.please/` workspace), with a Zod-validated `ask.lock` recording exactly what was last fetched. They can verify it works by running `ask docs add zod` in a fresh directory and confirming `.ask/docs/zod@<v>/`, `.ask/config.json`, and `.ask/ask.lock` are created with deterministic, byte-stable contents on re-runs.

## Context

### Problem

Three new agent skills (`add-docs`, `setup-docs`, `sync-docs`) shipped on `main` describe a workspace layout the CLI does not yet implement: storage path `.ask/docs/`, config file `.ask/config.json`, and a new `.ask/ask.lock` recording resolved versions, content hashes, and source-specific metadata. The skills also assume `config.json` and `ask.lock` are validated by Zod with discriminated unions on `source`, and that all writes are deterministic (sorted keys, sorted `docs[]` by name, 2-space indent + trailing newline) so git diffs are meaningful and PRs are reviewable.

Without this work, the skills and the CLI describe two different worlds. A user running `bun add zod` followed by `ask docs sync` would find the CLI looking in `.please/docs/` while the skills (and any agent following them) look in `.ask/docs/`. Drift detection in `sync-docs` is also impossible today because there is no source of truth for "what was actually fetched last time" — `config.json` only stores intent (potentially `latest`), not facts.

### Requirements Summary

The CLI must (1) read and write all ASK-managed artifacts under `.ask/` instead of `.please/`, (2) route every config and lock file I/O through Zod-validated, deterministic helpers in a single module, (3) record every fetch into `.ask/ask.lock` with version, source metadata, content hash, and (for github) commit sha, (4) use the lockfile as the drift baseline in a new `sync` subcommand, and (5) auto-migrate any existing `.please/docs/` and `.please/config.json` exactly once on the next CLI invocation, with a single deprecation warning.

### Constraints

The migration must be safe for existing users: anyone with an existing `.please/docs/` directory should have it moved to `.ask/docs/` automatically on the next CLI run, with the old `.please/config.json` parsed and rewritten as `.ask/config.json`. The presence of `.ask/` is the sentinel — migration runs exactly once. Re-running any `add` command with no actual content change must produce a byte-identical config and lock (modulo timestamp fields, which only update when content actually changed). All Zod parse failures must surface to the user with the offending path — no silent recovery.

### Non-Goals

Plugin packaging (`plugin.json`, marketplace publish) is a separate track. `PostToolUse` hook auto-triggering `sync-docs` is a separate track. Schema migration beyond v1 is deferred — first release pins `schemaVersion: 1` / `lockfileVersion: 1` and a migration framework can come later when v2 is needed. Source adapter fetch behavior and registry resolution priority are unchanged.

## Architecture Decision

We introduce a single `schemas.ts` module exporting Zod discriminated unions for `SourceConfig` and `LockEntry`, with `Config` and `Lock` wrapping them. All read/write goes through four helpers — `readConfig`, `writeConfig`, `readLock`, `writeLock` — which validate on the way in, sort deterministically on the way out, and emit pretty JSON with a trailing newline. Command code never touches `JSON.stringify` directly.

Lockfile recording lives inside the `add` pipeline, immediately after `storage.saveDocs()` and before `agents.update()`. Source adapters expose the metadata they already collect (commit sha for github via the archive redirect, `dist.integrity` for npm via the existing `npm view` call) through a richer `FetchResult` shape. The hash function takes the file list directly, sorts by relative path, and concatenates `<relpath>\0<bytes>\0` before SHA-256 — this is OS- and filesystem-order-independent.

Drift detection in `sync-docs` reads `.ask/ask.lock.entries[name]` as the comparison baseline rather than `.ask/config.json.docs[].version`. This handles the `latest` case correctly: a fixed config entry can still drift when its resolved commit moves.

Legacy migration runs as the very first step in `src/index.ts`, before any subcommand. The check is cheap (filesystem stat on `.ask/`), and the move is a single `fs.renameSync` plus a config rewrite. Because we cannot recover the original commit sha for github entries, the migrated lockfile leaves `commit` undefined for those entries — `sync-docs` will populate it on the next run.

We chose **incremental migration** over a big-bang refactor because each phase is independently shippable and testable. Phases 1 (schemas) and 2 (paths) can land in separate PRs if needed; phase 5 (legacy migration) is the only one with user-visible side effects and gets its own review focus.

## Tasks

- [ ] T001 [P] Add Zod schemas for Config and Lock (file: packages/cli/src/schemas.ts)
- [ ] T002 [P] Add deterministic JSON serializer and content hash utility (file: packages/cli/src/io.ts)
- [ ] T003 Add config and lock reader/writer helpers (file: packages/cli/src/io.ts) (depends on T001, T002)
- [ ] T004 Migrate storage paths from .please/docs to .ask/docs (file: packages/cli/src/storage.ts)
- [ ] T005 Replace config.ts JSON I/O with helpers (file: packages/cli/src/config.ts) (depends on T003)
- [ ] T006 Update AGENTS.md template to reference .ask/docs (file: packages/cli/src/agents.ts) (depends on T004)
- [ ] T007 [P] Expose commit sha from github source adapter (file: packages/cli/src/sources/github.ts)
- [ ] T008 [P] Expose dist.integrity from npm source adapter (file: packages/cli/src/sources/npm.ts)
- [ ] T009 Wire ask.lock upsert into the add command pipeline (file: packages/cli/src/index.ts) (depends on T003, T007, T008)
- [ ] T010 Implement sync subcommand using ask.lock as drift baseline (file: packages/cli/src/index.ts) (depends on T009)
- [ ] T011 Add legacy .please/ migration on CLI startup and update README/ARCHITECTURE (file: packages/cli/src/migrate-legacy.ts) (depends on T005, T006, T009)
- [ ] T012 [P] Schema unit tests — valid, invalid, determinism (file: packages/cli/test/schemas.test.ts) (depends on T003)
- [ ] T013 [P] Add command end-to-end test — fresh project (file: packages/cli/test/add.test.ts) (depends on T009)
- [ ] T014 [P] Sync command drift test — version bump and prune (file: packages/cli/test/sync.test.ts) (depends on T010)
- [ ] T015 Legacy migration test — seeded .please/ moves to .ask/ exactly once (file: packages/cli/test/migrate-legacy.test.ts) (depends on T011)

## Key Files

### Create
- `packages/cli/src/schemas.ts` — Zod schemas: `ConfigSchema`, `LockSchema`, `SourceConfigSchema`, `LockEntrySchema`, plus inferred TypeScript types.
- `packages/cli/src/io.ts` — `readConfig`, `writeConfig`, `readLock`, `writeLock`, `sortedJSON`, `contentHash`.
- `packages/cli/src/migrate-legacy.ts` — One-shot `.please/` → `.ask/` migration with idempotency sentinel.
- `packages/cli/test/schemas.test.ts` — Zod validation + determinism tests.
- `packages/cli/test/add.test.ts` — End-to-end add flow against a temp directory.
- `packages/cli/test/sync.test.ts` — Drift classification and re-fetch tests.
- `packages/cli/test/migrate-legacy.test.ts` — Migration idempotency test.

### Modify
- `packages/cli/src/storage.ts` — Replace `getDocsRoot()` to return `.ask/docs/` (currently `.please/docs/`, see line 6).
- `packages/cli/src/config.ts` — Replace hand-rolled `JSON.parse`/`JSON.stringify` with `readConfig`/`writeConfig`. Currently at lines 30–47 (`addDocEntry`).
- `packages/cli/src/agents.ts` — Update marker block template (lines 8–89) to reference `.ask/docs/`.
- `packages/cli/src/sources/github.ts` — Resolve commit sha via archive redirect or `gh api repos/{repo}/commits/{ref}`. Add `commit` to `FetchResult` (currently lines 15–104).
- `packages/cli/src/sources/npm.ts` — Capture `dist.integrity` from the existing `npm view` call. Add `integrity` to `FetchResult` (currently lines 14–122).
- `packages/cli/src/index.ts` — Run legacy migration on startup; add `sync` subcommand; wire lockfile upsert into `add` flow. Current `addCmd` definition at lines 90–171.
- `README.md`, `ARCHITECTURE.md` — Replace `.please/docs/` references with `.ask/docs/`.

### Reuse
- `packages/cli/src/registry.ts` — Untouched. Existing source priority and resolution logic stays as-is.
- `packages/cli/src/sources/web.ts`, `packages/cli/src/sources/llms-txt.ts` — Add `urls`/`url` to `FetchResult`, no behavioral change.
- Existing `consola` logger for the migration deprecation warning.

## Verification

### Automated Tests
- [ ] `ConfigSchema.parse()` accepts valid github/npm/web/llms-txt configs and rejects each with one required field missing
- [ ] `writeConfig` followed by `readConfig` followed by `writeConfig` produces byte-identical output
- [ ] `contentHash` is order-independent (shuffling the input file array yields the same hash)
- [ ] `ask docs add <pkg>` end-to-end creates `.ask/docs/`, `.ask/config.json`, `.ask/ask.lock`, and updates `AGENTS.md` marker block
- [ ] `ask docs sync` after a simulated version bump re-fetches only the changed entry, deletes the old version dir, and updates the lock
- [ ] Legacy migration test: seeded `.please/docs/foo@1.0.0/` and `.please/config.json` get moved into `.ask/`, deprecation warning logged exactly once, second run is silent

### Observable Outcomes
- After running `ask docs add zod` in a fresh directory, `ls .ask/` shows `docs/`, `config.json`, `ask.lock`, and `ls .please/` returns "No such file or directory".
- After running `ask docs add zod@3.22.4` twice in a row, `git diff .ask/config.json` shows no changes.
- After bumping zod and running `ask docs sync`, the terminal shows `⟳ zod 3.22.4 → 3.23.8` and the old `.ask/docs/zod@3.22.4/` directory is gone.
- Running `ask docs add` in a directory containing `.please/docs/` prints one `consola.warn` line about migration on the first invocation only.

### Manual Testing
- [ ] In a fresh `/tmp/test-fresh/` directory with only `package.json`, run `node packages/cli/dist/index.js docs add zod` and inspect `.ask/`
- [ ] Copy a real project that already has `.please/docs/` populated, run any `docs` subcommand, confirm migration runs once and never again
- [ ] Manually corrupt `.ask/config.json` (e.g. set `source: "github"` without `repo`) and confirm the next CLI run fails with a clear Zod error pointing at the offending field

### Acceptance Criteria Check
- [ ] SC-1: Fresh project produces `.ask/docs/`, `.ask/config.json`, `.ask/ask.lock`, `AGENTS.md` referencing `.ask/`, no `.please/docs/`
- [ ] SC-2: Existing `.please/` project migrated on next run, deprecation warning printed once, second run silent
- [ ] SC-3: Zod rejects malformed config with a clear path-aware error
- [ ] SC-4: Two consecutive identical `add` runs leave config and lock byte-identical except `generatedAt`/`fetchedAt` only updating when content changes
- [ ] SC-5: `sync` after `bun update zod` re-fetches only zod, deletes old dir after new fetch succeeds, updates lock

## Progress

- [ ] T001 Add Zod schemas for Config and Lock
- [ ] T002 Add deterministic JSON serializer and content hash utility
- [ ] T003 Add config and lock reader/writer helpers
- [ ] T004 Migrate storage paths from .please/docs to .ask/docs
- [ ] T005 Replace config.ts JSON I/O with helpers
- [ ] T006 Update AGENTS.md template to reference .ask/docs
- [ ] T007 Expose commit sha from github source adapter
- [ ] T008 Expose dist.integrity from npm source adapter
- [ ] T009 Wire ask.lock upsert into the add command pipeline
- [ ] T010 Implement sync subcommand using ask.lock as drift baseline
- [ ] T011 Add legacy .please/ migration on CLI startup
- [ ] T012 Schema unit tests
- [ ] T013 Add command end-to-end test
- [ ] T014 Sync command drift test
- [ ] T015 Legacy migration test

## Decision Log

- Decision: Use Zod discriminated unions on `source` for both `SourceConfig` and `LockEntry`
  Rationale: The four sources have non-overlapping required fields (github needs `repo`, npm needs `tarball`, etc.). A flat schema would either lie about optionality or require runtime branching. Discriminated unions give us static exhaustiveness checks and a single Zod parse call.
  Date/Author: 2026-04-07 / Claude

- Decision: Lockfile is committed to git, named `.ask/ask.lock`
  Rationale: Same role as `bun.lock` — reproducibility across machines and PR reviewability of doc-version drift. `.ask/docs/` itself can be gitignored if the user prefers, but the lock makes that decision recoverable.
  Date/Author: 2026-04-07 / Claude

- Decision: Migration is triggered by absence of `.ask/`, not by a versioned sentinel file
  Rationale: Cheapest possible check, naturally idempotent, no extra metadata to maintain. Once a user is on `.ask/`, the legacy code path is dead.
  Date/Author: 2026-04-07 / Claude

- Decision: Migrated github entries leave `commit` undefined in `ask.lock`
  Rationale: We never recorded the resolved sha in the legacy format, so inventing one would be lying. `sync-docs` treats missing `commit` as drift and refetches on the next run, which fills it correctly.
  Date/Author: 2026-04-07 / Claude

## Surprises & Discoveries

(populated during implementation)
