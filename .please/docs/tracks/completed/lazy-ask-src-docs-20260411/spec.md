---
product_spec_domain: cli
---

# Lazy `ask src` and `ask docs` Commands

> Track: lazy-ask-src-docs-20260411

## Overview

Add two new top-level CLI commands that give coding agents a zero-friction escape hatch for exploring libraries that aren't declared in `ask.json`. Both commands are lazy (fetch on cache miss), registry-free (no consultation of `apps/registry/`), and reuse the existing global store at `~/.ask/github/checkouts/`.

- `ask src <spec>` — outputs absolute path to the cached full source tree (single line)
- `ask docs <spec>` — outputs all paths in node_modules and the cached source tree whose directory name contains "doc" (case-insensitive), plus root directories (multiple lines)

This is the first registry-free entry point in ASK — a deliberate departure from `ask install`/`ask add`, which still consult the curated ASK Registry. Eager mode trusts curation; lazy mode trusts convention + agent intelligence.

## Requirements

### Functional Requirements

- [ ] **FR-1**: `ask src <spec>` outputs the absolute path to the cached full source tree as a single line on stdout. All progress logs (consola) go to stderr so shell substitution `$(ask src react)` works correctly.
- [ ] **FR-2**: `ask docs <spec>` outputs all paths from two sources, one per line on stdout:
  - From `node_modules/<pkg>/` (only when the spec is npm-ecosystem AND the package exists in node_modules): the package root plus any subdirectory whose name matches `/doc/i`
  - From the cached source tree (`~/.ask/github/checkouts/<o>__<r>/<ref>/`): the checkout root plus any subdirectory whose name matches `/doc/i`
- [ ] **FR-3**: Both commands resolve specs via the existing `parseSpec` (`packages/cli/src/spec.ts`) and `getResolver` (`packages/cli/src/resolvers/index.ts`) pipeline. Supports all 8 ASK ecosystems (npm, pypi, pub, go, crates, hex, nuget, maven) plus direct `github:owner/repo@ref` specs. No new resolver code.
- [ ] **FR-4**: On cache miss, both commands trigger `GithubSource.fetch()` which reuses the bare clone at `~/.ask/github/db/<o>__<r>.git/` and writes the full extracted tree to `~/.ask/github/checkouts/<o>__<r>/<ref>/`. Atomic write and per-entry lock primitives reused as-is.
- [ ] **FR-5**: Cache hit short-circuits — when the checkout dir already exists, no network call is made.
- [ ] **FR-6**: Version resolution priority: (1) explicit `@version` in spec, (2) lockfile reader (`npmEcosystemReader` for npm), (3) upstream registry "latest" tag via the resolver. Only `spec@version` syntax for explicit version override (no `--ref` flag); reuses existing `parseSpec` semantics.
- [ ] **FR-7**: Registry-free — neither command consults `apps/registry/`. Only upstream APIs (npmjs.org, pypi.org, crates.io, etc.) and convention-based discovery.
- [ ] **FR-8**: When walking node_modules and the cached checkout for `ask docs`, the walker:
  - Skips: `node_modules`, `.git`, `.next`, `.nuxt`, `dist`, `build`, `coverage`, all dotdirs
  - Depth-limited to 4 levels
  - Matches directory basename against `/doc/i` (case-insensitive substring match)
  - Always includes the source root as the first output line, even if no `*doc*` subdir is found
- [ ] **FR-9**: Both commands support a `--no-fetch` flag — when set, return cache hit only and exit 1 if cache is empty. Useful for CI guards.
- [ ] **FR-10**: `agents.ts:generateAgentsMd` auto-block (`<!-- BEGIN:ask-docs-auto-generated -->`) gets a new "Searching across cached libraries" subsection at the end of the block, showing substitution patterns:
  ```
  rg "pattern" $(ask src <package>)
  cat $(ask docs <package>)/api.md
  fd "\.md$" $(ask docs <package>)
  ```
  The existing per-library file listing block above is preserved unchanged.

### Non-functional Requirements

