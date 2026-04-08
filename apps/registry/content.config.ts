import { defineCollection, defineContentConfig } from '@nuxt/content'
import { registryEntrySchema } from '@pleaseai/ask-schema'

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
