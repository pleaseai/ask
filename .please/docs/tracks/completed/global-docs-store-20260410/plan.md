# Plan: Global ASK docs store at `~/.ask/`

> Track: global-docs-store-20260410
> Spec: [spec.md](./spec.md)

## Overview

- **Source**: /please:new-track --plan → /please:plan
- **Track**: global-docs-store-20260410
- **Issue**: TBD
- **Created**: 2026-04-10
- **Approach**: Introduce a `store.ts` module that owns `ASK_HOME` resolution and per-kind layout (`npm/`, `github/`, `web/`, `llms-txt/`). Source adapters (`sources/npm.ts`, `sources/github.ts`, `sources/web.ts`) grow a "write into store" code path; the install orchestrator then materializes the project-local `.ask/docs/<pkg>@<v>/` pointer via `copy | link | ref` per `storeMode`. `github.ts` additionally uses a bare clone + `git archive | tar -x` for multi-ref efficiency (Cargo-style). `ask cache ls|gc` are new top-level commands.

## Purpose

Enable cross-project and cross-ref dedup of downloaded ASK documentation, turn repeat installs into near-instant store hits, and give users the option to skip project-local materialization entirely (`ref` mode). Keep the default behavior byte-identical to today (`copy` mode) so the upgrade is silent for anyone who doesn't opt in.

## Context

- `packages/cli/src/storage.ts:saveDocs` is the current single-entry writer; it takes `{ projectDir, name, version, files }` and writes into `.ask/docs/<name>@<version>/`. It has no concept of a backing store.
- `packages/cli/src/sources/npm.ts` is already local-first (reads `node_modules/<pkg>/<docsPath>` if version matches) and falls through to a tarball fetch on miss. The store is a second fallback layer between "local node_modules" and "network fetch".
- `packages/cli/src/sources/github.ts` downloads a tar.gz of the repo at a given ref and extracts it. No git awareness today.
- `packages/cli/src/install.ts:installOne` orchestrates fetch → `saveDocs` → `generateSkill` → resolved-cache upsert → AGENTS.md regen. The materialization step (`saveDocs`) is the natural seam for `copy|link|ref` branching.
- `ask.json` schema is `.strict()` in `packages/schema/src/ask-json.ts:69`. Adding `storeMode` requires an explicit optional field on `AskJsonSchema`.
- `ask remove` (`packages/cli/src/index.ts:180`) tears down `.ask/docs/<name>@<version>/` and the skill dir. Store entries are deliberately NOT touched on per-project remove — only `ask cache gc` reclaims store space.

## Architecture Decision

**Chosen: layered `store.ts` module with pluggable materialization.**

Key design points:

1. **New module `packages/cli/src/store/index.ts`** owns all of: `resolveAskHome()`, per-kind paths (`npmStorePath`, `githubDbPath`, `githubCheckoutPath`, `webStorePath`), atomic write helpers (`writeEntryAtomic`), locking (`acquireEntryLock`), and checksum validation (`verifyEntry`). Source adapters call into it; `storage.ts` calls into it; neither source adapters nor `storage.ts` learn about `<kind>` layout directly.

2. **Source adapters return `{ storePath, files }`** instead of just `files`. `storePath` is the absolute path to the finalized store entry. Callers that need a file list (AGENTS.md listing, skill TOC) use `files`; callers that materialize use `storePath`.

3. **Materialization is a pure function of `(storePath, projectDir, libName, version, storeMode)`** living in `storage.ts`. `copy` uses `fs.cpSync(..., { recursive: true })`. `link` uses `fs.symlinkSync` with a try/catch that falls back to `copy` on `EPERM`/`EACCES`. `ref` is a no-op (no project-local files for that entry).

4. **`AGENTS.md` target path resolution** moves into `agents.ts:generateAgentsMd`, which reads each `.ask/resolved.json` entry's `materialization` field (new: `'copy' | 'link' | 'ref'`) and the stored `storePath` to pick the right path to surface.

5. **GitHub bare clone**: `sources/github.ts` grows a `withBareClone(owner, repo, ref, (checkoutDir) => ...)` helper that shells out to `git init --bare` (once) then `git fetch origin <ref>` (every time, idempotent) and `git archive --format=tar <ref> | tar -xC <checkoutDir>` to materialize. Falls back to the current `https://codeload.github.com/<owner>/<repo>/tar.gz/<ref>` path if `git` is not on PATH or the clone step fails.