- [ ] **NFR-1**: Zero changes to existing files in `packages/cli/src/install.ts`, `packages/cli/src/sources/`, `packages/cli/src/store/`, `packages/cli/src/io.ts`, `packages/cli/src/lockfiles/`. Modifications limited to `packages/cli/src/index.ts` (register new commands) and `packages/cli/src/agents.ts` (extend the auto-block).
- [ ] **NFR-2**: Single-PR sized work: ~150 LOC implementation + ~200 LOC tests. No breaking changes.
- [ ] **NFR-3**: Both commands work fully offline if cache is populated. No silent network calls on cache hit. Network calls only on cache miss.
- [ ] **NFR-4**: ESM-only, follows project conventions: `@pleaseai/eslint-config`, 2-space indent, single quotes, no semicolons, `consola` for output (never raw `console.log`), `.js` import extensions, `import process from 'node:process'`, all RegExp at module scope.
- [ ] **NFR-5**: Commands invocable from any directory inside a bun-workspace project. `projectDir` detected from `process.cwd()`.
- [ ] **NFR-6**: New code lives in `packages/cli/src/commands/` (new directory): `commands/src.ts` + `commands/docs.ts`. Existing flat layout (install.ts at top-level) is left intact.

## User Stories

**US-1** — Ad-hoc transitive dependency exploration:
> As a coding agent, I encounter `@radix-ui/react-primitive` in code I'm modifying but it's not in `ask.json`. I run `ask src @radix-ui/react-primitive` and immediately get an absolute path I can `Read`/`Grep` against — no need to interrupt the user to declare a new entry.

**US-2** — Cross-file source search:
> As a coding agent debugging a Next.js issue, I want to grep across the actual Next.js source for the exact error message in the user's logs. I run `rg "this exact error" $(ask src next)` and `rg` searches the entire Next.js checkout tree.

**US-3** — Multi-path docs discovery for monorepos:
> As a coding agent looking for usage examples of vue's `defineComponent`, I run `rg "defineComponent" $(ask docs vue)`. The multi-path output lets `rg` search across all docs subdirectories of vue's monorepo packages simultaneously.

**US-4** — CI cache warmth check:
> As a CI script, I want to verify the global cache is warm before deploying. I run `ask src react --no-fetch && ask src vue --no-fetch && ...` — non-zero exit on any cache miss.

**US-5** — Cache reuse with eager pipeline:
> As a developer, I have already run `ask install` for some libraries declared in `ask.json`. When I later run `ask src` for one of those libraries, it should hit the same cached checkout (zero duplication) — proving the eager and lazy paths share the same `~/.ask/github/checkouts/` storage.

## Acceptance Criteria

- [ ] **AC-1**: `ask src react` (in a project with no prior cache) fetches `facebook/react` at the locked version, stores at `~/.ask/github/checkouts/facebook__react/<ver>/`, prints the path to stdout, exits 0. Re-running prints the same path without any network call.
- [ ] **AC-2**: `ask docs babel` outputs multiple lines including `~/.ask/github/checkouts/babel__babel/<ver>/` and several `<ver>/packages/<pkg>/docs` entries.
- [ ] **AC-3**: `ask src pypi:requests` works identically to `ask src react` (proves resolver dispatch across ecosystems). Same for `crates:serde`, `pub:flutter_riverpod`, etc.
- [ ] **AC-4**: `ask src nonexistent-package-xyz-12345` exits 1 with a clear stderr message indicating no source repository was found.
- [ ] **AC-5**: `ask src react --no-fetch` exits 1 with stderr "no cached checkout for facebook/react@<ver>" if cache is empty. After a successful `ask src react`, `ask src react --no-fetch` exits 0 and prints the same path.
- [ ] **AC-6**: After running `ask install` for `react`, `ask src react` hits the same `~/.ask/github/checkouts/facebook__react/<ver>/` directory — verified by comparing absolute paths. No duplicate storage.
- [ ] **AC-7**: `bun run --cwd packages/cli lint` passes with zero errors. `bun run test` passes including all new tests.
- [ ] **AC-8**: AGENTS.md generated by `ask install` after this track lands contains the new "Searching across cached libraries" subsection. Existing per-library file listing is unchanged.
- [ ] **AC-9**: `ask docs react` on an npm-ecosystem spec includes `node_modules/react/` (and any `*doc*` subdir there) as the first lines of output, when the package exists in node_modules. For non-npm specs (`github:foo/bar`, `pypi:requests`), node_modules is not scanned.
- [ ] **AC-10**: `ask src react@18.2.0` fetches the explicit version, ignoring lockfile and upstream `latest`. The path output reflects the explicit version.

## Edge Cases

