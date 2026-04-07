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

interface Alias {
  ecosystem: string
  name: string
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
  const slug = getRouterParam(event, 'slug')

  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: 'Missing slug' })
  }

  const segments = slug.split('/')
  if (segments.length !== 2) {
    throw createError({ statusCode: 400, statusMessage: 'Slug must be in "owner/repo" or "ecosystem/name" form' })
  }

  const [first, second] = segments
  const directPath = `/registry/${first}/${second}`

  // 1. Try direct path lookup (owner/repo)
  const directEntries = await queryCollection(event, 'registry')
    .where('path', '=', directPath)
    .all()

  if (directEntries.length > 0) {
    const entry = directEntries[0]

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
        statusMessage: `Misconfigured registry entry ${slug}: ${(error as Error).message}`,
      })
    }

    return {
      name: entry.name,
      description: entry.description,
      repo: entry.repo,
      docsPath: entry.docsPath,
      homepage: entry.homepage,
      license: entry.license,
      aliases: entry.aliases,
      strategies,
      tags: entry.tags,
    }
  }

  // 2. Fallback: search by alias (ecosystem/name)
  const allEntries = await queryCollection(event, 'registry').all()
  const matched = allEntries.find((entry) => {
    const aliases = entry.aliases as Alias[] | undefined
    if (!aliases) return false
    return aliases.some(a => a.ecosystem === first && a.name === second)
  })

  if (!matched) {
    throw createError({ statusCode: 404, statusMessage: `Entry not found: ${slug}` })
  }

  let strategies: Strategy[]
  try {
    strategies = expandStrategies({
      repo: matched.repo,
      docsPath: matched.docsPath,
      strategies: matched.strategies,
    })
  }
  catch (error) {
    throw createError({
      statusCode: 422,
      statusMessage: `Misconfigured registry entry ${slug}: ${(error as Error).message}`,
    })
  }

  return {
    name: matched.name,
    description: matched.description,
    repo: matched.repo,
    docsPath: matched.docsPath,
    homepage: matched.homepage,
    license: matched.license,
    aliases: matched.aliases,
    strategies,
    tags: matched.tags,
  }
})