6. **Locking**: per-entry `.lock` file via `fs.openSync(lockPath, 'wx')`. A process that can't acquire the lock waits up to 60s with exponential backoff (100ms → 1600ms cap) and retries; if the target entry exists after the wait, it's treated as a hit. Prevents the thundering-herd scenario where two concurrent installs both try to fetch `next@16.2.3`.

## Key Files

- `packages/cli/src/store/index.ts` — NEW. `resolveAskHome`, layout helpers, atomic write, locking, `verifyEntry`.
- `packages/cli/src/store/github-bare.ts` — NEW. `withBareClone(owner, repo, ref, fn)`. Shells out to `git`.
- `packages/cli/src/store/cache.ts` — NEW. `cacheLs`, `cacheGc` pure functions returning structured results.
- `packages/cli/src/storage.ts` — MODIFIED. `saveDocs` accepts `storeMode` + `storePath`, branches on the three modes.
- `packages/cli/src/sources/index.ts` — MODIFIED. `DocSource.fetch` return type gains `storePath: string`.
- `packages/cli/src/sources/npm.ts` — MODIFIED. Writes into `<ASK_HOME>/npm/<pkg>@<version>/` before returning.
- `packages/cli/src/sources/github.ts` — MODIFIED. Uses `withBareClone`; writes into `<ASK_HOME>/github/checkouts/<owner>__<repo>/<ref>/`.
- `packages/cli/src/sources/web.ts` — MODIFIED. Writes into `<ASK_HOME>/web/<sha256-url>/`.
- `packages/cli/src/install.ts` — MODIFIED. Resolves `storeMode` (CLI flag > ask.json > default `copy`) once per run; passes it through `installOne` into `saveDocs`.
- `packages/cli/src/index.ts` — MODIFIED. Adds `--store-mode` flag to install/add commands. Adds new top-level `cache` subcommand (`cache ls`, `cache gc`).
- `packages/cli/src/agents.ts` — MODIFIED. Reads `materialization` + `storePath` from resolved entries to pick the AGENTS.md path per entry.
- `packages/schema/src/ask-json.ts` — MODIFIED. `AskJsonSchema` gains `storeMode: z.enum(['copy','link','ref']).optional()`.
- `packages/schema/src/resolved.ts` — MODIFIED. `ResolvedEntrySchema` gains `storePath: z.string().optional()` and `materialization: z.enum(['copy','link','ref']).optional()`.
- `packages/cli/test/store/**/*.test.ts` — NEW. Unit tests for `resolveAskHome`, atomic write, lock acquire/release, `verifyEntry`, `cacheLs`, `cacheGc`.
- `packages/cli/test/install.store.test.ts` — NEW. Integration: `copy` default, `link` success, `link` → `copy` fallback on simulated EPERM, `ref` mode, concurrent install lock.
- `packages/cli/test/sources/github.bare.test.ts` — NEW. Bare clone reuse: two refs → one clone.
- `packages/cli/CHANGELOG.md` — MODIFIED. Unreleased entry for store + `cache` commands + `ASK_HOME`.
- `README.md` — MODIFIED. Add "Store" section with layout + `storeMode` + `ASK_HOME` override.

## Tasks

