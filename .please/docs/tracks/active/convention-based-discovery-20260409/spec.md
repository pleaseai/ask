# Convention-based Docs Discovery

> Track: convention-based-discovery-20260409
> Type: refactor

## Overview

The CLI currently requires every library to be manually curated into the
central registry (`ask-registry.pages.dev`) before `ask docs add` can fetch
its documentation. This is the root cause of the recent production hang
(Nuxt Content + D1 subrequest-limit deadlock) and a hard ceiling on how
fast the project can grow its library coverage.

Most OSS libraries already place their docs under a small set of
conventional paths — `docs/`, `website/docs/`, `apps/docs/`,
`src/content/docs/`, `dist/docs/`, etc. If the CLI scans those paths
first, the vast majority of popular packages resolve automatically with
no registry entry. At the same time, TanStack Intent-compatible packages
(`package.json.keywords` contains `tanstack-intent` + `skills/**/SKILL.md`)
get discovered via `@tanstack/intent`'s programmatic API and wired
through Intent's native installation model, so `ask docs add` and
`bunx @tanstack/intent install` produce identical `AGENTS.md` results
and remain interchangeable.

The central registry is not removed — its role narrows from *"source of
truth for every library"* to *"override layer for libraries with
non-conventional layouts or alias mappings"*. This unblocks growth
without another deploy-time D1 sync.

## Scope

### In scope

**Discovery pipeline** (`packages/cli/src/discovery/`)

New adapter layer. Each adapter is independently testable and can be
swapped without touching the CLI dispatcher.

Adapters (ordered, first non-null wins):

1. **Local ASK self-declare** — reads `package.json.ask.docsPath` from
   the installed package. Lets library authors opt in without a registry
   entry and without following a convention.
2. **Local TanStack Intent** — wraps `@tanstack/intent`'s `scanLibrary`,
   `findSkillFiles`, and `parseFrontmatter` to discover Intent-shaped
   packages. Only read-path APIs are used; no Intent writing APIs.
3. **Local convention scan** — checks `node_modules/<pkg>/` for
   `dist/docs/`, `docs/`, and `README.md` in that order.
4. **Central registry lookup** — the existing `resolveFromRegistry`
   path, now demoted to "fallback when no local signal".
5. **Ecosystem resolver → GitHub repo scan** — after the resolver
   produces a repo + ref, scan the downloaded tree for conventional
   directories: `docs/`, `website/docs/`, `apps/docs/`, `packages/docs/`,
   `src/content/docs/`, `docs/src/content/docs/`.

**Quality scoring** (`discovery/quality.ts`)

- Score each candidate directory by file count × average file size.
- Excludes by default: `CONTRIBUTING.md`, `CHANGELOG.md`,
  `CODE_OF_CONDUCT.md`, `SECURITY.md`, `LICENSE*`.
- Minimum threshold: ≥3 markdown files OR ≥4 KB total content.
- A candidate that fails threshold falls through to the next candidate
  instead of silently selecting "any markdown that exists".
- A README-only fallback emits a warning so the user knows the discovery
  did not find richer docs.

**Installation model (unified: reference-in-place when possible)**

This is the structural shift. Both formats stop making unnecessary
copies of files that already live in `node_modules`.

|                       | ASK format — package installed locally                        | ASK format — tarball download                                   | TanStack Intent format                                                  |
| --------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| File location         | `node_modules/<pkg>/<docsPath>/` **kept in place, not copied** | `.ask/docs/<name>@<ver>/` (existing behavior)                   | `node_modules/<pkg>/skills/` **kept in place**                          |
| Claude Code wiring    | `.claude/skills/<name>-docs/SKILL.md` points at the installPath  | `.claude/skills/<name>-docs/SKILL.md` points at `.ask/docs/...` | `AGENTS.md` `<!-- intent-skills:start --> ... <!-- intent-skills:end -->` block with `load:` reference (identical marker to Intent CLI) |
| AGENTS.md marker      | Existing `# ask:start` / `# ask:end`                           | Existing `# ask:start` / `# ask:end`                             | New `<!-- intent-skills:start -->` / `<!-- intent-skills:end -->`       |
| Lockfile `format`     | `'docs'` (default), `source: 'installPath'`                    | `'docs'`, `source: 'tarball'`                                    | `'intent-skills'`                                                       |
| `ask docs sync`       | Re-read from `installPath` (package may have upgraded)         | Re-download tarball                                              | `checkStaleness` → update marker block if drifted                       |
| `ask docs remove`     | Skill dir + AGENTS.md marker entry                             | docs dir + skill dir + AGENTS.md marker entry                    | Remove only the matching entry from the `intent-skills` marker block    |

The key invariant: `ask docs add npm:<pkg>` against an installed Intent
package must produce exactly the same `intent-skills:start/end` block
that `bunx @tanstack/intent install` would produce. A diff must be
empty. This is validated in SC-2.

**Lockfile schema extension**

`NpmLockEntry` gains an optional `format?: 'docs' | 'intent-skills'`
field. Default `'docs'` so existing lock entries round-trip unchanged.
`installPath` is already accepted by `NpmLockEntry` (from
`npm-tarball-docs-20260408`), so the in-place path does not need a
schema change.

