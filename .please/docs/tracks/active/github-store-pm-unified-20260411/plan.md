# Plan: GitHub Store — PM-Unified Layout

> Track: github-store-pm-unified-20260411
> Spec: [spec.md](./spec.md)

## Overview

- **Source**: /please:plan
- **Track**: github-store-pm-unified-20260411
- **Issue**: (pending)
- **Created**: 2026-04-12
- **Approach**: opensrc-style flat nested layout, vertical slices, TDD

## Purpose

Eliminate five structural correctness defects and two spot defects in the `github`-kind store by restructuring the on-disk layout and tightening ref validation. See spec.md for the full defect enumeration and success criteria.

## Context

The current store keeps shared bare clones at `<askHome>/github/db/<owner>__<repo>.git/` and per-ref checkouts at `<askHome>/github/checkouts/<owner>__<repo>/<ref>/`. This is the only source kind that uses shared state across entries; npm/web/llms-txt all key on `<kind>/<identity>@<version>/`. The split causes `owner__repo` flattening collisions, `FETCH_HEAD` races, and other issues enumerated in the spec and idea doc.

The target layout `<askHome>/github/<host>/<owner>/<repo>/<tag>/` mirrors `vendor/opensrc/packages/opensrc/cli/src/core/cache.rs:83` and the PM mental model.

## Architecture Decision

**Rejected:** Surgical fix keeping the flattened path + bare clone subsystem. Collapses 1 defect, leaves 4.

**Chosen:** opensrc-style nested layout + shallow clone per tag + delete `store/github-bare.ts`. Trades object-level dedup across tags for structural defect elimination. Matches how every general-purpose PM treats versioned artifacts (cargo/bun/go/pnpm all key on name@version).

**Schema is the source of truth for ref validity.** Mutable-ref refinement lives in `packages/schema/src/ask-json.ts` via a schema factory; CLI `--allow-mutable-ref` flag selects the lax variant. Both Zod variants are exported so the CLI stays the only place that chooses which to use.

**`ResolvedEntry.commit`** is populated from the existing `FetchResult.meta.commit` (already captured via `git ls-remote` for github entries). No new network call in the common path; the shallow-clone path additionally captures commit via `git rev-parse HEAD` before `.git/` removal as a cross-check.

## Key Files

- `packages/schema/src/ask-json.ts` — add ref refinement + schema factory
- `packages/schema/src/resolved.ts` — add `commit?: string` (40-hex regex)
- `packages/cli/src/sources/index.ts` — add `FetchResult.storeSubpath?: string`
- `packages/cli/src/store/index.ts` — replace `githubDbPath`/`githubCheckoutPath` with `githubStorePath`; add `writeStoreVersion`, `detectLegacyLayout`
- `packages/cli/src/store/github-bare.ts` — **DELETE**
- `packages/cli/src/store/github-bare.test.ts` — **DELETE**
- `packages/cli/src/sources/github.ts` — rewrite: shallow clone at tag, tag fallback, `.git/` strip, commit capture, `storeSubpath` return, new layout, `verifyEntry` guard
- `packages/cli/src/install.ts` — npm store-hit `verifyEntry` guard + quarantine; propagate `result.meta.commit` into `ResolvedEntry`; legacy warning on install start
- `packages/cli/src/storage.ts` — link/ref mode uses `path.join(storePath, storeSubpath ?? '')`
- `packages/cli/src/agents.ts` — same join for ref mode display path
- `packages/cli/src/store/cache.ts` — support new layout in `cacheLs`; add `cacheCleanLegacy`
- `packages/cli/src/index.ts` — `--allow-mutable-ref` flag on install+add; `cache clean --legacy` subcommand
- `README.md`, `ARCHITECTURE.md`, `CLAUDE.md` (gotchas) — documentation updates

## Tasks

