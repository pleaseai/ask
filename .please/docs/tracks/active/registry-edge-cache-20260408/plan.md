# Plan: Registry API Edge Caching

> Track: registry-edge-cache-20260408
> Spec: [spec.md](./spec.md)

## Overview

- **Source**: /please:new-track
- **Track**: registry-edge-cache-20260408
- **Issue**: #34
- **Created**: 2026-04-08
- **Approach**: Nitro `routeRules` edge cache — ship AC-1–AC-4 first, defer ETag (AC-5) and deploy-purge (AC-6) behind feature checks.

## Purpose

Cut Worker CPU/request cost and improve CLI latency for `/api/registry/**` by delegating repeat lookups to the Cloudflare edge, while keeping staleness bounded to the `max-age + swr` window.

## Context

`apps/registry/nuxt.config.ts` currently has no `routeRules` block. The `/api/registry/[...slug].get.ts` handler runs on every CLI lookup, doing a Content Query + `expandStrategies` on each request. Registry data is effectively static between Pages deploys, so it is a clean fit for SWR edge caching.

## Architecture Decision

Use Nitro `routeRules` with `cache.swr + staleMaxAge` plus an explicit `cache-control` header rather than `defineCachedEventHandler`, because:

1. `routeRules` is applied by the `cloudflare-pages` Nitro preset at the edge via the Cache API — on a HIT the Worker is bypassed entirely, which directly serves the cost goal. An application-layer cache still costs a Worker invocation.
2. Nitro emits `cf-cache-status`/`age` when the edge serves a hit, making AC-1 observable without custom instrumentation.
3. Headers are declared once in `nuxt.config.ts` and apply to both code paths in the route (direct + alias fallback) without touching handler logic.

ETag (FR-3) and deploy-purge (FR-4) are deliberately deferred: they are additive and the issue recommends (A)+(C) first.

## Tasks

- [ ] T001 Add `routeRules['/api/registry/**']` with `cache: { maxAge: 3600, swr: true, staleMaxAge: 86400 }` and explicit `cache-control: public, max-age=300, s-maxage=3600, stale-while-revalidate=86400` header (file: apps/registry/nuxt.config.ts)
- [ ] T002 Add a server-route integration test asserting the outgoing `cache-control` header exactly matches the spec value (AC-2) (file: apps/registry/test/api-registry-cache.test.ts) (depends on T001)
- [ ] T003 Verify no regression in existing CLI registry tests by running `bun run --cwd packages/cli test` and capturing result (AC-4) (file: packages/cli/test/registry.test.ts) (depends on T001)
- [ ] T004 Post-deploy manual verification: `curl -sI https://<pages-url>/api/registry/vercel/next.js` twice and confirm second call returns `cf-cache-status: HIT` (AC-1); document result in the track retrospective (file: .please/docs/tracks/active/registry-edge-cache-20260408/plan.md) (depends on T001)

## Key Files

- `apps/registry/nuxt.config.ts` — add `routeRules` (primary change)
- `apps/registry/server/api/registry/[...slug].get.ts` — unchanged; verify no Set-Cookie / per-request variance that would poison a shared cache
- `apps/registry/test/api-registry-cache.test.ts` — new test for header assertion
- `packages/cli/test/registry.test.ts` — existing regression surface

## Verification

- **AC-1**: Two consecutive `curl -I` against the deployed Pages URL show second response with `cf-cache-status: HIT` (manual, T004).
- **AC-2**: Automated test in `api-registry-cache.test.ts` asserts exact `cache-control` header (T002).
- **AC-3**: Deploy a registry markdown change; confirm visibility within `max-age + swr` window without manual purge (manual observation, post-merge).
- **AC-4**: `bun run --cwd packages/cli test` passes with zero new failures (T003).
- **AC-5/AC-6**: Deferred — not in this track.

## Progress

_Populated by /please:implement._

## Decision Log

- 2026-04-08: Chose `routeRules` over `defineCachedEventHandler` to bypass the Worker on HIT (cost goal).
- 2026-04-08: Defer ETag and deploy-purge per issue recommendation (A)+(C).

## Surprises & Discoveries

_Populated during implementation._
