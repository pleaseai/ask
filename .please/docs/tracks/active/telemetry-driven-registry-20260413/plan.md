# Plan: Registry JSON Migration

> Track: telemetry-driven-registry-20260413
> Spec: [spec.md](./spec.md)

## Overview

- **Source**: .please/docs/tracks/active/telemetry-driven-registry-20260413/spec.md
- **Issue**: #78
- **Created**: 2026-04-13
- **Approach**: Minimal Change

## Purpose

After this change, registry contributors will be able to add new library entries as plain JSON files with full IDE autocomplete and validation, instead of writing YAML frontmatter inside markdown files. They can verify it works by running `bun run --cwd apps/registry build` and confirming the registry API returns identical responses.

## Context

The registry stores 50 curated library entries as Markdown files with YAML frontmatter. The markdown body is never consumed by the CLI (which uses the API's structured response) and is rendered only on the web detail page. Since the registry's primary role is CLI routing, the body content adds no value while YAML frontmatter introduces indentation errors and raises the contribution barrier.

Nuxt Content v3 natively supports `type: 'data'` collections backed by JSON files, which eliminates the markdown parsing layer entirely. The `registryEntrySchema` (Zod) validates the same fields regardless of file format.

The Vue detail page references `entry.ecosystem` and `entry.strategies` — neither field exists in the schema or in any markdown file. These are dead code from an earlier schema iteration. The `ContentRenderer` component renders the markdown body, which will be removed along with the body itself.

Non-goals: telemetry, tagPattern schema changes, web UI redesign.

## Architecture Decision

The migration follows an in-place format swap: convert each `.md` file to `.json` by extracting the YAML frontmatter as a JSON object and discarding the body. The Nuxt Content collection type changes from `page` to `data`, and the source glob from `**/*.md` to `**/*.json`. All downstream consumers (API route, CLI) already work with the structured schema fields and are unaffected.

The Vue detail page loses `ContentRenderer` (no body to render) and the dead `ecosystem`/`strategies` references. A `description` field (already in the schema) replaces the body for the detail view. This is the simplest migration path with zero schema changes and full backward compatibility on the API surface.

For JSON Schema generation, `zod-to-json-schema` converts the existing Zod schema into a standard JSON Schema file that IDEs can consume via `$schema` references in each `.json` entry.

## Tasks

- [ ] T001 [P] Create md-to-json migration script (file: scripts/migrate-registry-to-json.ts)
- [x] (2026-04-13 15:00 KST) T002 [P] Add JSON Schema generation to schema package (file: packages/schema/src/json-schema.ts)
- [ ] T003 Convert registry entries from md to json (file: apps/registry/content/registry/) (depends on T001)
- [ ] T004 Update content.config.ts for JSON data collection (file: apps/registry/content.config.ts) (depends on T003)
- [ ] T005 Update Vue detail page — remove ContentRenderer and dead fields (file: apps/registry/app/pages/registry/[...slug].vue) (depends on T004)
- [ ] T006 Update Vue index page — remove dead ecosystem field (file: apps/registry/app/pages/index.vue) (depends on T004)
- [ ] T007 Verify API route compatibility with data collection (file: apps/registry/server/api/registry/[...slug].get.ts) (depends on T004)
- [ ] T008 Update and run tests (file: apps/registry/test/) (depends on T005, T006, T007)

## Key Files

### Create
- `scripts/migrate-registry-to-json.ts` — One-shot migration script: reads each `.md`, extracts YAML frontmatter, writes `.json`
- `packages/schema/src/json-schema.ts` — Generates JSON Schema from `registryEntrySchema` via `zod-to-json-schema`

### Modify
- `apps/registry/content.config.ts` — `type: 'page'` → `type: 'data'`, source glob `.md` → `.json`
- `apps/registry/app/pages/registry/[...slug].vue` — Remove `ContentRenderer`, `entry.ecosystem`, `entry.strategies`
- `apps/registry/app/pages/index.vue` — Remove `entry.ecosystem` badge
- `apps/registry/content/registry/**/*.md` → `**/*.json` — 50 files converted

### Reuse
- `packages/schema/src/registry.ts` — `registryEntrySchema` unchanged
- `apps/registry/server/api/registry/[...slug].get.ts` — API route logic unchanged (verify only)
- `apps/registry/test/e2e/registry-api.test.ts` — E2E tests should pass as-is

## Verification

### Automated Tests
- [ ] `bun run --cwd apps/registry build` succeeds with JSON entries
- [ ] E2E: `GET /api/registry/facebook/react` returns identical response
- [ ] E2E: `GET /api/registry/npm/react` alias lookup works
- [ ] E2E: monorepo entry returns 409 on direct path
- [ ] JSON Schema validates all 50 entries without errors
- [ ] Unit: `packages/schema` tests pass

### Observable Outcomes
- After running the migration script, `content/registry/` contains only `.json` files and no `.md` files
- Running `bun run --cwd apps/registry dev` and visiting the index page shows all 50 entries
- Each `.json` file has a `$schema` reference for IDE autocomplete

### Acceptance Criteria Check
- [ ] AC-1: All 50 entries exist as `.json` with identical data
- [ ] AC-2: Build succeeds
- [ ] AC-3/4: API responses unchanged
- [ ] AC-5: No `.md` files in `content/registry/`
- [ ] AC-6: JSON Schema validates all entries
- [ ] AC-7: E2E tests pass

## Decision Log

- Decision: In-place format swap (md → json) rather than dual-format support
  Rationale: Registry is CLI-routing only; no need for gradual migration or backward compat with md consumers
  Date/Author: 2026-04-13 / Claude

- Decision: Remove ContentRenderer and dead fields rather than migrating body to JSON field
  Rationale: Body content is never consumed by CLI; ecosystem and strategies are dead code not in schema
  Date/Author: 2026-04-13 / Claude