- [x] T001 [P] Schema: add `FetchResult.storeSubpath` (file: packages/cli/src/sources/index.ts) — also add `commit?: string` (40-hex regex) to ResolvedEntry (file: packages/schema/src/resolved.ts). RED: parse tests for new optional fields. GREEN: add fields. Acceptance: existing resolved.json files parse without error; new fields round-trip through Zod.
- [x] T002 [P] Schema: mutable-ref refinement with factory (file: packages/schema/src/ask-json.ts). RED: test matrix — accepted: 40-hex SHA, `v1.2.3`, `1.2.3`, `v0.0.0-beta.1`, `release-2024.01`; rejected: `main`, `master`, `develop`, `trunk`, `HEAD`, `latest`, empty, whitespace. GREEN: export `createAskJsonSchema({ strictRefs: boolean })` factory; keep existing `AskJsonSchema` as the strict default; export `LaxAskJsonSchema` for the escape-hatch path. Acceptance: strict rejects mutable refs with descriptive message pointing to `--allow-mutable-ref`; lax accepts everything the old schema did.
- [x] T003 Store helpers: add `githubStorePath`, remove legacy helpers (file: packages/cli/src/store/index.ts). RED: unit tests for `githubStorePath(askHome, 'github.com', 'facebook', 'react', 'v18.2.0')` resolving to the nested path; traversal attempts rejected. GREEN: add `githubStorePath` with `assertContained` guard; delete `githubDbPath` and `githubCheckoutPath` exports. Acceptance: all callers of the deleted helpers fail to compile (forces the rewrite in subsequent tasks). (depends on T001)
- [x] T004 Delete bare-clone subsystem (file: packages/cli/src/store/github-bare.ts). Delete the file and its `github-bare.test.ts`. Temporarily breaks `sources/github.ts` imports; to be restored by T005. Acceptance: files removed; `bun run test` will fail on compile until T005 lands. (depends on T003)
- [x] T005 GitHub source rewrite — shallow clone + nested layout + storeSubpath (file: packages/cli/src/sources/github.ts). RED: tests for (a) shallow clone at tag against a local `file://` origin, (b) tag fallback: `1.2.3` → tries `1.2.3` then `v1.2.3`; `v1.2.3` → tries only `v1.2.3` (never `vv1.2.3`), (c) `.git/` removed post-clone, (d) commit SHA captured via `git rev-parse HEAD` before `.git/` removal and returned in `meta.commit`, (e) `storeSubpath` populated from `opts.docsPath` (or detected docs path), (f) `cpDirAtomic` + `acquireEntryLock` + `stampEntry` pipeline, (g) store-hit short-circuit checks the new path AND runs `verifyEntry` — on failure, quarantines + re-clones, (h) `fetchFromTarGz` fallback updated to write to the new layout and return `storeSubpath`. GREEN: implement the shallow-clone path + update the tarball fallback. Acceptance: all tests pass; `.ask/resolved.json` receives a populated `commit`; legacy paths never appear on the new install path. (depends on T003, T004)
- [x] T006 Install orchestrator: store-hit verifyEntry guard + commit propagation (file: packages/cli/src/install.ts). RED: (a) corrupted npm store entry (tampered file under `<askHome>/npm/<pkg>@<ver>/`) on install triggers quarantine to `<askHome>/.quarantine/<ts>-<uuid>/` and re-fetches, (b) `ResolvedEntry.commit` is recorded on github install, (c) quarantine fires only when `verifyEntry` returns false (hash present but mismatch) — missing hash file also quarantines since the entry was never stamped. GREEN: wrap the store-hit `fs.existsSync(storeDir)` check at `install.ts:274` with `&& verifyEntry(storeDir)`; add a shared `quarantineEntry(askHome, storeDir)` helper in `store/index.ts`; thread `result.meta?.commit` into `upsertResolvedEntry`. Acceptance: SC-4, SC-6 met. (depends on T001, T005)
- [x] T007 Storage: link/ref subpath wiring (file: packages/cli/src/storage.ts) — plus `generateAgentsMd` (file: packages/cli/src/agents.ts). RED: (a) link mode with `docsPath: 'docs'` creates a symlink whose target is `<storePath>/docs`, not `<storePath>`; (b) ref mode returns the same joined path; (c) `storeSubpath` unset falls back to `<storePath>` unchanged (no regression for npm). GREEN: compute `effectivePath = path.join(storePath, storeSubpath ?? '')` in both branches. Acceptance: SC-3 met. (depends on T005)
- [x] T008 CLI escape hatch: `--allow-mutable-ref` (file: packages/cli/src/index.ts). RED: `ask install` with an `ask.json` entry `ref: "main"` fails with a descriptive error; same command with `--allow-mutable-ref` succeeds. `ask add github:owner/repo --ref main` behaves the same way. GREEN: add the flag via citty; thread it to `readAskJson` via a `{ strictRefs: boolean }` parse option that selects strict vs lax schema. Acceptance: SC-5 met. (depends on T002)
- [x] T009 Legacy detection + STORE_VERSION + `ask cache clean --legacy` (files: packages/cli/src/store/index.ts, packages/cli/src/store/cache.ts, packages/cli/src/index.ts, packages/cli/src/install.ts). RED: (a) on install start, if `<askHome>/github/db` or `<askHome>/github/checkouts` exists, a warning is printed pointing at `ask cache clean --legacy`; (b) `<askHome>/STORE_VERSION` equals `"2"` after any successful install against a fresh ASK_HOME; (c) `ask cache clean --legacy` removes both legacy dirs and exits cleanly (idempotent); (d) `ask cache ls` continues to work when both layouts coexist — new layout under `github/github.com/**`, legacy under `github/checkouts/**` shown with a `(legacy)` tag. GREEN: implement `writeStoreVersion`, `detectLegacyLayout`, `cacheCleanLegacy`; wire CLI; update `cacheLs` walk to skip `github/db` and traverse both `github/github.com/**` and `github/checkouts/**`. Acceptance: SC-7, SC-8 met; Q3 resolved as "inline with `(legacy)` tag". (depends on T003, T005)
- [x] T010 Integration tests (file: packages/cli/src/sources/github.test.ts, packages/cli/src/install.test.ts). (a) Concurrent install of two different tags of the same small public repo against a fresh ASK_HOME — both succeed, two separate directories, no lock contention, no FETCH_HEAD race (SC-2). (b) Corrupted store entry quarantine + re-fetch end-to-end (SC-4). (c) A3 `.git/` dependency audit — automated grep for `.git` inside `packages/cli/src` (excluding github.ts clone path) reports zero post-clone consumers; audit result captured as a comment at the top of github.ts. Acceptance: all integration tests pass; A3 audit logged in PR body. (depends on T005, T006, T007, T008, T009)
- [x] T011 Pre-implementation audits (one-shot scans, logged in PR body, NOT in code). (a) A2: scan `apps/registry/content/registry/**/*.md` and any committed `ask.json` samples for duplicate `owner/repo` with different `ref` — report count + ratio. (b) A4: run the new mutable-ref heuristic against every committed `ref` in registry entries and `ask.json` samples — report false-positive count. These are scans, not code. Acceptance: both reports included in the PR description; if A4 > 1% false-positive rate, halt and add exceptions before merge. (depends on T002, can run in parallel with T003-T009)
- [x] T012 Documentation updates (files: README.md, ARCHITECTURE.md, CLAUDE.md). Document: (a) new github store layout, (b) `--allow-mutable-ref` flag with rationale, (c) `ask cache clean --legacy` migration instructions, (d) `STORE_VERSION` file, (e) gotchas entry for "don't reintroduce bare-clone-subsystem" and "github store paths are nested not flattened". Acceptance: README install examples reference new flag; ARCHITECTURE.md store section rewritten; CLAUDE.md has a new gotcha. (depends on T005, T009)

