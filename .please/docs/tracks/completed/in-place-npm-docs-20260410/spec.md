# In-place npm docs — reference `node_modules/<pkg>/<subdir>` directly

> Track: in-place-npm-docs-20260410
> Type: refactor

## Overview

When ASK's convention-based discovery finds docs already shipped inside an npm package (`node_modules/<pkg>/dist/docs/`, `node_modules/<pkg>/docs/`, or similar), it currently still copies those files into the project-local `.ask/docs/<pkg>@<v>/`. This is wasteful on three axes:

1. **Disk duplication**: 421 files (Next.js case) duplicated into `.ask/docs/` for no reason — the same bytes already sit under `node_modules/next/dist/docs/`.
2. **Freshness lag**: After `bun install` bumps `next@16.2.3 → 16.2.4`, `node_modules/` updates instantly but `.ask/docs/next@16.2.3/` stays stale until the user remembers to run `ask install`. The AGENTS.md version claim and the actual docs on disk disagree between those two moments.
3. **Lifecycle mismatch**: Both `ask install` and `bun install` claim responsibility for the same bytes. Any convention-based discovery entry is fundamentally an npm-owned artifact; ASK treating it as its own creates a second source of truth that has to be kept in sync.

This track changes convention-based npm discovery to **reference `node_modules/<pkg>/<subdir>` directly** from AGENTS.md instead of copying. The copying path stays for every other source (`github:`, `web:`, `llms-txt:`, and npm tarball fetches where `node_modules` doesn't already have the docs). The existing `generateSkill` helper already supports an in-place mode via `GenerateSkillOptions.docsDir` — half the work is already plumbed.

This is **complementary to `global-docs-store-20260410`**, not a substitute. Global store covers the "ASK needs to materialize files somewhere" cases (github fetches, web crawls, npm tarball miss). This track covers the "the docs already exist in `node_modules` — stop duplicating them" case. Both can ship in either order.

## Motivation

- **Zero-cost freshness**: `bun install` automatically refreshes the docs the agent reads. No `ask install` needed after a version bump if the package ships its own docs.
- **Disk savings scale with package size**: `next@16.2.3` ships 421 doc files (~several MB). Multiply by every ASK user and every Next.js project. The savings compound.
- **Aligns with Vercel's `AGENTS.md outperforms skills` benchmark**: that benchmark's `with-ask` experiment already uses `node_modules/next/dist/docs/` as the AGENTS.md target, and it scored 100%. ASK should match that pattern for packages that actually do ship in-place docs.
- **Cleaner mental model**: "If the package shipped the docs, read them from the package. If not, ASK downloads them." The two paths have different owners and should look different on disk.
- **Code is ready**: `packages/cli/src/skill.ts:22-28` already defines `GenerateSkillOptions.docsDir` with `inPlace: true` semantics, and `packages/cli/src/discovery/local-intent.ts` / `local-conventions.ts` already return a `docsDir` pointing at `node_modules`. The install orchestrator currently ignores that signal and copies anyway.

## Scope

### 1. Discovery result shape

Convention-based adapters (`packages/cli/src/discovery/local-ask.ts`, `local-intent.ts`, `local-conventions.ts`) already return a discovery result with a `docsDir` field pointing at an absolute or project-relative path inside `node_modules/`. The install orchestrator needs to:

- Recognize when a discovery result came from a `node_modules`-local adapter (tag: `inPlace: true`).
- Skip `saveDocs` entirely for that entry.
- Still call `generateSkill` with `{ docsDir: <node_modules-relative path> }` (already supported).
- Write a resolved-cache entry with a new `materialization: 'in-place'` marker and a `inPlacePath: <project-relative path to node_modules/<pkg>/<subdir>>` field.

### 2. AGENTS.md generation

`packages/cli/src/agents.ts:generateAgentsMd` must read the resolved-cache entry and, for in-place entries, emit an AGENTS.md block that points at `node_modules/<pkg>/<subdir>/` instead of `.ask/docs/<pkg>@<v>/`. The block content should explicitly note the path is PM-managed:

```markdown
## next v16.2.3

> **WARNING:** This version may differ from your training data.
> Read the docs in `node_modules/next/dist/docs/` before writing any next-related code.
> These docs are shipped by the package — `bun install` keeps them in sync.
> Heed deprecation notices and breaking changes.

- **Version**: `16.2.3` — use `"^16"` in package.json
- Documentation: `node_modules/next/dist/docs/`
```

### 3. Ignore-files semantics

When the docs live under `node_modules/`, the "don't lint/format this" problem is solved automatically because every reasonable toolchain already ignores `node_modules/`. The nested config writer in `ignore-files.ts` does NOT need to create anything under `node_modules/<pkg>/` — that would be both invasive (modifying a package's files) and pointless. The existing root ignore patches for `.ask/docs/` still run, but they become no-ops for in-place entries (no files in `.ask/docs/` → nothing to ignore).

### 4. `ask remove`

Removing an in-place entry must:

- NOT touch `node_modules/<pkg>/` (that's npm's territory).
- Remove the entry from `.ask/resolved.json`.
- Regenerate AGENTS.md so the block for that entry disappears.
- Remove any existing `.claude/skills/<pkg>-docs/SKILL.md` (idempotent, already done by `removeSkill`).

### 5. Backward compatibility

Entries that were previously copied into `.ask/docs/<pkg>@<old-v>/` by older ASK versions are **not** auto-migrated. On the next `ask install`:

- The old `.ask/docs/<pkg>@<old-v>/` directory is removed (same as today's "version changed" cleanup in `storage.ts`).
- The new resolved-cache entry has `materialization: 'in-place'`.
- AGENTS.md is regenerated with the new path.

No user action required. The upgrade is silent.

### 6. Opt-out escape hatch

Some users may want the old copy behavior (e.g. to vendor docs into a repo, to ship them alongside the project for offline contexts, or to patch them). Add an `ask.json` field:

```json
{ "inPlace": false }
```

and a CLI flag `--no-in-place` on `installCmd` / `addCmd`. Precedence: CLI flag > ask.json > default `true`.

Default `true` (in-place when possible) because the motivation section above argues the copying path is net negative for this case.

## Success Criteria

- [ ] SC-1: Running `ask install` on a project whose `ask.json` has `{ "spec": "npm:next" }` and which has `node_modules/next/dist/docs/` present (next@16+ canary/stable): the CLI does NOT create `.ask/docs/next@16.2.3/`. AGENTS.md points at `node_modules/next/dist/docs/`.
- [ ] SC-2: The generated AGENTS.md block for `next` explicitly says "shipped by the package" / "kept in sync by `bun install`" or equivalent wording, differentiating it from the vendored-docs wording used for `github:`/`web:` sources.
- [ ] SC-3: After SC-1, running `bun install next@16.2.4` (or any version bump) and then re-running `ask install` with the same ask.json: the CLI re-detects the in-place path, updates the resolved entry's version to `16.2.4`, and regenerates AGENTS.md with the new version marker — no stale `.ask/docs/` residue.
- [ ] SC-4: Running `ask install` on a project whose `node_modules/<pkg>/` has NO shipped docs (e.g. `lodash`): the CLI falls through to the tarball fetch path and writes `.ask/docs/lodash@<v>/` as today. Non-in-place path unchanged.
- [ ] SC-5: Running `ask install --no-in-place` on the SC-1 project: the CLI copies into `.ask/docs/next@16.2.3/` as the old behavior did, AGENTS.md points at `.ask/docs/`.
- [ ] SC-6: Running `ask install` with `{ "inPlace": false }` in `ask.json` matches SC-5 behavior without the CLI flag.
- [ ] SC-7: Running `ask remove npm:next` on an in-place entry removes the resolved-cache entry and the AGENTS.md block without touching `node_modules/next/`.
- [ ] SC-8: Pre-existing `.ask/docs/next@<old-v>/` from an older ASK version is cleaned up on the first in-place install, without orphaning any files.
- [ ] SC-9: All existing tests stay green. New tests cover SC-1 through SC-8.

## Constraints

- **Never modify `node_modules/`** — the in-place path is read-only from ASK's perspective. No nested config writes under `node_modules/<pkg>/`, no edits to package files.
- **Discovery adapter priority unchanged** — `local-ask` > `local-intent` > `local-conventions` > registry fallback. This track only changes what happens AFTER a local adapter wins; the ordering logic is untouched.
- **github/web sources are not affected** — they continue to fetch and materialize through the existing pipeline (or the new store from `global-docs-store-20260410`). This track is strictly about the "local adapter returned a `node_modules/` path" branch.
- **`generateSkill` contract preserved** — the in-place skill generation path already exists at `packages/cli/src/skill.ts:40-43`. This track exercises it; it does not rewrite it.
- **AGENTS.md block wording must differ** — users (and agents) need to tell in-place entries apart from vendored entries because the lifecycle is different. Explicit language required.
- **Opt-out must be frictionless** — `--no-in-place` + `inPlace: false` gives a one-flag/one-field escape for anyone who prefers vendoring.
- **Registry-driven npm entries are out** — if an entry matches the registry and `docsPath` resolves to something that IS present in `node_modules/<pkg>/<docsPath>` AND the version matches, the in-place path applies. Otherwise the current registry-driven fetch path runs.
- **Cleanup of old `.ask/docs/<pkg>@<old>/`** — must happen deterministically on every in-place install so users don't accumulate stale vendored directories.

## Out of Scope

- Adding in-place support for non-npm ecosystems. Only `npm:` discovery adapters can reliably produce a `node_modules/`-anchored path today.
- Changing `saveDocs` for non-in-place entries. Copying remains the default for every non-discovery path.
- `global-docs-store-20260410` — that track handles "ASK needs to materialize somewhere"; this track handles "ASK shouldn't materialize at all".
- `skill-emission-opt-in-20260410` — orthogonal. Whether skills are emitted is decided separately from whether docs are in-place or copied.
- Verifying that `node_modules/<pkg>/<subdir>` actually contains useful Markdown content (not empty dirs, not broken links). The discovery adapter is already responsible for that quality gate.
- Detecting `node_modules` being wiped between `ask install` runs. If the user deletes `node_modules/` and runs an AGENTS.md-consuming agent before re-running `bun install`, the path will 404 — that's a user problem, same as any `node_modules`-dependent workflow.
- Migrating historical `.ask/docs/<pkg>@<old>/` directories into any store. Deletion on next install is sufficient.
- Any change to the opt-in flag's default value. Default stays `true` (in-place when possible).
