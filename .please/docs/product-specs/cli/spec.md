---
id: SPEC-003
level: V_M
domain: cli
feature: spec
depends: []
conflicts: []
traces: []
created_at: 2026-04-11T12:20:47.485Z
updated_at: 2026-04-11T12:20:47.485Z
source_tracks: [lazy-ask-src-docs-20260411]
---

# Lazy `ask src` and `ask docs` Commands Specification

## Purpose

Lazy `ask src` and `ask docs` Commands 관련 요구사항.

## Requirements

### Requirement: **FR-1**: `ask src <spec>` outputs the absolute path to the cached full source tree as a single line on stdout. All progress logs (consola) go to stderr so shell substitution `$(ask src react)` works correctly.

The system MUST **FR-1**: `ask src <spec>` outputs the absolute path to the cached full source tree as a single line on stdout. All progress logs (consola) go to stderr so shell substitution `$(ask src react)` works correctly.

#### Scenario: **FR-1**: `ask src <spec>` outputs the absolute path to the cached full source tree as a single line on stdout. All progress logs (consola) go to stderr so shell substitution `$(ask src react)` works correctly

- GIVEN 시스템이 정상 동작 중일 때
- WHEN **FR-1**: `ask src <spec>` outputs the absolute path to the cached full source tree as a single line on stdout. All progress logs (consola) go to stderr so shell substitution `$(ask src react)` works correctly
- THEN 해당 기능이 정상적으로 수행된다

### Requirement: **FR-2**: `ask docs <spec>` outputs all paths from two sources, one per line on stdout:

The system MUST **FR-2**: `ask docs <spec>` outputs all paths from two sources, one per line on stdout:.

#### Scenario: **FR-2**: `ask docs <spec>` outputs all paths from two sources, one per line on stdout:

- GIVEN 시스템이 정상 동작 중일 때
- WHEN **FR-2**: `ask docs <spec>` outputs all paths from two sources, one per line on stdout:
- THEN 해당 기능이 정상적으로 수행된다

### Requirement: **FR-3**: Both commands resolve specs via the existing `parseSpec` (`packages/cli/src/spec.ts`) and `getResolver` (`packages/cli/src/resolvers/index.ts`) pipeline. Supports all 8 ASK ecosystems (npm, pypi, pub, go, crates, hex, nuget, maven) plus direct `github:owner/repo@ref` specs. No new resolver code.

The system MUST **FR-3**: Both commands resolve specs via the existing `parseSpec` (`packages/cli/src/spec.ts`) and `getResolver` (`packages/cli/src/resolvers/index.ts`) pipeline. Supports all 8 ASK ecosystems (npm, pypi, pub, go, crates, hex, nuget, maven) plus direct `github:owner/repo@ref` specs. No new resolver code.

#### Scenario: **FR-3**: Both commands resolve specs via the existing `parseSpec` (`packages/cli/src/spec.ts`) and `getResolver` (`packages/cli/src/resolvers/index.ts`) pipeline. Supports all 8 ASK ecosystems (npm, pypi, pub, go, crates, hex, nuget, maven) plus direct `github:owner/repo@ref` specs. No new resolver code

- GIVEN 시스템이 정상 동작 중일 때
- WHEN **FR-3**: Both commands resolve specs via the existing `parseSpec` (`packages/cli/src/spec.ts`) and `getResolver` (`packages/cli/src/resolvers/index.ts`) pipeline. Supports all 8 ASK ecosystems (npm, pypi, pub, go, crates, hex, nuget, maven) plus direct `github:owner/repo@ref` specs. No new resolver code
- THEN 해당 기능이 정상적으로 수행된다

### Requirement: **FR-4**: On cache miss, both commands trigger `GithubSource.fetch()` which reuses the bare clone at `~/.ask/github/db/<o>__<r>.git/` and writes the full extracted tree to `~/.ask/github/checkouts/<o>__<r>/<ref>/`. Atomic write and per-entry lock primitives reused as-is.

The system MUST **FR-4**: On cache miss, both commands trigger `GithubSource.fetch()` which reuses the bare clone at `~/.ask/github/db/<o>__<r>.git/` and writes the full extracted tree to `~/.ask/github/checkouts/<o>__<r>/<ref>/`. Atomic write and per-entry lock primitives reused as-is.

