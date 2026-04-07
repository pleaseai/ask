# Plan: Registry Schema Metadata Enrichment

## Architecture

Touch the registry schema and the strategy-resolution logic on both sides (CLI and API) at the same time. The key is to extract `expandStrategies` into a shared pure function so both consumers produce identical results.

```
apps/registry/content.config.ts        # extend zod schema
packages/cli/src/registry-schema.ts    # new: shared types + expandStrategies
apps/registry/server/...               # apply expand on API response
packages/cli/src/registry.ts           # apply expand defensively on CLI side too
```

If a `packages/shared` workspace doesn't exist, place the helper at `packages/cli/src/registry-schema.ts` for now and have the registry app import it via a workspace path. Both live in the same monorepo, so cross-package imports are fine.

## Files

| Change | File | Notes |
|---|---|---|
| Modify | `apps/registry/content.config.ts` | Add `repo`, `homepage`, `license`, `docsPath` fields; refinement |
| Add | `packages/cli/src/registry-schema.ts` | `expandStrategies(entry)` shared function and types |
| Modify | `packages/cli/src/registry.ts` | Call `expandStrategies` after parsing API response |
| Add/Verify | `apps/registry/server/api/registry/[ecosystem]/[name].get.ts` | Apply `expandStrategies` before returning. **This file does not currently exist** — registry likely relies on Nuxt Content's collection auto-API. T-4 must first identify the current response path and then either (a) add a new server route to apply expand, or (b) use a Nitro plugin to transform the collection response. |
| Modify | `apps/registry/content/registry/npm/zod.md` | Add `repo: colinhacks/zod`; simplify strategies |
| Modify | `apps/registry/content/registry/npm/next.md` | Add `repo: vercel/next.js` |
| Modify | `apps/registry/content/registry/npm/nuxt.md` | Same |
| Modify | `apps/registry/content/registry/npm/nuxt-ui.md` | Same |
| Modify | `apps/registry/content/registry/npm/tailwindcss.md` | Add `homepage`, `license` |
| Modify | `apps/registry/content/registry/pypi/fastapi.md` | Add `repo: fastapi/fastapi` |
| Add | `packages/cli/test/registry-schema.test.ts` | Unit tests for `expandStrategies` |

## Tasks

- **T-1** [impl] Implement `expandStrategies` and supporting types
- **T-2** [test] Unit tests for `expandStrategies` — `repo` only / `strategies` only / both / neither (error)
- **T-3** [impl] Schema changes in `content.config.ts` — change `strategies` to `z.array(strategySchema).optional().default([])`, add `repo` / `homepage` / `license` / `docsPath` optional fields, plus a refinement requiring at least one of `strategies` or `repo`
- **T-4** [impl] Identify the current registry API response path and apply expand (new server route or Nitro plugin)
- **T-5** [impl] Apply `expandStrategies` defensively in the CLI's `resolveFromRegistry`
- **T-6** [chore] Migrate the 6 existing entries
- **T-7** [test] Verify `bun run --cwd apps/registry build` passes
- **T-8** [test] CLI regression — confirm existing entries still resolve

## Risks

- Changing the API response shape risks breaking cached clients → keep `strategies` populated to maintain compatibility
- The zod refinement only runs at build time → confirm CI runs the build step

## Dependencies

- Independently shippable. Can run in parallel with `cli-shorthand`.
- `ecosystem-resolvers` benefits from this schema, so completing this track first (or in parallel) is natural.

## Outcomes & Retrospective

### What Was Shipped
- `expandStrategies` shared helper for auto-generating github strategies from `repo` field
- Extended registry schema with `repo`, `homepage`, `license`, `docsPath` optional fields
- Custom Nitro server route applying strategy expansion on API responses
- CLI-side defensive expansion in `resolveFromRegistry`
- All 6 existing registry entries migrated with metadata enrichment
- Zod entry simplified to repo-only (no strategies array needed)

### What Went Well
- TDD approach caught edge cases early (empty array vs missing strategies)
- Schema refinement ensures data integrity at build time
- Review loop identified real error handling gaps (bare catch, uncaught throw)

### What Could Improve
- `expandStrategies` is duplicated between CLI and server due to Nitro build constraints — a shared package would be cleaner
- Server route Strategy interface is also duplicated — consider a shared types package

### Tech Debt Created
- Duplicated `expandStrategies` and `Strategy` type between `packages/cli/src/registry-schema.ts` and `apps/registry/server/api/registry/[ecosystem]/[name].get.ts`
