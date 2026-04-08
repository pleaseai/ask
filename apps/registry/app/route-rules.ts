/**
 * Edge caching configuration for the registry lookup API.
 *
 * Applied via Nitro `routeRules` in `nuxt.config.ts`. On a cache HIT the
 * Cloudflare Pages Worker is bypassed entirely via the Cache API.
 *
 * - Browsers / CLI: 5 min fresh (`max-age=300`)
 * - Cloudflare edge: 1 h fresh (`s-maxage=3600`), 24 h stale-while-revalidate
 *
 * Exported separately so it can be asserted from tests without evaluating
 * the full `nuxt.config.ts` (which relies on Nuxt's auto-imports).
 *
 * Track: registry-edge-cache-20260408
 */
export const REGISTRY_CACHE_CONTROL
  = 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400'

export const registryApiRouteRules = {
  '/api/registry/**': {
    cache: {
      maxAge: 60 * 60,
      swr: true,
      staleMaxAge: 60 * 60 * 24,
    },
    headers: {
      'cache-control': REGISTRY_CACHE_CONTROL,
    },
  },
} as const
