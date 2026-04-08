# Plan: npm tarball docs (dist/docs) utilization

> Track: npm-tarball-docs-20260408
> Spec: [spec.md](./spec.md)

## Overview

- **Source**: /please:plan
- **Track**: npm-tarball-docs-20260408
- **Issue**: TBD
- **Created**: 2026-04-08
- **Approach**: Two-tier (Registry-curated fast path + LLM discovery fallback) with local-`node_modules`-first npm source

## Purpose

Make ASK exploit `dist/docs/` when authors ship them inside the npm tarball (`ai`, `@mastra/core`, `@mastra/memory`, `next` canary). Today the CLI delegates npm specs to the GitHub source even when an npm strategy is registered, and the `NpmSource` class is marked deprecated and lacks `node_modules` shortcut. The result is unnecessary network IO and missed first-party docs.

## Context

Discovery during exploration:

- `packages/schema/src/registry.ts` already accepts `source: 'npm'` and `docsPath` — **no schema change needed**.
- `apps/registry/content/registry/vercel/next.js.md` already declares an npm strategy with `dist/docs` — prior art exists.
- `packages/cli/src/registry.ts:173` defines `SOURCE_PRIORITY = { github: 0, npm: 1, ... }`. `selectBestStrategy` therefore picks the GitHub strategy even when both are listed → the npm path is effectively dead. **This is the root blocker.**
- `packages/cli/src/sources/npm.ts` is marked `@deprecated` and downloads via `curl | tar`. It already supports `docsPath` but never reads `node_modules`.
- `packages/cli/src/resolvers/npm.ts` always returns `repo` + `ref` for github source — there is no path that hands off to `NpmSource`.
- `packages/cli/src/skill.ts` is a 68-line file that emits a flat SKILL.md template — fallback section will be a small template addition.

Reference for the telemetry design doc: https://github.com/vercel-labs/skills/blob/main/src/telemetry.ts

## Architecture Decision

Three intertwined fixes:

1. **Source selection** — Replace the static `SOURCE_PRIORITY` with a context-aware picker. When a strategy explicitly declares `source: 'npm'` with a `docsPath`, that strategy wins over a github strategy in the same entry. Remaining ties keep github > web > llms-txt order. Rationale: the next.js Nuxt-UI eval result that motivated github=0 was about *unspecified* fallbacks, not about author-curated `dist/docs`.

2. **NpmSource revival, local-first** — Un-deprecate `NpmSource`. Add a `tryLocalRead({ projectDir, pkg, version, docsPath })` step that runs before any network call:
   - Read `node_modules/<pkg>/package.json`.
   - If `version` is `latest` OR matches the installed version (semver `satisfies`), and `<docsPath>` exists in the install directory, collect markdown files from there and return `FetchResult` with `resolvedVersion = installed.version` and `meta.source = 'node_modules'`.
   - Otherwise fall through to existing tarball path.

3. **Source dispatch from registry** — `resolveFromRegistry` keeps returning `{ strategy }`, but the call site (currently ends up calling github) must branch on `strategy.source`. Add an `executeStrategy(strategy, ctx)` helper that maps `npm → NpmSource.fetch`, `github → GithubSource.fetch`, `web → WebSource.fetch`, `llms-txt → ...`. The dispatch lives next to the resolver consumer in `index.ts`.

Tier 2 (skill fallback) is purely a template change in `skill.ts` plus its snapshot test — no runtime change. The agent reads the skill, walks `node_modules`, and decides for itself.

Telemetry is design-only: a markdown document under `design/telemetry.md` analyzing the vercel-labs/skills `telemetry.ts` reference and proposing an opt-in model. No code, no dependency.

## Architecture Diagram

