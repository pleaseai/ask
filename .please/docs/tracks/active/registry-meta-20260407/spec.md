# Spec: Registry Schema Metadata Enrichment

## Background

The current `apps/registry/content.config.ts` schema is centered on a `strategies` array, and even simple cases (a github repo with one docs path) have to spell out a full `strategies` entry. The schema also lacks the kinds of metadata that curated registries like cdnjs provide (homepage, license, repository, autoupdate hints), which limits future search and browsing UX.

## Goals

Add new fields to (a) make trivial entries trivial to write and (b) enrich the metadata available for search and curation.

```yaml
---
name: next
ecosystem: npm
repo: vercel/next.js          # new — default for the github strategy
homepage: https://nextjs.org  # new (optional)
license: MIT                  # new (optional)
docsPath: docs                # new — default path when strategies omitted
description: ...
strategies: []                # may be empty — auto-generated from repo + docsPath
tags: [react, ssr]
---
```

## User Stories

- **US-1**: Simple github-only libraries can be registered with just `repo` + `docsPath` — no `strategies` array
- **US-2**: The registry browser (`apps/registry`) can show homepage and license badges on entry cards
- **US-3**: Existing `strategies`-based entries continue to work (backward compatible)

## Functional Requirements

- **FR-1**: Add optional `repo`, `homepage`, `license`, and `docsPath` fields to the registry schema in `content.config.ts`
- **FR-2**: When `strategies` is empty or missing, auto-generate a default github strategy from `repo` via a helper named `expandStrategies`. The schema's `strategies` field must be changed to `z.array(strategySchema).optional().default([])` for this to work.
- **FR-3**: `expandStrategies` is shared between the CLI (`packages/cli/src/registry.ts`) and the registry API (`apps/registry/server/api/...`)
- **FR-4**: Migrate the 6 existing entries — simplify whichever ones can drop their `strategies` in favor of `repo`

## Non-Functional Requirements

- **NFR-1**: Schema enforces "either `strategies` or `repo` is required" via a zod refinement
- **NFR-2**: Registry build (Nuxt Content) still passes after migration
- **NFR-3**: Registry API response shape stays compatible — `strategies` is always populated server-side so existing CLI clients keep working

## Success Criteria

- **SC-1**: An entry with only `repo: vercel/next.js` (no `strategies`) passes `bun run --cwd apps/registry build`
- **SC-2**: API responses include the auto-expanded `strategies`
- **SC-3**: An older CLI version (without these changes) still works against the new registry response
- **SC-4**: All 6 entries migrated; the registry dev server renders them correctly

## Out of Scope

- An `aliases` field (separate work)
- Automated `autoupdate` sync logic — the metadata field may be added but the actual sync automation is separate
- CLI identifier syntax (separate track: `cli-shorthand`)