- **EC-1** — **No upstream repository**: When `parseSpec` succeeds but the resolver cannot extract `owner/repo` from upstream metadata, exit 1 with hint: "no source repository declared in npm metadata for <pkg>. Try `ask add` with explicit --source github:owner/repo".
- **EC-2** — **Monorepo packages**: For `@babel/parser`, `ask src @babel/parser` outputs the full `babel/babel` checkout root (not the specific package subdirectory). `ask docs @babel/parser` outputs the babel/babel root plus all `*doc*` subdirectories anywhere in the monorepo. Future enhancement could narrow via npm `repository.directory` field — out of scope.
- **EC-3** — **Multiple specs in one command**: For v1, both commands accept exactly one spec per invocation. Multi-spec support deferred.
- **EC-4** — **Network errors**: If upstream registry is down or git fetch fails, propagate the error from `GithubSource.fetch()` to stderr and exit 1. Don't silently fall back.
- **EC-5** — **Permission errors writing to global store**: Surface as fatal error with the offending path.
- **EC-6** — **Cache hit but corrupted entry**: If `verifyEntry()` detects content hash mismatch, treat as cache miss and re-fetch.
- **EC-7** — **`ask docs` for a package not in node_modules but cached in store**: Skip the node_modules section silently, output only the store paths.
- **EC-8** — **`ask docs` for a non-npm spec (e.g., `pypi:requests`)**: node_modules walk is skipped entirely (npm-only optimization). Only the store paths are output.

## Out of Scope

The following are explicitly excluded from this track and tracked separately:

- **Track B**: `~/.ask/index.json` metadata cross-reference index (opensrc-style `sources.json`) — orphans GC and provenance tracking
- **Track C**: GitLab/Bitbucket source adapters — multi-host support
- **Track D**: `ask add --no-registry` flag — registry-free eager add
- **Track E**: Migrate `ask install` default to registry-free convention discovery — deprecate `apps/registry/` as runtime dependency
- **Track F**: `ask gc` command for orphan cache cleanup
- **Track G**: XDG Base Directory compliance for `ASK_HOME`
- **Track H**: Multiple specs per command invocation (`ask src react vue zod`)
- **Track I**: Interactive `ask` shell / TUI mode
- **`--ref` / `--branch` flags**: Only `spec@version` syntax for explicit version override
- **Filtering by file glob in `ask docs`**: No `--glob *.md` option in v1

## Assumptions

- **A-1**: The existing `GithubSource.fetch()` correctly populates `~/.ask/github/checkouts/<o>__<r>/<ref>/` with the full tree on cache miss. This is verified by reading `packages/cli/src/sources/github.ts:60-149` (bare clone preferred, tar.gz fallback, full tree write via `cpDirAtomic`).
- **A-2**: The existing `parseSpec` discriminated union covers all 8 ecosystems via the kind/ecosystem fields. Confirmed by `packages/cli/src/spec.ts` and the existing usage in `install.ts`.
- **A-3**: The existing resolvers (`packages/cli/src/resolvers/`) all hand off to GitHub source after extracting `owner/repo`. New ecosystems would need new resolvers, but this is out of scope — we use whatever is currently registered.
- **A-4**: Coding agents have access to a `Bash` tool that supports shell substitution `$(...)`. Verified by Claude Code, Cursor, Aider, and similar agent runtimes. Without this, the lazy command UX has no consumer.
- **A-5**: The convention `<dir name contains 'doc'>` is sufficient signal for an LLM consumer to identify docs directories. False positives (e.g., `docs-internal`, `node_modules/foo/_docs`) are tolerated because the agent can read contents and judge.
- **A-6**: `~/.ask/` global store layout is stable for this track. No layout migration is performed.
- **A-7**: Project root detection (`projectDir`) follows the same convention as existing commands (current `process.cwd()` walked up to find `package.json`/`ask.json`). If existing commands use a helper, reuse it.
- **A-8**: The `commands/` subdirectory for new command files does not conflict with any existing path in `packages/cli/src/`. Verified at draft time; the track will assert no collision before adding files.

## References

- `.please/docs/references/opensrc.md` — full opensrc analysis (commit `6383018`)
- https://opensrc.sh/how-it-works — opensrc UX reference
- https://opensrc.sh/registries — opensrc registry coverage
- `vendor/opensrc/` — vendored upstream source (git submodule)
- `packages/cli/src/store/index.ts` — global store primitives (already implemented)
- `packages/cli/src/store/github-bare.ts` — bare clone reuse (already implemented)
- `packages/cli/src/sources/github.ts` — GitHub source adapter (already implemented)
- `packages/cli/src/resolvers/index.ts` — ecosystem resolver registry (already implemented)
- `packages/cli/src/spec.ts` — spec parsing (already implemented)
- `packages/cli/src/agents.ts` — AGENTS.md generation (will be modified)
- `packages/cli/src/index.ts` — CLI command registration (will be modified)
