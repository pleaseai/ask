# Extract Shared Registry Schema Package

> Track: extract-shared-registry-20260408

## Overview

Extract duplicated registry types, Zod schemas, and utility functions from `packages/cli` and `apps/registry` into a new shared workspace package `packages/registry-schema` (`@pleaseai/registry-schema`).

Currently, `RegistryStrategy`, `RegistryAlias`, `RegistryEntry` interfaces are defined in `packages/cli/src/registry.ts`, while equivalent Zod schemas exist in `apps/registry/content.config.ts`. The `expandStrategies()` function is intentionally duplicated in both `packages/cli/src/registry-schema.ts` and `apps/registry/server/api/registry/[...slug].get.ts` because Nitro could not resolve cross-package imports. A dedicated shared package resolves this constraint.

## Scope

### In Scope

- **New package**: `packages/registry-schema` with `@pleaseai/registry-schema` as the package name
- **Zod schemas**: Define canonical Zod schemas for `Strategy`, `Alias`, and `RegistryEntry` in the shared package
- **TypeScript types**: Infer TypeScript types from Zod schemas (single source of truth)
- **Shared utilities**: Move `expandStrategies()` to the shared package
- **CLI migration**: Replace `RegistryStrategy`, `RegistryAlias`, `RegistryEntry` interfaces in `packages/cli/src/registry.ts` with re-exports from the shared package
- **Registry migration**: Replace local Zod schemas in `apps/registry/content.config.ts` and local interfaces/functions in `apps/registry/server/api/registry/[...slug].get.ts` with imports from the shared package
- **Workspace config**: Add `packages/registry-schema` to the bun workspace

### Out of Scope

- CLI command logic or behavior changes
- Registry API endpoint behavior changes
- New features or additional schemas beyond what currently exists
- Publishing `@pleaseai/registry-schema` to npm (internal workspace package only)

## Success Criteria

- [ ] SC-1: `packages/registry-schema` package exists with Zod schemas, inferred types, and `expandStrategies()`
- [ ] SC-2: `packages/cli` imports all registry types from `@pleaseai/registry-schema` — no local type definitions remain
- [ ] SC-3: `apps/registry` imports schemas and `expandStrategies()` from `@pleaseai/registry-schema` — no duplicated code remains
- [ ] SC-4: All existing CLI tests pass without modification
- [ ] SC-5: Registry app builds and dev server starts successfully
- [ ] SC-6: `bun run build` succeeds at the monorepo root
- [ ] SC-7: `bun run lint` passes across all packages

## Constraints

- No special constraints — free to restructure as needed
- External behavior (CLI output, API responses) must remain identical

## Technical Notes

- The shared package must be Pure ESM (`"type": "module"`) with `.js` import extensions
- Use the same ESLint config (`@pleaseai/eslint-config`) as other packages
- Zod is already used in `apps/registry` via `@nuxt/content` — the shared package should use `zod` directly as a dependency
- TypeScript types should be inferred from Zod schemas using `z.infer<>` to maintain a single source of truth