**Idempotency & coexistence**

The two AGENTS.md marker blocks (`# ask:start/end` and
`<!-- intent-skills:start/end -->`) are managed by independent writer
helpers. Neither helper touches the other's region. Running either
`ask docs add` or `bunx @tanstack/intent install` leaves the other
block untouched.

### Out of scope

- Replacing the `apps/registry` stack (Nuxt Content → bundled JSON or
  similar). Tracked separately after this refactor lands.
- Pruning or editing existing registry entries. The registry keeps
  serving whoever still needs it until a follow-up cleanup track.
- Running Intent's `validate`, `stale`, `feedback`, or
  `setup-github-actions` commands — users can invoke Intent CLI
  directly for those.
- Authoring guides for library maintainers on how to publish either an
  `ask.docsPath` manifest or Intent-format skills. Documentation track.
- New Registry API endpoints.

## Success Criteria

- [ ] **SC-1**: At least 80% of the entries currently in
      `apps/registry/content/registry/` resolve to the same docs via
      convention scan alone (no registry call). Validation method:
      scripted audit that fetches each entry twice — once with the
      registry path available, once with it forced off — and diffs the
      resulting file lists.
- [ ] **SC-2**: With a `tanstack-intent` keyword package installed,
      `ask docs add npm:<pkg>` produces an `AGENTS.md` with an
      `intent-skills:start/end` block byte-identical to what
      `bunx @tanstack/intent install` produces for the same package in
      the same workspace.
- [ ] **SC-3**: A repo containing only `CONTRIBUTING.md`/`CHANGELOG.md`
      is not misclassified as "has docs"; the discovery falls through
      to the next candidate or fails cleanly with a warning.
- [ ] **SC-4**: Existing `ask docs add`, `ask docs sync`, and
      `ask docs remove` end-to-end tests pass unchanged.
- [ ] **SC-5**: `packages/cli` builds and lints clean; root `bun run
      build` pipeline is unchanged.

## Constraints

- **Backwards compatibility**: `.ask/config.json` and `.ask/ask.lock`
  schemas may only add fields, never remove or rename. `format` is
  optional with a `'docs'` default so pre-refactor lock entries load
  unchanged.
- **CLI interface unchanged**: `ask docs {add|sync|list|remove}` flags
  and argument names do not change. Only internal dispatch is
  refactored.
- **`apps/registry` untouched** in this track.
- **`@tanstack/intent` pinned exact version** + runtime zod validation
  over its scan results, so an Intent release that changes shape
  surfaces as a clear error instead of a silent misparse.
- **Marker isolation**: ASK and Intent AGENTS.md blocks operate on
  disjoint byte ranges; writers must assert that after their edit the
  other block's content is unchanged.

## Technical Notes

- **New runtime dependency**: `@tanstack/intent` (exact pinned version).
- **New files**:
  - `packages/cli/src/discovery/types.ts` — `DiscoveryResult`
    discriminated union (`kind: 'docs' | 'intent-skills'`), `QualityScore`.
  - `packages/cli/src/discovery/conventions.ts` — convention path
    tables for local tarball and github repo scans.
  - `packages/cli/src/discovery/local-ask.ts` — reads
    `package.json.ask.docsPath`.
  - `packages/cli/src/discovery/local-intent.ts` — wraps
    `@tanstack/intent`'s `scanLibrary` / `findSkillFiles` / `parseFrontmatter`.
  - `packages/cli/src/discovery/local-conventions.ts` — `dist/docs/`,
    `docs/`, `README.md` scan.
  - `packages/cli/src/discovery/repo-conventions.ts` — post-clone
    github tree scan.
  - `packages/cli/src/discovery/quality.ts` — scoring + filter.
  - `packages/cli/src/discovery/index.ts` — `runLocalDiscovery`,
    `runRepoDiscovery` orchestration.
  - `packages/cli/src/agents-intent.ts` — `intent-skills:start/end`
    marker block upsert and entry removal. Mirrors the writer in
    `@tanstack/intent/src/commands/install.ts`.
- **Modifications**:
  - `packages/cli/src/index.ts` — auto-detect branch calls
    `runLocalDiscovery` before `resolveFromRegistry`, dispatches on
    `kind`, and calls `runRepoDiscovery` post-resolver.
  - `packages/schema/src/lock.ts` — add
    `format?: 'docs' | 'intent-skills'` to `NpmLockEntry`.
  - `packages/cli/src/io.ts`, `storage.ts`, `skill.ts` — branch on
    `format: 'intent-skills'` to skip `.ask/docs/` copy and
    `.claude/skills/*/SKILL.md` generation.
- **Test fixtures** (`packages/cli/tests/fixtures/`):
  - `pkg-ask-manifest/` — `package.json.ask.docsPath` package, dist/docs
    populated.
  - `pkg-intent/` — `keywords: ['tanstack-intent']` + `skills/usage/SKILL.md`.
  - `pkg-conventional/` — `dist/docs/*.md` with several files.
  - `pkg-noise/` — `CONTRIBUTING.md`, `CHANGELOG.md` only.
