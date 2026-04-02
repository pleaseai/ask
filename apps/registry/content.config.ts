import { defineCollection, defineContentConfig, z } from '@nuxt/content'

const strategySchema = z.object({
  source: z.enum(['npm', 'github', 'web']),
  package: z.string().optional(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  tag: z.string().optional(),
  docsPath: z.string().optional(),
  urls: z.array(z.string()).optional(),
  maxDepth: z.number().optional(),
  allowedPathPrefix: z.string().optional(),
})

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
      schema: z.object({
        name: z.string(),
        ecosystem: z.enum(['npm', 'pypi', 'pub', 'go', 'crates', 'hex', 'nuget']),
        description: z.string(),
        strategies: z.array(strategySchema),
        tags: z.array(z.string()).optional(),
      }),
    }),
  },
})