```
ask docs add npm:ai
        │
        ▼
┌─────────────────────────────┐
│ resolveFromRegistry         │
│  → fetch registry entry     │
│  → expandStrategies         │
│  → selectBestStrategy*      │  (* npm+docsPath now wins over github)
└──────────────┬──────────────┘
               │ strategy
               ▼
┌─────────────────────────────┐
│ executeStrategy             │
├──────┬─────────┬────────────┤
│ npm  │ github  │ web/llms   │
└──┬───┴────┬────┴────┬───────┘
   ▼        ▼         ▼
NpmSource  Github   Web/...
   │
   ├─ tryLocalRead(node_modules) ──hit──▶ FetchResult
   │
   └─ download tarball ────────────────▶ FetchResult

(Tier 2: when no registry entry exists,
 the generated *-docs SKILL.md tells the
 agent to walk node_modules itself.)
```

## Tasks

- [x] T001 [P] Add seed registry entry for `vercel/ai` with npm strategy `docsPath: dist/docs` and `npm:ai` alias (file: apps/registry/content/registry/vercel/ai.md)
- [x] T002 [P] Add seed registry entry for `mastra-ai/mastra` with npm strategies for `@mastra/core` and `@mastra/memory` plus aliases (file: apps/registry/content/registry/mastra-ai/mastra.md)
- [x] T003 Replace static SOURCE_PRIORITY with context-aware `selectBestStrategy` so an npm strategy carrying `docsPath` outranks a github strategy in the same entry; keep ties stable (file: packages/cli/src/registry.ts)
- [x] T004 [P] Unit tests for the new `selectBestStrategy` covering: (a) github-only, (b) npm-with-docsPath beats github, (c) npm-without-docsPath does NOT beat github, (d) tie-break stability (file: packages/cli/test/registry.test.ts)
- [x] T005 Un-deprecate `NpmSource` and add a private `tryLocalRead({ projectDir, pkg, version, docsPath })` returning `FetchResult | null`; honor semver satisfies and skip on missing `docsPath` (file: packages/cli/src/sources/npm.ts) (depends on T003)
- [x] T006 Wire `tryLocalRead` into `NpmSource.fetch` as the first step before tarball download; bubble `meta.source = 'node_modules'` and skip tarball entirely on hit (file: packages/cli/src/sources/npm.ts) (depends on T005)
- [x] T007 Add `executeStrategy(strategy, ctx)` dispatcher that routes registry strategies to the matching source; remove the implicit github-only assumption from the `add` command flow (file: packages/cli/src/index.ts) (depends on T003)
- [x] T008 [P] Unit tests for `tryLocalRead`: hit on exact match, hit on semver satisfies, miss on version mismatch, miss on absent `docsPath`, miss on absent `node_modules` (file: packages/cli/test/sources/npm.test.ts) (depends on T006)
- [x] T009 [P] Integration test: with `ai` installed under a fixture project and `vercel/ai` registry entry mocked, `ask docs add npm:ai` produces files from `node_modules/ai/dist/docs` and makes zero outbound HTTP calls (file: packages/cli/test/integration/npm-local-first.test.ts) (depends on T007)
- [x] T010 [P] Integration test for scoped + monorepo packages: same flow for `npm:@mastra/core` and `npm:@mastra/memory` (file: packages/cli/test/integration/npm-scoped.test.ts) (depends on T007)
- [x] T011 Extend `generateSkill` SKILL.md template with a "When the docs cannot be found" fallback section that walks `node_modules/<pkg>/{dist/docs,docs,*.md}` and suggests `ask docs add npm:<pkg>` for promotion (file: packages/cli/src/skill.ts)
- [x] T012 [P] Snapshot/text test for the new fallback section in generated SKILL.md (file: packages/cli/test/skill.test.ts) (depends on T011)
- [x] T013 [P] Write `design/telemetry.md` covering opt-in activation, collected fields (`pkg`, `version`, `docsPath`, `success`), aggregation flow, promotion threshold, privacy/rate-limit considerations, and an analysis of vercel-labs/skills `src/telemetry.ts` (file: .please/docs/tracks/active/npm-tarball-docs-20260408/design/telemetry.md)
- [x] T014 Regression sweep: confirm existing github-only registry entries (lodash, axios, jquery, etc.) still resolve to github source and produce identical `FetchResult.files` count; document the check in the verification log (file: packages/cli/test/integration/regression.test.ts)
- [x] T015 Update CLAUDE.md gotchas with the new "registry npm strategy with docsPath wins over github" rule and the `node_modules`-first behavior (file: CLAUDE.md) (depends on T007)

