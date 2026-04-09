import type { RegistryAlias, RegistryStrategy } from '@pleaseai/ask-schema'
import { expandStrategies } from '@pleaseai/ask-schema'

/**
 * Convert an npm package name into a filesystem- and skill-name-safe slug.
 *
 * Examples:
 *   - `@mastra/core`     → `mastra-core`
 *   - `@scope/pkg-name`  → `scope-pkg-name`
 *   - `lodash`           → `lodash`
 *
 * The CLI uses the returned slug as both a directory name
 * (`.ask/docs/<slug>@<ver>/`) and a Claude Code skill name. Both surfaces
 * reject `@` and `/`, so the registry server pre-slugifies the name and
 * exposes it as `resolvedName` in the response. Doing this on the server
 * keeps every client (CLI today, future SDKs tomorrow) consistent without
 * forcing each client to re-implement the rule.
 */
function slugifyPackageName(pkg: string): string {
  if (pkg.startsWith('@')) {
    return pkg.slice(1).replace('/', '-')
  }
  return pkg
}

/**
 * Pick the strategy that best satisfies a request for `requestedPackage`
 * out of an entry's full strategy list.
 *
 * Rules (in order):
 *   1. A curated npm strategy (`source: npm` with `docsPath`) whose
 *      `package` field equals `requestedPackage` wins outright. This is
 *      the monorepo disambiguation case — `mastra-ai/mastra` declares
 *      both `@mastra/core` and `@mastra/memory`; we must hand the caller
 *      the strategy that matches what they actually asked for.
 *   2. Any other curated npm strategy (first in declaration order).
 *   3. Fall through to the default github strategy.
 *
 * The result is a list of strategies in execution priority order — the
 * caller picks the head and uses the rest as fallback. We return a list
 * (not a single strategy) so the CLI can still iterate through fallbacks
 * if the head fails (e.g. tarball missing the curated docs dir → github).
 */
function disambiguateStrategies(
  all: RegistryStrategy[],
  requestedPackage?: string,
): RegistryStrategy[] {
  if (!requestedPackage) {
    return all
  }

  const matchingNpm = all.find(
    s => s.source === 'npm' && s.package === requestedPackage && s.docsPath,
  )
  if (!matchingNpm) {
    return all
  }

  // Put the matching npm strategy first; keep every other strategy in its
  // original order behind it (the github fallback in particular).
  const rest = all.filter(s => s !== matchingNpm)
  return [matchingNpm, ...rest]
}

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')

  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: 'Missing slug' })
  }

  // Decode each segment so callers can URL-encode scoped npm packages
  // (`@mastra/client-js` → `%40mastra%2Fclient-js`) and still land on a
  // two-segment slug here. Nitro decodes `%40` but leaves `%2F` in the
  // catch-all param, so we have to handle the decode ourselves.
  const segments = slug.split('/').map(s => decodeURIComponent(s))
  if (segments.length !== 2) {
    throw createError({ statusCode: 400, statusMessage: 'Slug must be in "owner/repo" or "ecosystem/name" form' })
  }

  const [first, second] = segments
  const directPath = `/registry/${first}/${second}`

  // 1. Try direct path lookup (owner/repo). No disambiguation needed —
  //    `owner/repo` is unambiguous and the caller is asking for the
  //    repo as a whole.
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
      resolvedName: entry.name,
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

  // 2. Fallback: search by alias (ecosystem/name). The alias is the
  //    user's intent, so disambiguate strategies and slugify the
  //    response name based on `second` (the requested package).
  const allEntries = await queryCollection(event, 'registry').all()
  const matched = allEntries.find((entry) => {
    const aliases = entry.aliases as RegistryAlias[] | undefined
    if (!aliases)
      return false
    return aliases.some(a => a.ecosystem === first && a.name === second)
  })

  if (!matched) {
    throw createError({ statusCode: 404, statusMessage: `Entry not found: ${slug}` })
  }

  let allStrategies: RegistryStrategy[]
  try {
    allStrategies = expandStrategies({
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

  // Detect monorepo entries (multiple npm strategies). For these, the
  // resolved name is the slugified requested package so different scoped
  // packages from the same repo land in distinct `.ask/docs/<slug>@<ver>`
  // directories on the client side.
  const npmStrategyCount = (matched.strategies ?? []).filter((s: RegistryStrategy) => s.source === 'npm').length
  const isMonorepoEntry = npmStrategyCount > 1
  const resolvedName = isMonorepoEntry ? slugifyPackageName(second) : matched.name

  const strategies = disambiguateStrategies(allStrategies, second)

  return {
    name: matched.name,
    resolvedName,
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
