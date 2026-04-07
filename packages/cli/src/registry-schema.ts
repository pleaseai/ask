import type { RegistryStrategy } from './registry.js'

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