## Dependencies

```
T001 ┐
T002 ┘   (independent seed entries)

T003 ──► T004 (selector tests)
T003 ──► T005 ──► T006 ──► T008 (npm source local-first chain)
T003 ──► T007 ──► T009, T010 (integration depends on dispatcher)
T007 ──► T015 (gotchas docs)

T011 ──► T012 (skill template + test)

T013   (independent telemetry doc)
T014   (regression — runs last, depends conceptually on T007 wiring)
```

Parallel groups:
- Group A: T001, T002 (independent)
- Group B: T004 (after T003), T013 (independent)
- Group C: T008, T009, T010, T012 (after their respective predecessors)

## Key Files

- `packages/cli/src/registry.ts` — `SOURCE_PRIORITY`, `selectBestStrategy`, `resolveFromRegistry`
- `packages/cli/src/sources/npm.ts` — deprecated `NpmSource`, target of revival + local-first logic
- `packages/cli/src/resolvers/npm.ts` — npm metadata resolver, untouched but referenced
- `packages/cli/src/index.ts` — `add` command flow, will gain `executeStrategy` dispatcher
- `packages/cli/src/skill.ts` — `generateSkill`, template extension point
- `packages/schema/src/registry.ts` — already supports `source: 'npm'` + `docsPath` (read-only)
- `apps/registry/content/registry/vercel/next.js.md` — prior art, mirror its shape for the new entries
- `CLAUDE.md` — gotchas section update

## Verification

- `bun run --cwd packages/cli test` — all unit + integration tests pass
- `bun run --cwd packages/cli build` — typecheck clean
- `bun run lint` — no new violations
- Manual: in a scratch project with `bun add ai @mastra/core @mastra/memory`, run `node packages/cli/dist/index.js docs add npm:ai` and verify the log shows `source: node_modules` and that `.ask/docs/ai@<ver>/` mirrors `node_modules/ai/dist/docs`. Repeat for the two `@mastra/*` packages.
- Network sniff (or `--offline` env): the local-first run must complete without contacting `registry.npmjs.org` for the tarball.
- Regression: pick three existing entries (`lodash`, `axios`, `jquery`) and confirm `ask docs sync` produces the same file set as before this track.
- Acceptance criteria AC-1 through AC-6 in spec.md all marked verified.

## Progress

- [x] Phase 1: Seed registry entries (T001, T002)
- [x] Phase 2: Source selection fix + tests (T003, T004)
- [x] Phase 3: NpmSource local-first + tests (T005, T006, T008)
- [x] Phase 4: Strategy dispatcher + integration tests (T007, T009, T010)
- [x] Phase 5: Skill fallback template + test (T011, T012)
- [x] Phase 6: Telemetry design doc (T013)
- [x] Phase 7: Regression + docs (T014, T015)

## Decision Log

- **2026-04-08**: Schema extension (FR-1 in spec) downgraded — `packages/schema/src/registry.ts` already accepts `source: 'npm'` and `docsPath`. The real blocker is `SOURCE_PRIORITY` in `packages/cli/src/registry.ts`. Plan reflects this.
- **2026-04-08**: Chose context-aware selector over a hard `npm > github` flip. The Nuxt-UI eval that justified github-first still applies when the npm strategy lacks an explicit `docsPath` — only the curated `dist/docs` case overrides.
- **2026-04-08**: NpmSource revived rather than rewritten via `resolvers/npm.ts → github`. Local-first read is impossible from the github path because GitHub source has no concept of an installed package.
- **2026-04-08**: Telemetry kept design-only; vercel-labs/skills `src/telemetry.ts` is the prior-art reference to analyze.

## Surprises & Discoveries

- The vercel/next.js registry entry already ships an npm strategy with `dist/docs` — but the static `SOURCE_PRIORITY` makes it dead code today. Fixing the priority lights up an entry that was waiting for it.
- `NpmSource` was marked `@deprecated` in favor of "resolver + github source", but the deprecation rationale (single-path simplicity) breaks down precisely for the `dist/docs` case. We are reversing course consciously.
