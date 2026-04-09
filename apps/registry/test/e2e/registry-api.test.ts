import process from 'node:process'

import { describe, expect, it } from 'vitest'

/**
 * End-to-end tests for the registry lookup API.
 *
 * The suite talks to a running Nuxt server so Nuxt Content, the
 * `queryCollection` runtime, the `[...slug]` route, and the per-isolate
 * alias cache all exercise their production code paths.
 *
 * ## Why we don't use `@nuxt/test-utils/e2e` `setup()`
 *
 * 1. Its self-boot path runs a full Nuxt build which currently crashes
 *    inside this bun-workspace layout (`@vitejs/plugin-vue` follows the
 *    `.bun/` symlinks and blows up with
 *    `TypeError: MagicString is not a constructor`). Same class of issue
 *    as the native-module gotcha documented in CLAUDE.md.
 * 2. Pulling `@nuxt/test-utils` into the workspace drags in an
 *    `h3-next` npm alias (`"h3-next": "npm:h3@2.0.1-rc.*"`) which then
 *    gets hoisted ahead of h3 v1 and breaks `@nuxt/content` at runtime
 *    with `event.req.headers.entries is not a function`. We discovered
 *    this while debugging the production registry outage — keeping h3 on
 *    a single v1 line is load-bearing.
 *
 * ## How to run it
 *
 *     # Terminal A
 *     bun run --cwd apps/registry dev
 *
 *     # Terminal B
 *     REGISTRY_E2E_HOST=http://localhost:3000 bun run --cwd apps/registry test
 *
 * When `REGISTRY_E2E_HOST` is unset the suite is skipped so `bun run test`
 * stays green in runs that don't boot the app.
 */
const HOST = process.env.REGISTRY_E2E_HOST

function apiUrl(path: string): string {
  return `${HOST}/api/registry${path}`
}

async function getJson(path: string): Promise<any> {
  const res = await fetch(apiUrl(path))
  if (!res.ok)
    throw new Error(`${path} → ${res.status} ${res.statusText}`)
  return res.json()
}

describe.skipIf(!HOST)('GET /api/registry/:slug', () => {
  it('resolves a single-package entry via direct owner/repo path', async () => {
    const res = await getJson('/facebook/react')

    expect(res.name).toBe('React')
    expect(res.repo).toBe('facebook/react')
    expect(res.resolvedName).toBe('React')
    expect(res.package.name).toBe('react')
    expect(Array.isArray(res.sources)).toBe(true)
    expect(res.sources.length).toBeGreaterThan(0)
  })

  it('resolves a single-package entry via ecosystem alias', async () => {
    // `react-dom` is declared as an alias on the `react` package.
    const res = await getJson('/npm/react-dom')

    expect(res.repo).toBe('facebook/react')
    expect(res.package.name).toBe('react')
  })

  it('returns 409 for a monorepo entry looked up via owner/repo', async () => {
    const res = await fetch(apiUrl('/mastra-ai/mastra'))
    expect(res.status).toBe(409)
  })

  it('disambiguates a monorepo entry via a scoped npm alias', async () => {
    // URL-encode the scoped name so the catch-all slug still splits cleanly
    // into two segments (`npm` / `@mastra/memory`).
    const res = await getJson(`/npm/${encodeURIComponent('@mastra/memory')}`)

    expect(res.repo).toBe('mastra-ai/mastra')
    expect(res.package.name).toBe('@mastra/memory')
    // Monorepo entries expose a slugified resolvedName so distinct scoped
    // packages land in distinct `.ask/docs/<name>@<ver>/` directories.
    expect(res.resolvedName).toBe('mastra-memory')
  })

  it('returns 404 for an unknown entry', async () => {
    const res = await fetch(apiUrl('/nope/nope'))
    expect(res.status).toBe(404)
  })

  it('returns 400 when the slug is not two segments', async () => {
    const res = await fetch(apiUrl('/only-one-segment'))
    expect(res.status).toBe(400)
  })

  it('emits s-maxage / stale-while-revalidate directives for edge caching', async () => {
    // The fully-formed `public, max-age=300, s-maxage=3600, swr=86400`
    // header only appears in production builds — Nitro's dev server emits
    // just the `cache` portion (`s-maxage`, `swr`) and drops the static
    // `headers.cache-control` we set in `app/route-rules.ts`. We assert
    // the directives Nitro actually emits here; the unit test in
    // `test/nuxt-config.test.ts` covers the production header value.
    const res = await fetch(apiUrl('/facebook/react'))
    const header = res.headers.get('cache-control') ?? ''
    expect(header).toMatch(/s-maxage=3600/)
    expect(header).toMatch(/stale-while-revalidate=86400/)
  })
})
