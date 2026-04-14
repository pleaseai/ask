---
product_spec_domain: registry
---

# Registry JSON Migration

> Track: telemetry-driven-registry-20260413

## Overview

Switch registry entries from Markdown (`.md` with YAML frontmatter) to JSON (`.json`) files in Nuxt Content v3. The registry serves as a CLI-routing lookup table only — the markdown body content in each entry is unused. JSON eliminates YAML indentation pitfalls, enables IDE autocomplete via JSON Schema, lowers the community contribution barrier, and provides a cleaner foundation for future telemetry-driven auto-registration.

## Background

Current registry entries are Markdown files with YAML frontmatter (`content/registry/<owner>/<repo>.md`). The structured data lives entirely in the frontmatter; the markdown body (e.g., `# React\n\nLibrary for building...`) is never rendered or consumed by any client. Nuxt Content v3 natively supports JSON files with `type: 'data'` collections, making this migration straightforward.

## Requirements

### Functional Requirements

- [ ] FR-1: Convert all existing registry `.md` files to `.json` files, preserving the frontmatter data structure exactly
- [ ] FR-2: Update `content.config.ts` to use `type: 'data'` and `source: 'registry/**/*.json'`
- [ ] FR-3: Export a JSON Schema file from `registryEntrySchema` (zod-to-json-schema) for IDE autocomplete and validation
- [ ] FR-4: All existing API routes (`/api/registry/:owner/:repo`, ecosystem alias lookups) must continue to work identically
- [ ] FR-5: Create an automated migration script to convert `.md` → `.json` (extract YAML frontmatter, discard body)
- [ ] FR-6: Update the `ask-registry` skill in the CLI (`.claude/skills/ask-registry/`) if it references the markdown format

### Non-functional Requirements

- [ ] NFR-1: Build time must not regress (JSON parsing should be faster than markdown + YAML frontmatter)
- [ ] NFR-2: Cloudflare Pages deployment must continue to work (D1 database population from JSON)
- [ ] NFR-3: JSON Schema file should be published alongside the `@pleaseai/ask-schema` package

## Acceptance Criteria

- [ ] AC-1: All 50 registry entries exist as `.json` files with identical data to the previous `.md` frontmatter
- [ ] AC-2: `bun run --cwd apps/registry build` succeeds
- [ ] AC-3: `GET /api/registry/facebook/react` returns the same response as before migration
- [ ] AC-4: `GET /api/registry/npm/react` (ecosystem alias) returns the same response as before migration
- [ ] AC-5: No `.md` files remain in `content/registry/`
- [ ] AC-6: JSON Schema file is generated and validates all 50 entries without errors
- [ ] AC-7: E2E tests pass against the migrated registry

## Out of Scope

- Telemetry collection in CLI (separate track)
- Telemetry aggregation server (separate track)
- tagPattern field addition to schema (separate track, tied to telemetry)
- Registry web browser UI changes (CLI routing only)
- Schema structural changes beyond format migration

## Assumptions

- Nuxt Content v3 `type: 'data'` collection uses `stem` (not `path`) as the primary routing field; `queryCollection` API is the same but callers must use `.where('stem', '=', ...)` instead of `.path(...)` or `.where('path', '=', ...)`
- The `registryEntrySchema` zod schema can be converted to JSON Schema without loss
- No downstream consumers depend on the markdown body content of registry entries