#### Scenario: **FR-4**: On cache miss, both commands trigger `GithubSource.fetch()` which reuses the bare clone at `~/.ask/github/db/<o>__<r>.git/` and writes the full extracted tree to `~/.ask/github/checkouts/<o>__<r>/<ref>/`. Atomic write and per-entry lock primitives reused as-is

- GIVEN 시스템이 정상 동작 중일 때
- WHEN **FR-4**: On cache miss, both commands trigger `GithubSource.fetch()` which reuses the bare clone at `~/.ask/github/db/<o>__<r>.git/` and writes the full extracted tree to `~/.ask/github/checkouts/<o>__<r>/<ref>/`. Atomic write and per-entry lock primitives reused as-is
- THEN 해당 기능이 정상적으로 수행된다

### Requirement: **FR-5**: Cache hit short-circuits — when the checkout dir already exists, no network call is made.

The system MUST **FR-5**: Cache hit short-circuits — when the checkout dir already exists, no network call is made.

#### Scenario: **FR-5**: Cache hit short-circuits — when the checkout dir already exists, no network call is made

- GIVEN 시스템이 정상 동작 중일 때
- WHEN **FR-5**: Cache hit short-circuits — when the checkout dir already exists, no network call is made
- THEN 해당 기능이 정상적으로 수행된다

### Requirement: **FR-6**: Version resolution priority: (1) explicit `@version` in spec, (2) lockfile reader (`npmEcosystemReader` for npm), (3) upstream registry "latest" tag via the resolver. Only `spec@version` syntax for explicit version override (no `--ref` flag); reuses existing `parseSpec` semantics.

The system MUST **FR-6**: Version resolution priority: (1) explicit `@version` in spec, (2) lockfile reader (`npmEcosystemReader` for npm), (3) upstream registry "latest" tag via the resolver. Only `spec@version` syntax for explicit version override (no `--ref` flag); reuses existing `parseSpec` semantics.

#### Scenario: **FR-6**: Version resolution priority: (1) explicit `@version` in spec, (2) lockfile reader (`npmEcosystemReader` for npm), (3) upstream registry "latest" tag via the resolver. Only `spec@version` syntax for explicit version override (no `--ref` flag); reuses existing `parseSpec` semantics

- GIVEN 시스템이 정상 동작 중일 때
- WHEN **FR-6**: Version resolution priority: (1) explicit `@version` in spec, (2) lockfile reader (`npmEcosystemReader` for npm), (3) upstream registry "latest" tag via the resolver. Only `spec@version` syntax for explicit version override (no `--ref` flag); reuses existing `parseSpec` semantics
- THEN 해당 기능이 정상적으로 수행된다

### Requirement: **FR-7**: Registry-free — neither command consults `apps/registry/`. Only upstream APIs (npmjs.org, pypi.org, crates.io, etc.) and convention-based discovery.

The system MUST **FR-7**: Registry-free — neither command consults `apps/registry/`. Only upstream APIs (npmjs.org, pypi.org, crates.io, etc.) and convention-based discovery.

#### Scenario: **FR-7**: Registry-free — neither command consults `apps/registry/`. Only upstream APIs (npmjs.org, pypi.org, crates.io, etc.) and convention-based discovery

- GIVEN 시스템이 정상 동작 중일 때
- WHEN **FR-7**: Registry-free — neither command consults `apps/registry/`. Only upstream APIs (npmjs.org, pypi.org, crates.io, etc.) and convention-based discovery
- THEN 해당 기능이 정상적으로 수행된다

### Requirement: **FR-8**: When walking node_modules and the cached checkout for `ask docs`, the walker:

The system MUST **FR-8**: When walking node_modules and the cached checkout for `ask docs`, the walker:.

#### Scenario: **FR-8**: When walking node_modules and the cached checkout for `ask docs`, the walker:

- GIVEN 시스템이 정상 동작 중일 때
- WHEN **FR-8**: When walking node_modules and the cached checkout for `ask docs`, the walker:
- THEN 해당 기능이 정상적으로 수행된다

### Requirement: **FR-9**: Both commands support a `--no-fetch` flag — when set, return cache hit only and exit 1 if cache is empty. Useful for CI guards.

