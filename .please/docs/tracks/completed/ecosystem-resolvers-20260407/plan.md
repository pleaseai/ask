# Plan: Ecosystem Resolvers

## Architecture

Resolvers are a new layer orthogonal to sources. Call flow:

```
ask docs add npm:lodash
  └→ parseDocSpec → { kind: 'ecosystem', ecosystem: 'npm', name: 'lodash', version: 'latest' }
       └→ registry lookup (use if hit)
       └→ otherwise: getResolver('npm').resolve('lodash', 'latest')
            └→ fetch https://registry.npmjs.org/lodash
            └→ extract repository.url → 'lodash/lodash'
            └→ resolve version → '4.17.21' → tag 'v4.17.21' or '4.17.21'
       └→ getSource('github').fetch({ source: 'github', repo: 'lodash/lodash', tag: '4.17.21', name: 'lodash', version: '4.17.21' })
```

## Files

| Change | File | Notes |
|---|---|---|
| Add | `packages/cli/src/resolvers/index.ts` | `EcosystemResolver` interface, `getResolver` factory |
| Add | `packages/cli/src/resolvers/npm.ts` | npm registry API resolver |
| Add | `packages/cli/src/resolvers/pypi.ts` | PyPI JSON API resolver |
| Add | `packages/cli/src/resolvers/pub.ts` | pub.dev API resolver |
| Add | `packages/cli/src/resolvers/utils.ts` | `parseRepoUrl(url)` — `git+https://github.com/foo/bar.git` → `foo/bar` |
| Modify | `packages/cli/src/index.ts` | In the `add` command, fall back to a resolver when ecosystem prefix is present and the registry misses |
| Add | `packages/cli/test/resolvers/npm.test.ts` | Unit tests with mocked fetch |
| Add | `packages/cli/test/resolvers/pypi.test.ts` | Same |
| Add | `packages/cli/test/resolvers/pub.test.ts` | Same |
| Modify | `packages/cli/README.md` | Document the supported ecosystems |

## Tasks

- [x] **T-1** [impl] `EcosystemResolver` interface, `parseRepoUrl` utility, and unit tests
- [x] **T-2** [impl] npm resolver — registry API + dist-tags + semver resolution
- [x] **T-3** [impl] pypi resolver — extract `project_urls`, PEP 440 handling
- [x] **T-4** [impl] pub resolver — extract `pubspec.repository`
- [x] **T-5** [test] Unit tests for each resolver (mocked fetch)
- [x] **T-6** [impl] Wire resolvers into the `add` command — registry-miss fallback
- [x] **T-7** [test] End-to-end smoke — `ask docs add npm:lodash`, `pub:riverpod`
- [x] **T-8** [docs] Update README
- [x] **T-9** [chore] Regression — confirm registry-hit `npm:next` still works

## Risks

- A package's `repository` field may be missing or wrong → emit a clear error and tell the user to fall back to `owner/repo` directly
- Git tag conventions differ (`v1.0.0` vs `1.0.0`) → try both, fall back on github 404
- Semver range parsing pulls in a new dependency — consider adding `semver`

## Outcomes & Retrospective

### What Was Shipped
- EcosystemResolver interface + factory (`getResolver`) for npm, pypi, pub
- `parseRepoUrl` utility for normalizing GitHub URLs from varied formats
- Semver range resolution for npm (`^15` → latest 15.x.x) via `semver` package
- Git ref fallback (`v{version}` → `{version}` or vice versa)
- Resolver fallback wired into `add` command on registry miss
- 146 tests passing, lint + tsc clean

### What Went Well
- Clean TDD cycle — tests defined expected behavior, implementation followed
- Spec compliance check caught semver range gap early before merge
- Resolvers are fully decoupled from sources, testable with mock fetch

### What Could Improve
- FR-5 fallback refs are declared but not yet exercised at download time (github source would need retry logic)
- Could add integration tests against real APIs (currently all mocked)

### Tech Debt Created
- `sources/npm.ts` marked deprecated but not removed — needs cleanup in a follow-up release
- FR-5 fallback ref retry logic not wired into github source fetch path

## Dependencies

- **Soft dependency** on `cli-shorthand-20260407`: once the github fast-path lands, the resolver can reuse the same code path. Parallel work is fine, but landing `cli-shorthand` first is preferable.
- **Soft dependency** on `registry-meta-20260407`: the new top-level `repo` field makes it trivial to upstream resolver results into the registry later (a follow-up).
