import { defineConfig } from 'vitest/config'

// Plain Node environment — the e2e helper boots its own server (or targets
// an external `host`), and the config-level unit test doesn't need Nuxt
// runtime wiring. Using `@nuxt/test-utils/config` here would force every
// test file into the Nuxt Vite pipeline, which currently fails inside this
// bun-workspace layout (MagicString constructor crash when @vitejs/plugin-vue
// follows the `.bun/` symlinks).
export default defineConfig({
  test: {
    include: ['test/**/*.{test,spec}.ts'],
  },
})