The system MUST **FR-9**: Both commands support a `--no-fetch` flag — when set, return cache hit only and exit 1 if cache is empty. Useful for CI guards.

#### Scenario: **FR-9**: Both commands support a `--no-fetch` flag — when set, return cache hit only and exit 1 if cache is empty. Useful for CI guards

- GIVEN 시스템이 정상 동작 중일 때
- WHEN **FR-9**: Both commands support a `--no-fetch` flag — when set, return cache hit only and exit 1 if cache is empty. Useful for CI guards
- THEN 해당 기능이 정상적으로 수행된다

### Requirement: **FR-10**: `agents.ts:generateAgentsMd` auto-block (`<!-- BEGIN:ask-docs-auto-generated -->`) gets a new "Searching across cached libraries" subsection at the end of the block, showing substitution patterns:

The system MUST **FR-10**: `agents.ts:generateAgentsMd` auto-block (`<!-- BEGIN:ask-docs-auto-generated -->`) gets a new "Searching across cached libraries" subsection at the end of the block, showing substitution patterns:.

#### Scenario: **FR-10**: `agents.ts:generateAgentsMd` auto-block (`<!-- BEGIN:ask-docs-auto-generated -->`) gets a new "Searching across cached libraries" subsection at the end of the block, showing substitution patterns:

- GIVEN 시스템이 정상 동작 중일 때
- WHEN **FR-10**: `agents.ts:generateAgentsMd` auto-block (`<!-- BEGIN:ask-docs-auto-generated -->`) gets a new "Searching across cached libraries" subsection at the end of the block, showing substitution patterns:
- THEN 해당 기능이 정상적으로 수행된다

## Non-functional Requirements

### Requirement: **NFR-1**: Zero changes to existing files in `packages/cli/src/install.ts`, `packages/cli/src/sources/`, `packages/cli/src/store/`, `packages/cli/src/io.ts`, `packages/cli/src/lockfiles/`. Modifications limited to `packages/cli/src/index.ts` (register new commands) and `packages/cli/src/agents.ts` (extend the auto-block).

The system SHOULD **NFR-1**: Zero changes to existing files in `packages/cli/src/install.ts`, `packages/cli/src/sources/`, `packages/cli/src/store/`, `packages/cli/src/io.ts`, `packages/cli/src/lockfiles/`. Modifications limited to `packages/cli/src/index.ts` (register new commands) and `packages/cli/src/agents.ts` (extend the auto-block).

### Requirement: **NFR-2**: Single-PR sized work: ~150 LOC implementation + ~200 LOC tests. No breaking changes.

The system SHOULD **NFR-2**: Single-PR sized work: ~150 LOC implementation + ~200 LOC tests. No breaking changes.

### Requirement: **NFR-3**: Both commands work fully offline if cache is populated. No silent network calls on cache hit. Network calls only on cache miss.

The system SHOULD **NFR-3**: Both commands work fully offline if cache is populated. No silent network calls on cache hit. Network calls only on cache miss.

### Requirement: **NFR-4**: ESM-only, follows project conventions: `@pleaseai/eslint-config`, 2-space indent, single quotes, no semicolons, `consola` for output (never raw `console.log`), `.js` import extensions, `import process from 'node:process'`, all RegExp at module scope.

The system SHOULD **NFR-4**: ESM-only, follows project conventions: `@pleaseai/eslint-config`, 2-space indent, single quotes, no semicolons, `consola` for output (never raw `console.log`), `.js` import extensions, `import process from 'node:process'`, all RegExp at module scope.

### Requirement: **NFR-5**: Commands invocable from any directory inside a bun-workspace project. `projectDir` detected from `process.cwd()`.

The system SHOULD **NFR-5**: Commands invocable from any directory inside a bun-workspace project. `projectDir` detected from `process.cwd()`.

### Requirement: **NFR-6**: New code lives in `packages/cli/src/commands/` (new directory): `commands/src.ts` + `commands/docs.ts`. Existing flat layout (install.ts at top-level) is left intact.

The system SHOULD **NFR-6**: New code lives in `packages/cli/src/commands/` (new directory): `commands/src.ts` + `commands/docs.ts`. Existing flat layout (install.ts at top-level) is left intact.
