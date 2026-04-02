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

  compatibilityDate: '2026-04-03',
})
