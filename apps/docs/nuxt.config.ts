import process from 'node:process'
import { defineNuxtConfig } from 'nuxt/config'

// Pick the Content database backend based on the build target.
// Mirrors apps/registry/nuxt.config.ts — Cloudflare Pages builds must use
// the D1 binding, while local builds use the native sqlite connector.
// Signals checked (build-time env, not runtime):
//   - `NITRO_PRESET=cloudflare_pages` (set by the `build` script)
//   - `CF_PAGES=1` (injected by Cloudflare Pages CI automatically)
//   - `NUXT_CONTENT_DATABASE_TYPE=d1` (manual override)
const nitroPreset = process.env.NITRO_PRESET ?? ''
const isCloudflareBuild
  = nitroPreset.startsWith('cloudflare')
    || process.env.CF_PAGES === '1'
    || process.env.NUXT_CONTENT_DATABASE_TYPE === 'd1'

export default defineNuxtConfig({
  extends: ['docs-please'],

  site: {
    name: 'ASK Docs',
    url: 'https://ask.pleaseai.dev',
  },

  content: {
    database: isCloudflareBuild
      ? { type: 'd1' as const, bindingName: 'DB' }
      : { type: 'sqlite' as const, filename: '.data/content/contents.sqlite' },
    experimental: {
      sqliteConnector: 'native',
    },
  },

  routeRules: {
    '/': { prerender: true },
  },

  compatibilityDate: '2025-12-03',

  nitro: {
    cloudflare: {
      deployConfig: true,
      nodeCompat: true,
    },
  },

  llms: {
    domain: 'https://ask.pleaseai.dev',
    title: 'ASK',
    description: 'Agent Skills Kit — version-accurate library docs for AI coding agents.',
    full: {
      title: 'ASK Docs',
      description: 'Documentation for the Agent Skills Kit (@pleaseai/ask).',
    },
  },
})
