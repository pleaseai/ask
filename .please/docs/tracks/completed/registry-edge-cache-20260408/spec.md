---
product_spec_domain: registry/caching
---

# Registry API Edge Caching

> Track: registry-edge-cache-20260408

## Overview

Cache `/api/registry/**` responses at the Cloudflare edge so repeat CLI lookups bypass the Worker entirely. Registry data is effectively static between deploys (markdown files in git), so aggressive edge caching reduces Worker CPU/request cost and improves CLI latency. Lays groundwork for the future raw-docs API track.

## Requirements

### Functional Requirements

- [ ] FR-1: Configure Nitro `routeRules` in `apps/registry/nuxt.config.ts` for `/api/registry/**` with `cache: { maxAge: 3600, swr: true, staleMaxAge: 86400 }` and `cache-control: public, max-age=300, s-maxage=3600, stale-while-revalidate=86400`.
- [ ] FR-2: Ensure the configured cache headers propagate on actual responses from the deployed Cloudflare Pages Worker (not just in local dev).
- [ ] FR-3 (optional, second commit): Emit a sha256-of-body `ETag` header via Nitro's `handleCacheHeaders`, enabling future CLI `If-None-Match` → 304 conditional GETs.
- [ ] FR-4 (optional, deferred): Deploy-hook cache purge — GitHub Action calls Cloudflare Cache Purge API on main-branch deploys. Ship only if maintainers report staleness pain.

### Non-functional Requirements

- [ ] NFR-1: Zero regressions in `packages/cli/test/registry.test.ts` and live-registry integration.
- [ ] NFR-2: Cache strategy must tolerate up to ~1 hour of staleness after a registry markdown change without manual intervention.

## Acceptance Criteria

- [ ] AC-1: Hitting `/api/registry/vercel/next.js` twice in a row from two different machines shows the second response served with `cf-cache-status: HIT`.
- [ ] AC-2: `cache-control` response header exactly matches `public, max-age=300, s-maxage=3600, stale-while-revalidate=86400`.
- [ ] AC-3: A registry markdown change deployed via Cloudflare Pages becomes visible within the `max-age + swr` window without any manual purge.
- [ ] AC-4: No regression for existing tests in `packages/cli/test/registry.test.ts` and the integration with the live registry.
- [ ] AC-5 (if ETag included): A second request with `If-None-Match: <etag>` returns 304 with no body.
- [ ] AC-6 (if deploy purge included): GH Action workflow calls the CF cache purge API on main-branch deploys and the run is observable in workflow logs.

## Out of Scope

- Caching the docs files themselves (separate raw-docs API track).
- Origin-side application cache (`defineCachedEventHandler`).
- Per-region cache differentiation.
- CLI-side `If-None-Match` sending (follow-up track).

## Assumptions

- Cloudflare Pages + Nitro's `cloudflare-pages` preset honors `routeRules.cache` at the edge via the Cache API.
- Registry markdown changes ship via normal Pages deploys; up to ~1 hour staleness is acceptable by default.
- The route currently has no per-user or per-request variance that would make a shared edge cache unsafe.

## Related

- #33 — `npm-tarball-docs-20260408` (server-side disambiguation made caching valuable)
- Future: registry raw-docs API track
- Future: telemetry implementation track
- Issue: pleaseai/ask#34
