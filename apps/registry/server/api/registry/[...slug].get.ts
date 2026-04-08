import { expandStrategies } from '@pleaseai/registry-schema'
import type { RegistryAlias, RegistryStrategy } from '@pleaseai/registry-schema'

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

    let strategies: RegistryStrategy[]
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
    const aliases = entry.aliases as RegistryAlias[] | undefined
    if (!aliases) return false
    return aliases.some(a => a.ecosystem === first && a.name === second)
  })

  if (!matched) {
    throw createError({ statusCode: 404, statusMessage: `Entry not found: ${slug}` })
  }

  let strategies: RegistryStrategy[]
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
