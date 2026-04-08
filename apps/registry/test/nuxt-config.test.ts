import { expect, test } from 'bun:test'

import { REGISTRY_CACHE_CONTROL, registryApiRouteRules } from '../app/route-rules'

test('registry API routeRules configure edge caching', () => {
  const rule = registryApiRouteRules['/api/registry/**']
  expect(rule).toBeDefined()
  expect(rule.headers['cache-control']).toBe(REGISTRY_CACHE_CONTROL)
  expect(REGISTRY_CACHE_CONTROL).toBe('public, max-age=300, s-maxage=3600, stale-while-revalidate=86400')
  expect(rule.cache).toEqual({
    maxAge: 60 * 60,
    swr: true,
    staleMaxAge: 60 * 60 * 24,
  })
})
