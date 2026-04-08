import { z } from 'zod'

export const strategySchema = z.object({
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

export const aliasSchema = z.object({
  ecosystem: z.enum(['npm', 'pypi', 'pub', 'go', 'crates', 'hex', 'nuget', 'maven']),
  name: z.string(),
})

export const registryEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  repo: z.string().regex(/^[^/]+\/[^/]+$/, 'repo must be in "owner/name" form'),
  docsPath: z.string().optional(),
  homepage: z.string().optional(),
  license: z.string().optional(),
  aliases: z.array(aliasSchema).optional().default([]),
  strategies: z.array(strategySchema).optional().default([]),
  tags: z.array(z.string()).optional(),
})

export type RegistryStrategy = z.infer<typeof strategySchema>
export type RegistryAlias = z.infer<typeof aliasSchema>
export type RegistryEntry = z.infer<typeof registryEntrySchema>

export interface ExpandInput {
  repo?: string
  docsPath?: string
  strategies?: RegistryStrategy[]
}

/**
 * Expand a registry entry into a concrete list of strategies.
 *
 * When `strategies` is non-empty it is returned as-is.
 * When `strategies` is empty/missing but `repo` is provided,
 * a default github strategy is generated from `repo` (+ optional `docsPath`).
 *
 * @throws Error when neither `repo` nor non-empty `strategies` is present.
 */
export function expandStrategies(input: ExpandInput): RegistryStrategy[] {
  const { repo, docsPath, strategies } = input

  if (strategies && strategies.length > 0) {
    return strategies
  }

  if (repo) {
    const strategy: RegistryStrategy = { source: 'github', repo }
    if (docsPath) {
      strategy.docsPath = docsPath
    }
    return [strategy]
  }

  throw new Error('Registry entry requires at least one of `repo` or `strategies`')
}
