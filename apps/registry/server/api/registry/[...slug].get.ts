import type { RegistryEntry, RegistryPackage, RegistrySource } from '@pleaseai/ask-schema'
import { findPackageByAlias, isMonorepoEntry, slugifyPackageName } from '@pleaseai/ask-schema'

/**
 * Registry lookup endpoint.
 *
 * Implements ADR-0001 (`Entry → Package → Source` hierarchy). Each registry
 * entry documents one repo and one or more packages. Callers can look up
 * either:
 *
 *   1. Direct path: `GET /api/registry/<owner>/<repo>`
 *      - Single-package entries return that package.
 *      - Monorepo entries return `409 Conflict` — the caller must
 *        disambiguate via an ecosystem alias.
 *
 *   2. Alias:       `GET /api/registry/<ecosystem>/<name>`
 *      - Scans all entries for a package whose `aliases` include
 *        `{ ecosystem, name }`. The lookup is unambiguous because the
 *        schema's `superRefine` rejects duplicate aliases across packages
 *        within the same entry. (Cross-entry collisions are possible in
 *        theory but unenforced; the first match wins, which matches the
 *        previous endpoint's behavior.)
 *
 * The response carries a `resolvedName` field that the CLI uses as the
 * directory name (`.ask/docs/<resolvedName>@<ver>/`) and skill name. For
 * single-package entries this is the entry's display `name`; for monorepo
 * entries it is `slugifyPackageName(package.name)` so distinct scoped
 * packages land in distinct directories.
 */

interface RegistryApiResponse {
  /** Entry-level display name (the library as a whole). */
  name: string
  /** Entry-level one-line description. */
  description: string
  /** GitHub `owner/name`. */
  repo: string
  homepage?: string
  license?: string
  tags?: string[]
  /**
   * CLI-facing identifier. Safe for use as a directory name and a Claude
   * Code skill name — `@mastra/core` is slugified to `mastra-core`.
   */
  resolvedName: string
  /** The selected package's canonical metadata. */
  package: {
    name: string
    description?: string
  }
  /**
   * Fetch sources in the entry author's declared priority order. The CLI
   * is expected to try them head-first and walk the list on failure.
   */
  sources: RegistrySource[]
}

function buildResponse(
  entry: RegistryEntry,
  pkg: RegistryPackage,
  resolvedName: string,
): RegistryApiResponse {
  return {
    name: entry.name,
    description: entry.description,
    repo: entry.repo,
    homepage: entry.homepage,
    license: entry.license,
    tags: entry.tags,
    resolvedName,
    package: {
      name: pkg.name,
      description: pkg.description,
    },
    sources: pkg.sources,
  }
}

export default defineEventHandler(async (event): Promise<RegistryApiResponse> => {
  const slug = getRouterParam(event, 'slug')

  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: 'Missing slug' })
  }

  // Decode each segment so callers can URL-encode scoped npm packages
  // (`@mastra/client-js` → `%40mastra%2Fclient-js`) and still land on a
  // two-segment slug here. Nitro decodes `%40` but leaves `%2F` in the
  // catch-all param, so we handle the decode ourselves.
  const segments = slug.split('/').map(s => decodeURIComponent(s))
  if (segments.length !== 2) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Slug must be in "owner/repo" or "ecosystem/name" form',
    })
  }

  const [first, second] = segments as [string, string]

  // 1. Direct path lookup (owner/repo). Unambiguous for single-package
  //    entries; a monorepo entry cannot be resolved without a package
  //    selector, so return 409.
  const directPath = `/registry/${first}/${second}`
  // @ts-expect-error — Nuxt Content v3 types expect queryCollection(name)
  // but the runtime accepts queryCollection(event, name). Pre-existing
  // project-wide quirk, not part of this refactor.
  const directEntries = await queryCollection(event, 'registry')
    .where('path', '=', directPath)
    .all()

  if (directEntries.length > 0) {
    const entry = directEntries[0] as unknown as RegistryEntry

    if (isMonorepoEntry(entry)) {
      throw createError({
        statusCode: 409,
        statusMessage: `${first}/${second} documents ${entry.packages.length} packages — look up via an ecosystem alias (e.g. \`npm:<pkg>\`) to disambiguate`,
      })
    }

    const [pkg] = entry.packages
    if (!pkg) {
      throw createError({ statusCode: 500, statusMessage: `Registry entry ${slug} has no packages (schema should have prevented this)` })
    }
    return buildResponse(entry, pkg, entry.name)
  }

  // 2. Alias lookup (ecosystem/name). Intra-entry alias uniqueness is
  //    enforced by the schema's superRefine; we still scan all entries
  //    linearly to find the owning one.
  // @ts-expect-error — see above note on queryCollection signature.
  const allEntries = await queryCollection(event, 'registry').all()

  for (const rawEntry of allEntries) {
    const entry = rawEntry as unknown as RegistryEntry
    if (!entry.packages)
      continue

    const pkg = findPackageByAlias(entry, first as RegistryPackage['aliases'][number]['ecosystem'], second)
    if (pkg) {
      const resolvedName = isMonorepoEntry(entry)
        ? slugifyPackageName(pkg.name)
        : entry.name
      return buildResponse(entry, pkg, resolvedName)
    }
  }

  throw createError({ statusCode: 404, statusMessage: `Entry not found: ${slug}` })
})
