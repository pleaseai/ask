import { defineCollection, defineContentConfig, z } from '@nuxt/content'

const strategySchema = z.object({
  source: z.enum(['npm', 'github', 'web', 'llms-txt']),
  package: z.string().optional(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  tag: z.string().optional(),
  docsPath: z.string().optional(),
  url: z.string().optional(),
  urls: z.array(z.string()).optional(),
  maxDepth: z.number().optional(),
  allowedPathPrefix: z.string().optional(),
})

const aliasSchema = z.object({
  ecosystem: z.enum(['npm', 'pypi', 'pub', 'go', 'crates', 'hex', 'nuget']),
  name: z.string(),
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
        description: z.string(),
        repo: z.string().regex(/^[^/]+\/[^/]+$/, 'repo must be in "owner/name" form'),
        docsPath: z.string().optional(),
        homepage: z.string().optional(),
        license: z.string().optional(),
        aliases: z.array(aliasSchema).optional().default([]),
        strategies: z.array(strategySchema).optional().default([]),
        tags: z.array(z.string()).optional(),
      }),
    }),
  },
})
