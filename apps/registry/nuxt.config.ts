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
    database: {
      type: 'd1',
      bindingName: 'DB',
    },
  },

  compatibilityDate: '2026-04-03',
})
