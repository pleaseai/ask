import { registryApiRouteRules } from './app/route-rules'

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
    database: process.env.NUXT_CONTENT_DATABASE_TYPE === 'd1'
      ? { type: 'd1' as const, bindingName: 'DB' }
      : { type: 'sqlite' as const },
    experimental: {
      sqliteConnector: 'native',
    },
  },

  // Edge caching for the registry lookup API (track registry-edge-cache-20260408).
  // On a cache HIT the Cloudflare Pages Worker is bypassed entirely via the Cache API.
  routeRules: registryApiRouteRules,

  compatibilityDate: '2026-04-03',
})
