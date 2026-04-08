import { defineCollection, defineContentConfig } from '@nuxt/content'
import { registryEntrySchema } from '@pleaseai/registry-schema'

export default defineContentConfig({
  collections: {
    content: defineCollection({
      type: 'page',
      source: {
        include: '**/*.md',
        exclude: ['registry/**'],
      },
    }),
    registry: defineCollection({
      type: 'page',
      source: 'registry/**/*.md',
      schema: registryEntrySchema,
    }),
  },
})