- [x] T001 [P] Add `storeMode?: 'copy' | 'link' | 'ref'` to `AskJsonSchema`; update exported type (file: packages/schema/src/ask-json.ts)
- [x] T002 [P] Add `storePath?: string` and `materialization?: 'copy' | 'link' | 'ref'` to `ResolvedEntrySchema`; update exported type (file: packages/schema/src/resolved.ts)
- [x] T003 [P] Add schema tests for new optional fields and unknown-key rejection (file: packages/schema/test/*.test.ts) (depends on T001, T002)
- [x] T004 Create `packages/cli/src/store/index.ts` with `resolveAskHome()` (env > default `~/.ask/`), per-kind path helpers (`npmStorePath`, `githubDbPath`, `githubCheckoutPath`, `webStorePath`, `llmsTxtStorePath`), `writeEntryAtomic`, `acquireEntryLock`, `verifyEntry` (file: packages/cli/src/store/index.ts)
- [x] T005 Add unit tests for `resolveAskHome`, atomic write, lock contention, `verifyEntry` (file: packages/cli/test/store/index.test.ts) (depends on T004)
- [x] T006 Create `packages/cli/src/store/github-bare.ts` with `withBareClone(owner, repo, ref, fn)` that shells out to `git init --bare`, `git fetch origin <ref>`, `git archive | tar -x`; falls back to returning `null` when `git` is absent so caller can use tar.gz path (file: packages/cli/src/store/github-bare.ts) (depends on T004)
- [x] T007 Add tests for `withBareClone`: fresh clone, reuse existing db, ref reuse skip, git-missing fallback (file: packages/cli/test/store/github-bare.test.ts) (depends on T006)
- [x] T008 Extend `DocSource.fetch` return type to include `storePath: string` (file: packages/cli/src/sources/index.ts) (depends on T004)
- [x] T009 Update `NpmSource.fetch` to write into `<ASK_HOME>/npm/<pkg>@<version>/` via `writeEntryAtomic`; local-first short-circuit path still returns the store path after materializing (file: packages/cli/src/sources/npm.ts) (depends on T008)
- [x] T010 Update `GithubSource.fetch` to use `withBareClone` first, tar.gz fallback second; materialize into `<ASK_HOME>/github/checkouts/<owner>__<repo>/<ref>/` (file: packages/cli/src/sources/github.ts) (depends on T006, T008)
- [x] T011 Update `WebSource.fetch` to write into `<ASK_HOME>/web/<sha256-of-normalized-url>/` (file: packages/cli/src/sources/web.ts) (depends on T008)
- [x] T012 [P] Update any `LlmsTxtSource` adapter similarly (if present; inspect first and skip if not yet wired) (depends on T008)
- [x] T013 Update `storage.ts:saveDocs` to take `{ storeMode, storePath }`; implement `copy` (recursive cp), `link` (symlink with EPERM→copy fallback), `ref` (no-op) branches (file: packages/cli/src/storage.ts) (depends on T004, T008)
- [x] T014 Update `install.ts:runInstall` to resolve `storeMode` precedence (CLI flag > ask.json > 'copy') once per run; thread it through `installOne` and `saveDocs`; persist `storePath` + `materialization` in the resolved cache entry (file: packages/cli/src/install.ts) (depends on T001, T002, T013)
- [x] T015 Update `agents.ts:generateAgentsMd` to read `materialization` + `storePath` from each resolved entry and emit the right AGENTS.md target path per mode (file: packages/cli/src/agents.ts) (depends on T014)
- [x] T016 Add `--store-mode=<copy|link|ref>` flag to `installCmd` and `addCmd`; pass through to `runInstall` (file: packages/cli/src/index.ts) (depends on T014)
- [x] T017 Create `packages/cli/src/store/cache.ts` with pure `cacheLs(askHome)` and `cacheGc(askHome, { olderThan, dryRun, referencedKeys })` functions (file: packages/cli/src/store/cache.ts) (depends on T004)
- [x] T018 Add `cacheCmd` with `ls` and `gc` subcommands to the CLI; `gc` walks `$HOME` (or `ASK_GC_SCAN_ROOTS`) for `.ask/resolved.json` files to build the "referenced keys" set before deleting (file: packages/cli/src/index.ts) (depends on T017)
- [x] T019 Add tests for `cacheLs` and `cacheGc` including dry-run and the referenced-keys scanner (file: packages/cli/test/store/cache.test.ts) (depends on T017, T018)
- [x] T020 Integration test: fresh project `ask install` creates both `~/.ask/npm/next@16.2.3/` and `.ask/docs/next@16.2.3/`, bytes match (file: packages/cli/test/install.store.test.ts) (depends on T014, T016)
- [x] T021 Integration test: second project on the same `ASK_HOME` with the same `next@16.2.3` hits the store, no network (mock fetch + assert zero calls) (file: packages/cli/test/install.store.test.ts) (depends on T014)
- [x] T022 Integration test: `--store-mode=link` creates a symlink on POSIX and falls back to copy on simulated EPERM (file: packages/cli/test/install.store.test.ts) (depends on T013, T016)
- [x] T023 Integration test: `--store-mode=ref` writes AGENTS.md with `<ASK_HOME>/npm/next@16.2.3/` and does NOT create `.ask/docs/next@16.2.3/` (file: packages/cli/test/install.store.test.ts) (depends on T014, T015, T016)
- [x] T024 Integration test: GitHub source installs two refs of the same repo, exactly one bare clone materializes (file: packages/cli/test/sources/github.bare.test.ts) (depends on T010)
- [x] T025 Concurrency test: two in-process installs racing on the same `(pkg, version)` — one fetches, the other waits and reads the finalized entry (file: packages/cli/test/store/concurrency.test.ts) (depends on T004, T014)
- [x] T026 Update CHANGELOG with store + ASK_HOME + `cache` commands + `storeMode` options (file: packages/cli/CHANGELOG.md) (depends on T014, T018)
- [x] T027 Update root `README.md` with a "Global store" section: layout, `ASK_HOME`, `storeMode` modes, when to pick which, Windows note (file: README.md) (depends on T014, T018)
- [x] T028 Run `bun run build && bun test` across all workspaces; fix any breakage; verify example/ project still installs cleanly (depends on T020–T026)

## Dependencies

```
T001 ─┐
T002 ─┼─ T003 (schema tests)
      │
T004 ─┼─ T005 (store unit tests)
      ├─ T006 ─ T007 (github-bare tests)
      ├─ T008 ─┬─ T009 (npm source)
      │        ├─ T010 (github source, also deps T006)
      │        ├─ T011 (web source)
      │        └─ T012 (llms-txt if present)
      └─ T017 ─┬─ T018 ─ T019 (cache tests)
               │
T013 ─ T014 ─┬─ T015 ─ T023
             ├─ T016 ─ T020, T022, T023
             ├─ T021
             └─ T025

T010 ─ T024

T014, T018 ─ T026, T027

T020–T026 ─ T028
```

## Verification

- **Functional**:
  - Fresh `~/.ask/`: `bun run --cwd packages/cli build && cd example && node ../packages/cli/dist/cli.js install` → `~/.ask/npm/next@16.2.3/` materialized, `.ask/docs/next@16.2.3/` copied (bytes match).
  - Second project: `mkdir /tmp/example2 && cp example/package.json example/ask.json /tmp/example2 && cd /tmp/example2 && bun install && node <cli-path> install` → second install is store-hit, no npm fetch.
  - `--store-mode=link`: verify `readlinkSync('.ask/docs/next@16.2.3')` resolves under `~/.ask/`. Delete symlink, re-run, confirm recreate.
  - `--store-mode=ref`: grep `AGENTS.md` for `<ASK_HOME>`-expanded absolute path, confirm no `.ask/docs/next@16.2.3/` directory.
  - `ASK_HOME=/tmp/askh node <cli-path> install` → all writes go under `/tmp/askh/`.
  - `ask cache ls` lists entries. `ask cache gc --dry-run` reports candidates. `ask cache gc` removes them after confirmation (non-interactive in tests).
  - GitHub source with two refs: observe `<ASK_HOME>/github/db/vercel__next.js.git/` exists once, `<ASK_HOME>/github/checkouts/vercel__next.js/v16.2.3/` and `.../v16.2.4/` both exist after running both installs.
  - Concurrent install: spawn two `runInstall` promises targeting the same `(pkg, version)` with a mocked source that records fetch count; assert fetch count === 1 and both promises resolve successfully.
- **Non-regression**:
  - `bun test` across all packages green.
  - Existing `example/` project installs and produces byte-identical `AGENTS.md` compared to pre-change (assuming default `storeMode: copy`).
  - `ask remove` still tears down per-project materialization regardless of store mode.
- **Docs**:
  - CHANGELOG describes: store at `~/.ask/`, `ASK_HOME` override, `storeMode` options, `cache ls|gc` commands, github bare-clone behavior.
  - README has a "Global store" section with a tree diagram + Windows symlink note + migration guidance.

## Progress

- Spec drafted
- Plan drafted
- All 28 tasks implemented (2026-04-10)
- Code review completed: 7 Critical + 12 Important issues identified
- (2026-04-11 09:50 KST) Review fixes applied (SHA: `0826f9f`) — security hardening, store layout fix, missing tests added, spec compliance SC-2/SC-7

## Decision Log

- 2026-04-10: Chose `~/.ask/` over `~/.cache/ask/` or `~/.local/share/ask/` based on the PM survey: Cargo/bun/rustup/npm all use `~/.<tool>/`, the store is semantically data (not cache — deletion breaks projects on `link`/`ref` modes), and cross-platform path stability matters for AGENTS.md. `ASK_HOME` override gives XDG-strict users a one-line escape.
- 2026-04-10: Default `storeMode` is `copy` (not `link`) because (a) Windows symlink privileges are unreliable, (b) it preserves byte-for-byte output, (c) it makes the upgrade silent. `link`/`ref` are opt-in.
- 2026-04-10: `github:` source uses bare clone + checkouts (Cargo pattern) instead of keeping the tar.gz approach. Rationale: multi-ref projects currently re-download the whole repo per ref, which wastes bandwidth and disk. Bare clone reuses git's object store across refs for free.
- 2026-04-10: `ref` mode requires agent sandbox access to `$HOME`. This is fine for local dev and most Claude Code installs but NOT for Docker/CI — so default stays `copy`.
- 2026-04-10: `cache gc` scans `$HOME` for `.ask/resolved.json` to compute the referenced-keys set. Users with projects outside `$HOME` set `ASK_GC_SCAN_ROOTS=/path1:/path2`. Simple and explicit.

## Surprises & Discoveries

- The tar.gz fallback in `GithubSource` originally wrote only flat doc files to the store but the store-hit fast path re-parsed as a repo root — creating a permanent failure mode on git-less machines. Caught in code review. Fixed by copying the full extracted repo root to the store.
- `execSync` with template-string interpolation in `curl | tar` pipeline was a command injection vector. Replaced with Node `fetch` + `spawnSync` discrete args (no shell).
- `acquireEntryLock` initially deleted the lock file on timeout — dangerous when the holder was still alive. Changed to throw a descriptive error instead.
- `withBareClone` tests initially ran `git clone --bare` manually rather than calling the function under test, providing false confidence. Rewritten with an injectable `remoteUrl` option so tests point at a local file-path repo.

## Outcomes & Retrospective

### What Was Shipped

- Global ASK docs store at `~/.ask/` with `ASK_HOME` override
- Three materialization modes (`copy` / `link` / `ref`) configurable via CLI flag and `ask.json`
- All four source adapters (npm, github, web, llms-txt) integrated with store
- GitHub bare clone + archive-extract for efficient multi-ref handling
- `ask cache ls` and `ask cache gc` (with `--dry-run` and `--older-than <duration>`)
- Schema additions: `storeMode`, `storePath`, `materialization` — backward-compatible
- 342 tests passing (60 schema + 282 cli), +12 tests added during review-fix cycle

### What Went Well

- TDD-style incremental commits: 10 well-scoped commits made review straightforward
- Code review loop (4 parallel reviewer agents + spec compliance check) surfaced real security bugs that simple lint/tests missed
- Atomic swap pattern (`rename-to-backup`) minimized race windows without sacrificing simplicity
- Schema additions were additive and backward-compatible — no breaking changes to existing `ask.json` files

### What Could Improve

- Initial test suite was too mechanical — several tests re-implemented the logic they were supposed to exercise instead of calling the functions under test. Test coverage gaps were only caught by the `review:test-analyzer` agent.
- Should have added `withBareClone`'s injectable `remoteUrl` option from the start, rather than hardcoding `github.com/` and retrofitting a test seam during review.
- Command injection risk in `execSync` pipeline was pre-existing code I moved into a new function without noticing — need to audit shell-outs as part of the refactor checklist.

### Tech Debt Created

- `tryLocalRead` now logs parse failures at `consola.debug` level, but verbose-flag wiring is not yet hooked up (debug output is suppressed by default). Will surface if users hit malformed `package.json` in `node_modules`.
- `cacheGc` scanner uses a hard-coded max depth of 8; real-world monorepos with deep nesting may miss `.ask/resolved.json` files. Acceptable for v1, revisit if users report misses.
- GitHub bare clone uses `git fetch origin <ref> --depth=1` which only works when the remote allows `uploadpack.allowAnySHA1InWant`. github.com enables it, but self-hosted instances may not — need to document or detect.
