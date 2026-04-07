# Spec: CLI Identifier Syntax Extension (owner/repo shorthand + @version)

## Background

Today `ask docs add <name>` always goes through an ASK Registry lookup, and any library not registered must be invoked with an explicit `--source` flag. Even when the user knows the GitHub repo URL, they cannot use it directly.

Comparable systems:
- **skills.sh**: `npx skills add vercel-labs/agent-skills` — `owner/repo` is itself the identifier; no separate lookup
- **unpkg**: `unpkg.com/preact@10.5.0/...` — supports semver, dist-tag, and full version
- **cdnjs**: curation-based; downside is slow ingestion of new libraries

## Goals

Make the CLI accept all of the following identifiers:

```bash
ask docs add vercel/next.js                # github fast-path (no registry)
ask docs add vercel/next.js@canary         # tag/branch supported
ask docs add vercel/next.js@v15.0.0        # git tag
ask docs add npm:next                      # ecosystem prefix (existing)
ask docs add npm:next@^15                  # semver range (new)
ask docs add next                          # registry alias lookup (existing)
```

## User Stories

- **US-1**: Libraries not in the registry are usable as long as the user knows `owner/repo`
- **US-2**: Users can pin a specific git tag or branch when downloading docs
- **US-3**: Combining ecosystem prefix with npm dist-tags (`canary`, `next`) and semver ranges works
- **US-4**: Existing bare `name` input continues to work (backward compatible)

## Functional Requirements

- **FR-1**: A `parseDocSpec(input)` function distinguishes the following shapes:
  1. `owner/repo[@ref]` — exactly one slash, no colon → github fast-path
  2. `ecosystem:name[@version]` — colon prefix → registry lookup
  3. `name[@version]` — bare name → registry lookup
- **FR-2**: The github fast-path delegates straight to `getSource('github').fetch({...})`. The registry is never called.
- **FR-3**: `@ref` is treated opaquely as a git ref — tag first, branch as fallback. The github API determines which exists; we do not require the caller to disambiguate.
- **FR-4**: When an ecosystem prefix is present, `@version` is forwarded to that ecosystem's version resolver (FR is out of scope here; handled in the next track).
- **FR-5**: Malformed input (more than one slash, empty owner/repo) produces a clear error message with actionable guidance.

## Non-Functional Requirements

- **NFR-1**: Existing `add next` and `add npm:next` behavior is preserved.
- **NFR-2**: The new parsing logic has 100% branch coverage in unit tests.
- **NFR-3**: The non-registry path performs zero network calls (other than the github API call itself).

## Success Criteria

- **SC-1**: `ask docs add vercel/next.js` runs without any registry fetch log line, and the github source executes immediately
- **SC-2**: `ask docs add vercel/next.js@v15.0.0` downloads the tarball for that tag
- **SC-3**: All 6 existing registry entries (`add next`, `add npm:zod`, etc.) continue to work — no regressions
- **SC-4**: Error messages for malformed input give the user an actionable next step

## Out of Scope

- npm/pypi/pub metadata fallback resolvers (separate track: `ecosystem-resolvers`)
- Registry schema changes (separate track: `registry-meta`)
- A URL-based fast-path for the web source
