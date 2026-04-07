# Spec: Ecosystem Resolvers (pub/npm/pypi → delegate to github)

## Background

Today `packages/cli/src/sources/` contains three sources (`npm`, `github`, `web`), each owning its own download logic. Adding a new ecosystem (dart pub, cargo, go, ...) means writing yet another download path. Worse, npm/pub packages that aren't in the registry have no way to retrieve docs at all.

Key insight: nearly every ecosystem exposes a `repository` URL in its package metadata. So **metadata → extract github repo → delegate to the github source** is a resolver pattern that lets us reuse one downloader.

## Goals

Redefine ecosystem adapters as **resolvers** rather than downloaders:

```ts
interface EcosystemResolver {
  resolve(name: string, version: string): Promise<{
    repo: string         // owner/repo
    ref: string          // git tag or branch
    resolvedVersion: string
  }>
}
```

Initial ecosystems:
- `npm` — `https://registry.npmjs.org/<name>` → `repository.url`
- `pypi` — `https://pypi.org/pypi/<name>/json` → `info.project_urls.Source`
- `pub` — `https://pub.dev/api/packages/<name>` → `latest.pubspec.repository`

Resolver output is always handed off to the github source for download.

## User Stories

- **US-1**: An npm package that isn't in the registry (`ask docs add npm:lodash`) still works automatically — the resolver finds the github repo
- **US-2**: A dart project (`pub:riverpod`) works the same way
- **US-3**: Version semantics follow ecosystem rules (`npm:react@^18` → latest 18.x.x → corresponding git tag)

## Functional Requirements

- **FR-1**: Create `packages/cli/src/resolvers/`; one resolver per ecosystem
- **FR-2**: Provide a `getResolver(ecosystem)` factory
- **FR-3**: Each resolver pulls the `repository` URL from the ecosystem's metadata API and normalizes it to `owner/repo`
- **FR-4**: Version resolution respects ecosystem rules — npm dist-tags + semver, PyPI PEP 440, pub caret syntax
- **FR-5**: The git ref selection follows this order:
  1. If the ecosystem metadata pins an explicit git tag, use it
  2. Otherwise try `v{version}` and `{version}` tags
  3. If both fail, fall back to the default branch
- **FR-6**: The `add` command tries the registry first (existing behavior); if there's no hit, it falls back to the resolver. Registry remains the highest-priority lookup.

## Non-Functional Requirements

- **NFR-1**: Resolution should require a single fetch where possible
- **NFR-2**: Resolvers are decoupled from sources and can be unit-tested with a mock fetch
- **NFR-3**: The existing `sources/npm.ts` is marked deprecated, but kept working for one release with no regressions

## Success Criteria

- **SC-1**: `ask docs add npm:lodash` (not in registry) downloads docs from `lodash/lodash`
- **SC-2**: `ask docs add pub:riverpod` downloads docs from the riverpod repo
- **SC-3**: `ask docs add npm:next@^15` downloads the tarball for the latest 15.x.x git tag
- **SC-4**: No regressions in the existing direct-`npm`-source path

## Out of Scope

- cargo / go / hex / nuget resolvers (interface only; concrete implementations land later)
- Auto-registration — pushing resolver results back into the registry
- A web-crawl resolver
