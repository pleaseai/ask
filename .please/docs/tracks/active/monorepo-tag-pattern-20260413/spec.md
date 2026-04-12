---
product_spec_domain: cli/resolver
---

# Monorepo Tag Pattern Support

> Track: monorepo-tag-pattern-20260413

## Overview

Changesets-based monorepos (vercel/ai, tanstack, trpc, effect, etc.) use `<pkg>@<version>` tag patterns instead of the conventional `v<version>`. The npm resolver currently only generates `v{version}` refs, causing git clone and tar.gz download failures for these repositories.

This feature adds monorepo-aware tag discovery using a cascade strategy: first infer the tag pattern from npm registry metadata (`repository.directory` field indicates monorepo), then fall back to `git ls-remote` probing when metadata is insufficient.

## Requirements

### Functional Requirements

- [ ] FR-1: npm resolver detects monorepo packages via `repository.directory` field in npm registry metadata and generates `<pkgName>@<version>` as an additional ref candidate
- [ ] FR-2: `refCandidates()` in `github.ts` accepts optional extra candidates (e.g. `ai@6.0.158`) and prepends them to the fallback chain
- [ ] FR-3: `ensure-checkout.ts` passes `fallbackRefs` from the resolver result through to `GithubSource.fetch()` via the source options
- [ ] FR-4: `GithubSource.fetch()` accepts optional `fallbackRefs` in `GithubSourceOptions` and merges them into the candidate chain
- [ ] FR-5: When all static ref candidates fail, `cloneAtTag()` falls back to `git ls-remote --tags <repo> '*<version>*'` to discover matching tags before giving up
- [ ] FR-6: `ask install` (runInstall) github source path also benefits from the expanded ref candidates via the shared `GithubSource`
- [ ] FR-7: tar.gz fallback path in `fetchFromTarGz` also tries the expanded ref candidates (not just the original ref)

### Non-functional Requirements

- [ ] NFR-1: `git ls-remote` probing adds at most one extra network call, only on static candidate failure
- [ ] NFR-2: No breaking changes to existing `GithubSourceOptions` — `fallbackRefs` is optional
- [ ] NFR-3: Maintain >80% code coverage for modified files

## Acceptance Criteria

- [ ] AC-1: `ask src npm:ai` resolves `vercel/ai` at tag `ai@6.0.158` (or current version) without error
- [ ] AC-2: `ask src npm:react` continues to work with `v{version}` tags (no regression)
- [ ] AC-3: `ask src github:vercel/ai@ai@6.0.158` works with explicit monorepo tag ref
- [ ] AC-4: Packages without `repository.directory` (single-repo packages) are unaffected
- [ ] AC-5: When git is unavailable, tar.gz fallback also tries monorepo tag patterns
- [ ] AC-6: `git ls-remote` fallback discovers the correct tag when npm metadata is insufficient

## Out of Scope

- Registry entry modifications for vercel/ai or other monorepos
- Support for non-GitHub monorepo hosts (GitLab, Bitbucket)
- Automatic detection of tag patterns beyond `<pkg>@<version>` (e.g. `@scope/pkg@version`)
- Changes to the `ask install` registry-based path (only resolver/github-source paths)

## Assumptions

- npm registry `repository.directory` field reliably indicates monorepo packages
- Monorepo tag patterns follow the changesets convention: `<unscoped-pkg-name>@<version>`
- `git ls-remote` is available when `git` is available (same `hasGit()` check)
