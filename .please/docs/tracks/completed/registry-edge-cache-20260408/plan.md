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

- [x] T001 Add `routeRules['/api/registry/**']` with `cache: { maxAge: 3600, swr: true, staleMaxAge: 86400 }` and explicit `cache-control: public, max-age=300, s-maxage=3600, stale-while-revalidate=86400` header. Extracted to `apps/registry/app/route-rules.ts` so tests can import without loading Nuxt's auto-import graph (file: apps/registry/nuxt.config.ts, apps/registry/app/route-rules.ts)
- [x] T002 Static config assertion test validates the exported `registryApiRouteRules` / `REGISTRY_CACHE_CONTROL` constants (AC-2). Uses `bun test` — no new test runner introduced (file: apps/registry/test/nuxt-config.test.ts) (depends on T001)
- [x] T003 `bun run --cwd packages/cli test`: 227 pass / 0 fail (AC-4) (depends on T001)
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

- `defineNuxtConfig` auto-imported by Nuxt cannot be used from a standalone `bun test` context. Two options were considered: (1) explicitly import from `nuxt/config`, which loses module augmentation types from `@nuxt/content` and breaks type-checking of the existing `content` block; (2) extract the route-rules to a plain TS module that the test can import directly. Chose (2) — cleaner separation and the test is fully decoupled from Nuxt's runtime.
- `apps/registry` had no test runner at all. Rather than introducing `@nuxt/test-utils` + `vitest` for a single header assertion, reused the monorepo's existing `bun test` pattern (already used by `packages/cli`). Added a `test` script to `apps/registry/package.json`.
- Worktrees need a fresh `bun install` before tests run (known gotcha in CLAUDE.md).

## Outcomes & Retrospective

### What Was Shipped

- Nitro `routeRules` for `/api/registry/**` with `cache.swr` + explicit `cache-control` header — delivers AC-1 through AC-4.
- `apps/registry/app/route-rules.ts` as a small, isolated constants module (testable without Nuxt runtime).
- First test file for `apps/registry/` + `bun test` script.

### What Went Well

- TDD cycle stayed tight: RED (test imports `defineNuxtConfig` → fails) → pivot (extract constants) → GREEN in a single short iteration.
- CLI regression check (AC-4) was trivial — `bun run --cwd packages/cli test` returned 227 pass / 0 fail on the first run after the worktree `bun install`.
- Independent code-review agent validated integration concerns (Nuxt `app/` auto-scan, test bundling, `@nuxt/content` conflict) with no findings.

### What Could Improve

- The initial plan assumed an integration test against the running server. Reality check during implementation (no existing registry test infra) forced a pragmatic pivot to a static config assertion. Next time, scan the target package's test setup before drafting tasks.

### Tech Debt Created

- AC-5 (ETag) and AC-6 (deploy-hook purge) intentionally deferred per the issue's recommendation — track them as potential follow-ups if staleness becomes painful.
- `apps/registry` test coverage is still just one file. A real integration harness (`@nuxt/test-utils`) would be valuable once more server routes land (e.g., upcoming raw-docs API track).