## Dependencies

```
T001 ───┬───── T003 ── T004 ── T005 ─┬── T006 ─┐
        │                            ├── T007 ─┤
        │                            └── T009 ─┤
        │                                      │
T002 ───┴──── T008 ───────────────────────────┤
                                               ├── T010
                                               └── T012

T011 runs in parallel, gated only by T002.
```

## Verification

- `bun run test` passes (unit + new integration)
- `bun run lint` passes
- Manual smoke: `rm -rf ~/.ask/github && ask install` in a project with at least one github entry — new layout, `STORE_VERSION=2`, `.ask/resolved.json` records `commit`
- Manual legacy flow: `mkdir -p ~/.ask/github/db && ask install` — legacy warning printed; `ask cache clean --legacy` removes the dir
- A2, A3, A4 audit reports attached to PR body

## Progress

- [x] T001 Schema: storeSubpath + commit field
- [x] T002 Schema: mutable-ref refinement
- [x] T003 Store helpers: githubStorePath
- [x] T004 Delete bare-clone subsystem
- [x] T005 GitHub source rewrite
- [x] T006 Install orchestrator verifyEntry + commit
- [x] T007 Storage link/ref subpath wiring
- [x] T008 CLI --allow-mutable-ref flag
- [x] T009 Legacy detection + cache clean --legacy
- [x] T010 Integration tests
- [x] T011 Pre-implementation audits (A2, A4)
- [x] T012 Documentation updates

## Decision Log

- **2026-04-11** — Direction 6 (opensrc-style flat nested layout) chosen over Direction 1 (surgical) and Direction 5 (tmp-checkout). Collapses 4 of 5 defects structurally; PM-convention aligned.
- **2026-04-11** — Ref validation: Schema + CLI escape hatch via factory. Rejected CLI-only (loses DRY) and Schema-only (blocks CI/test).
- **2026-04-11** — `ResolvedEntry.commit` included in this track (Q5 resolution); already cheap since `FetchResult.meta.commit` is populated.
- **2026-04-11** — A1 network benchmark deferred to follow-up.
- **2026-04-11** — `apps/registry` removal is a separate track.
- **2026-04-12** — Q3 resolved: `ask cache ls` shows legacy entries inline with a `(legacy)` tag (no `--legacy` flag needed).

## Surprises & Discoveries

- `FetchResult.meta.commit` already exists — filling `ResolvedEntry.commit` is just a propagation, not new plumbing.
- `verifyEntry` already exists in `store/index.ts:286` but is never called on store-hit branches. The fix is a one-liner `&& verifyEntry(storeDir)` — the hard part is the quarantine semantics.
- The current npm store-hit branch in `install.ts:271-298` is the only caller of `store.npmStorePath`; adding `verifyEntry` there covers the npm path too, not just github.
