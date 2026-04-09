import process from 'node:process'

import { registryApiRouteRules } from './app/route-rules'

// Pick the Content database backend based on the build target.
// Cloudflare Pages/Workers builds must use the D1 binding — the
// `sqlite` (native) connector cannot load inside a Workers isolate and
// will crash the Worker on cold start if it ever reaches production.
// Signals checked (build-time env, not runtime):
//   - `NITRO_PRESET` is set to `cloudflare_pages` / `cloudflare-pages`
//     / `cloudflare_module` when building for Cloudflare.
//   - `CF_PAGES=1` is injected by Cloudflare Pages CI automatically.
//   - `NUXT_CONTENT_DATABASE_TYPE=d1` remains as a manual override for
//     cases where neither signal is present (e.g. custom pipelines).
const nitroPreset = process.env.NITRO_PRESET ?? ''
const isCloudflareBuild
  = nitroPreset.startsWith('cloudflare')
    || process.env.CF_PAGES === '1'
    || process.env.NUXT_CONTENT_DATABASE_TYPE === 'd1'

export default defineNuxtConfig({
  modules: [
    '@nuxt/content',
    '@nuxt/ui',
  ],

  css: ['~/assets/css/main.css'],

  content: {
    build: {
      markdown: {
        toc: { depth: 3 },
      },
    },
    database: isCloudflareBuild
      ? { type: 'd1' as const, bindingName: 'DB' }
      : { type: 'sqlite' as const, filename: '.data/content/contents.sqlite' },
    experimental: {
      sqliteConnector: 'native',
    },
  },

  // Edge caching for the registry lookup API (track registry-edge-cache-20260408).
  // On a cache HIT the Cloudflare Pages Worker is bypassed entirely via the Cache API.
  routeRules: registryApiRouteRules,

  compatibilityDate: '2026-04-03',
})
