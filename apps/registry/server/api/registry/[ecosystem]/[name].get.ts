interface Strategy {
  source: 'npm' | 'github' | 'web' | 'llms-txt'
  package?: string
  repo?: string
  branch?: string
  tag?: string
  docsPath?: string
  url?: string
  urls?: string[]
  maxDepth?: number
  allowedPathPrefix?: string
}

/**
 * Expand a registry entry's strategies from `repo` when strategies is empty.
 *
 * NOTE: This function is intentionally duplicated from
 * `packages/cli/src/registry-schema.ts`. The Nitro build process cannot
 * reliably resolve cross-package workspace imports, so sharing via a
 * workspace package is not feasible here. Keep this implementation in sync
 * with the canonical source in registry-schema.ts.
 */
function expandStrategies(entry: {
  repo?: string
  docsPath?: string
  strategies?: Strategy[]
}): Strategy[] {
  const { repo, docsPath, strategies } = entry
  if (strategies && strategies.length > 0) return strategies
  if (repo) {
    const s: Strategy = { source: 'github', repo }
    if (docsPath) s.docsPath = docsPath
    return [s]
  }
  throw new Error('Registry entry requires at least one of `repo` or `strategies`')
}

export default defineEventHandler(async (event) => {
  const ecosystem = getRouterParam(event, 'ecosystem')
  const name = getRouterParam(event, 'name')

  if (!ecosystem || !name) {
    throw createError({ statusCode: 400, statusMessage: 'Missing ecosystem or name' })
  }

  const path = `/registry/${ecosystem}/${name}`

  const entries = await queryCollection(event, 'registry')
    .where('path', '=', path)
    .all()

  if (entries.length === 0) {
    throw createError({ statusCode: 404, statusMessage: `Entry not found: ${ecosystem}/${name}` })
  }

  const entry = entries[0]

  let strategies: Strategy[]
  try {
    strategies = expandStrategies({
      repo: entry.repo,
      docsPath: entry.docsPath,
      strategies: entry.strategies,
    })
  }
  catch (error) {
    throw createError({
      statusCode: 422,
      statusMessage: `Misconfigured registry entry ${ecosystem}/${name}: ${(error as Error).message}`,
    })
  }

  return {
    name: entry.name,
    ecosystem: entry.ecosystem,
    description: entry.description,
    repo: entry.repo,
    homepage: entry.homepage,
    license: entry.license,
    docsPath: entry.docsPath,
    strategies,
    tags: entry.tags,
  }
})
