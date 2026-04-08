# Plan: Maven Ecosystem Resolver

> Track: maven-resolver-20260408
> Spec: [spec.md](./spec.md)

## Overview
- **Source**: /please:plan
- **Track**: maven-resolver-20260408
- **Created**: 2026-04-08
- **Approach**: Follow existing resolver pattern (NpmResolver/PypiResolver/PubResolver)

## Purpose

Add Maven Central support to the CLI resolver system, enabling `maven:groupId:artifactId` package resolution. This completes the Maven ecosystem support that currently only has registry aliases and auto-detection but no resolver.

## Context

The ASK CLI has three ecosystem resolvers (npm, pypi, pub) that map package identifiers to GitHub repositories. Maven auto-detection (`pom.xml` → `'maven'`) and registry aliases (`maven:group:artifact`) already exist, but `getResolver('maven')` returns `null`. Users with Maven projects get a "no resolver for 'maven'" error when the registry misses.

## Architecture Decision

**Approach**: Direct pattern replication with dual-source fallback.

- Follow the established `EcosystemResolver` interface exactly as npm/pypi/pub do
- Primary source: Maven Central Search API (JSON, fast, includes `scmUrl`)
- Fallback source: Direct POM XML download from Maven Central Repository (regex extraction of `<scm><url>` and `<url>` tags — no external XML parser needed)
- `name` parameter arrives as `groupId:artifactId` (split at last colon)
- POM path construction: `groupId.replace(/\./g, '/')` → `com/google/guava/guava/{version}/guava-{version}.pom`

**Why no XML parser**: POM files have predictable structure; regex extraction of 2 tags is simpler and avoids adding a dependency. The `parseRepoUrl()` utility handles URL normalization.

## Tasks

### T-1: Create MavenResolver class with Search API lookup
- **File**: `packages/cli/src/resolvers/maven.ts` (new)
- **Test**: `packages/cli/test/resolvers/maven.test.ts` (new)
- **FR**: FR-1, FR-2, FR-3, FR-5 (Search API scmUrl), FR-6, FR-7
- **Details**:
  - Implement `MavenResolver` class with `resolve(name, version)` method
  - Parse `name` as `groupId:artifactId` (split at last colon)
  - Fetch `https://search.maven.org/solrsearch/select?q=g:{groupId}+AND+a:{artifactId}&rows=1&wt=json&core=gav` for latest
  - For explicit version: add `&v={version}` filter
  - Extract `response.docs[0].g`, `.a`, `.v`, `.repositoryUrl` or fall back to `scmUrl` from extended search
  - Return `ResolveResult` with `v{version}` ref and `{version}` fallback
- **TDD**: RED → test mock Search API JSON → GREEN → implement resolver → REFACTOR

### T-2: Add POM XML fallback for GitHub URL extraction
- **File**: `packages/cli/src/resolvers/maven.ts`
- **Test**: `packages/cli/test/resolvers/maven.test.ts`
- **FR**: FR-4, FR-5 (POM scm.url, POM url)
- **Details**:
  - When Search API fails (non-200 or no scmUrl), download POM XML from `https://repo1.maven.org/maven2/{groupPath}/{artifactId}/{version}/{artifactId}-{version}.pom`
  - Regex extract `<scm>` → `<url>` value, fallback to top-level `<url>` value
  - Use `parseRepoUrl()` for normalization
  - Requires resolved version — if version is `latest`, fetch latest version from Search API first, then use POM as fallback for repo URL only
- **TDD**: RED → test mock POM XML response → GREEN → implement fallback → REFACTOR
- **Depends on**: T-1

### T-3: Register MavenResolver in resolver index
- **File**: `packages/cli/src/resolvers/index.ts`
- **Test**: `packages/cli/test/resolvers/index.test.ts`
- **FR**: FR-8
- **Details**:
  - Add `'maven'` to `SupportedEcosystem` union type
  - Add `maven: new MavenResolver()` to `resolvers` record
  - Add test: `getResolver('maven')` returns defined resolver with `.resolve` function
- **TDD**: RED → add test for `getResolver('maven')` → GREEN → register → REFACTOR
- **Depends on**: T-1

### T-4: Integration verification and edge cases
- **File**: `packages/cli/test/resolvers/maven.test.ts`
- **FR**: FR-9, AC-1 through AC-6
- **Details**:
  - Test `maven:com.google.guava:guava` resolves correctly (AC-1)
  - Test explicit version `@33.4.0-jre` (AC-2)
  - Test Search API failure triggers POM fallback (AC-3)
  - Test error when neither source has GitHub URL
  - Test invalid `name` format (missing colon) throws clear error
  - Verify all existing resolver tests still pass (AC-5)
  - Ensure >80% coverage (AC-6)
- **Depends on**: T-1, T-2, T-3

## Dependencies

```
T-1 → T-2
T-1 → T-3
T-2 + T-3 → T-4
```

## Key Files

| File | Role |
|---|---|
| `packages/cli/src/resolvers/maven.ts` | New MavenResolver class |
| `packages/cli/src/resolvers/index.ts` | Register maven in SupportedEcosystem |
| `packages/cli/src/resolvers/utils.ts` | Shared `parseRepoUrl()` utility |
| `packages/cli/src/registry.ts` | `parseDocSpec()` + `detectEcosystem()` (no changes needed) |
| `packages/cli/test/resolvers/maven.test.ts` | New test file |
| `packages/cli/test/resolvers/index.test.ts` | Add maven registration test |

## Verification

```bash
bun test packages/cli/test/resolvers/maven.test.ts
bun test packages/cli/test/resolvers/index.test.ts
bun test packages/cli/test/resolvers/  # all resolver tests
bun run --cwd packages/cli lint
```

## Progress

- [ ] T-1: MavenResolver + Search API
- [ ] T-2: POM XML fallback
- [ ] T-3: Register in index
- [ ] T-4: Integration tests + edge cases

## Decision Log

| Decision | Rationale |
|---|---|
| Regex over XML parser for POM | Only need 2 tags; avoids new dependency |
| Last-colon split for groupId:artifactId | groupId contains dots, artifactId never contains colons |
| Search API `core=gav` parameter | Returns version-specific results for explicit version lookup |

## Surprises & Discoveries

- `parseDocSpec` uses first colon as ecosystem separator, so `maven:com.google.guava:guava` correctly splits into `ecosystem=maven`, `name=com.google.guava:guava`
- Maven auto-detection already maps `pom.xml`/`build.gradle`/`build.gradle.kts` to `'maven'` ecosystem
- No changes needed to `registry.ts` or `index.ts` — the resolver system is fully pluggable
