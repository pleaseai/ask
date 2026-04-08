import type { RegistryEntry, RegistryStrategy } from '@pleaseai/ask-schema'
import fs from 'node:fs'
import path from 'node:path'
import { expandStrategies } from '@pleaseai/ask-schema'
import { consola } from 'consola'

export type { ExpandInput, RegistryAlias, RegistryEntry, RegistryStrategy } from '@pleaseai/ask-schema'
export { expandStrategies } from '@pleaseai/ask-schema'

const REGISTRY_BASE_URL = 'https://ask-registry.pages.dev'

/**
 * Parse ecosystem prefix from spec.
 * "npm:next@canary" -> { ecosystem: "npm", spec: "next@canary" }
 * "next@canary" -> { ecosystem: undefined, spec: "next@canary" }
 */
export function parseEcosystem(input: string): { ecosystem: string | undefined, spec: string } {
  const colonIdx = input.indexOf(':')
  if (colonIdx > 0 && !input.includes('/')) {
    return {
      ecosystem: input.substring(0, colonIdx),
      spec: input.substring(colonIdx + 1),
    }
  }
  return { ecosystem: undefined, spec: input }
}

/**
 * Parsed identifier passed to `ask docs add`.
 *
 * Three shapes are supported:
 *   - `owner/repo[@ref]`        → github fast-path (no registry lookup)
 *   - `ecosystem:name[@version]` → registry lookup with explicit ecosystem
 *   - `name[@version]`          → registry lookup with auto-detected ecosystem
 */
export type ParsedDocSpec
  = | { kind: 'github', owner: string, repo: string, ref?: string }
    | { kind: 'ecosystem', ecosystem: string, name: string, version: string }
    | { kind: 'name', name: string, version: string }

function splitNameVersion(spec: string): { name: string, version: string } {
  const lastAt = spec.lastIndexOf('@')
  if (lastAt > 0) {
    return {
      name: spec.substring(0, lastAt),
      version: spec.substring(lastAt + 1),
    }
  }
  return { name: spec, version: 'latest' }
}

/**
 * Parse a `docs add` identifier into a discriminated union.
 *
 * Disambiguation rules (checked in order):
 *   1. Contains `/` and no `:` → github (`owner/repo[@ref]`).
 *      Exactly one slash is required; more is an error. Empty owner or repo
 *      is also an error.
 *   2. Contains `:` (with non-empty prefix) → ecosystem (`prefix:name[@version]`).
 *   3. Otherwise → bare name (`name[@version]`).
 *
 * @throws Error when input is empty or has malformed `owner/repo` shape.
 */
export function parseDocSpec(input: string): ParsedDocSpec {
  if (!input) {
    throw new Error('docs spec is empty — expected `owner/repo`, `ecosystem:name`, or `name`')
  }

  // 1. github shape: owner/repo[@ref]
  // Strict: must contain `/` AND no `:`. The `:` exclusion prevents
  // scoped ecosystem specs (e.g. `npm:@scope/pkg@1.0`) from being
  // mis-parsed as github — they contain a slash but the colon prefix
  // means they belong to the ecosystem branch.
  if (input.includes('/') && !input.includes(':')) {
    const parts = input.split('/')
    if (parts.length !== 2) {
      throw new Error(
        `invalid docs spec '${input}': github shorthand must contain exactly one slash (owner/repo)`,
      )
    }
    const [owner, repoAndRef] = parts
    if (!owner) {
      throw new Error(`invalid docs spec '${input}': owner segment is empty`)
    }
    if (!repoAndRef) {
      throw new Error(`invalid docs spec '${input}': repo segment is empty`)
    }
    const atIdx = repoAndRef.indexOf('@')
    if (atIdx >= 0) {
      const repo = repoAndRef.substring(0, atIdx)
      const ref = repoAndRef.substring(atIdx + 1)
      if (!repo) {
        throw new Error(`invalid docs spec '${input}': repo segment is empty`)
      }
      return ref ? { kind: 'github', owner, repo, ref } : { kind: 'github', owner, repo }
    }
    return { kind: 'github', owner, repo: repoAndRef }
  }

  // 2. ecosystem shape: prefix:name[@version]
  const colonIdx = input.indexOf(':')
  if (colonIdx > 0) {
    const ecosystem = input.substring(0, colonIdx)
    const rest = input.substring(colonIdx + 1)
    const { name, version } = splitNameVersion(rest)
    return { kind: 'ecosystem', ecosystem, name, version }
  }

  // 3. bare name: name[@version]
  const { name, version } = splitNameVersion(input)
  return { kind: 'name', name, version }
}

/**
 * Detect ecosystem from project files in cwd.
 */
function detectEcosystem(projectDir: string): string {
  const checks: [string, string][] = [
    ['package.json', 'npm'],
    ['pubspec.yaml', 'pub'],
    ['pyproject.toml', 'pypi'],
    ['requirements.txt', 'pypi'],
    ['go.mod', 'go'],
    ['Cargo.toml', 'crates'],
    ['mix.exs', 'hex'],
    ['pom.xml', 'maven'],
    ['build.gradle', 'maven'],
    ['build.gradle.kts', 'maven'],
  ]

  for (const [file, ecosystem] of checks) {
    if (fs.existsSync(path.join(projectDir, file))) {
      return ecosystem
    }
  }

  return 'npm'
}

/**
 * Fetch registry entry from the registry API.
 *
 * Accepts either `(owner, repo)` for direct lookup or `(ecosystem, name)`
 * for alias-based lookup — the API handles both patterns via catch-all slug.
 */
export async function fetchRegistryEntry(
  first: string,
  second: string,
): Promise<RegistryEntry | null> {
  const url = `${REGISTRY_BASE_URL}/api/registry/${first}/${second}`

  try {
    const response = await fetch(url)
    if (!response.ok) {
      return null
    }
    const data = await response.json() as RegistryEntry
    return data
  }
  catch (error) {
    consola.debug(`Registry lookup failed for ${first}/${second}:`, error)
    return null
  }
}

/**
 * Source type priority for selecting the best strategy from a registry entry.
 *
 * Lower number = higher priority. Based on Nuxt UI eval results (2026-04-07):
 * GitHub docs achieved 100% pass rate at lowest cost, while llms.txt scored
 * below baseline. See evals/nuxt-ui/README.md for full methodology.
 *
 * Note: an explicit `npm` strategy carrying a `docsPath` overrides this table
 * — see `selectBestStrategy` for the rationale. The base table only matters
 * for tie-break and for npm strategies *without* an explicit docsPath.
 */
const SOURCE_PRIORITY: Record<RegistryStrategy['source'], number> = {
  'github': 0,
  'npm': 1,
  'web': 2,
  'llms-txt': 3,
}

/**
 * An npm strategy that explicitly declares a `docsPath` is treated as
 * author-curated (e.g. `vercel/ai`'s `dist/docs`). It outranks every other
 * strategy in the same entry. Without `docsPath` we fall back to the static
 * SOURCE_PRIORITY table — npm without curation is no better than github.
 */
function isCuratedNpm(strategy: RegistryStrategy): boolean {
  return strategy.source === 'npm' && Boolean(strategy.docsPath)
}

export interface SelectStrategyContext {
  /**
   * The npm package the user actually asked for. Used to disambiguate
   * registry entries that hold multiple npm strategies (one per scoped
   * package in a monorepo) — e.g. `mastra-ai/mastra` declares both
   * `@mastra/core` and `@mastra/memory`. When this is set, the curated
   * npm strategy whose `package` matches wins; without it, the first
   * curated npm in declaration order wins.
   */
  requestedPackage?: string
}

/**
 * Pick the highest-priority strategy from a list, preserving the original
 * order for ties (stable sort).
 *
 * Selection rules (in order):
 *   1. If `ctx.requestedPackage` is set AND any curated npm strategy has a
 *      matching `package` field, pick that strategy. This is the monorepo
 *      disambiguation rule.
 *   2. Otherwise, if any strategy is a "curated npm" (`source: npm` with
 *      `docsPath`), pick the first one in declaration order — author
 *      intent overrides.
 *   3. Otherwise, sort by SOURCE_PRIORITY (github > npm > web > llms-txt)
 *      preserving original order on ties.
 */
export function selectBestStrategy(
  strategies: RegistryStrategy[],
  ctx: SelectStrategyContext = {},
): RegistryStrategy {
  if (strategies.length === 0) {
    throw new Error('selectBestStrategy requires at least one strategy')
  }
  // Rule 1: monorepo disambiguation — match the requested package name
  if (ctx.requestedPackage) {
    const matchingCurated = strategies.find(
      s => isCuratedNpm(s) && s.package === ctx.requestedPackage,
    )
    if (matchingCurated) {
      return matchingCurated
    }
  }
  // Rule 2: curated npm wins outright (first in declaration order)
  const curated = strategies.find(isCuratedNpm)
  if (curated) {
    return curated
  }
  // Rule 3: stable sort by static priority
  const indexed = Array.from(strategies, (s, i) => ({ s, i }))
  indexed.sort((a, b) => {
    const pa = SOURCE_PRIORITY[a.s.source] ?? 99
    const pb = SOURCE_PRIORITY[b.s.source] ?? 99
    if (pa !== pb)
      return pa - pb
    return a.i - b.i
  })
  return indexed[0].s
}

/**
 * Resolve source config from registry.
 * Returns the highest-priority strategy from the registry entry.
 */
export async function resolveFromRegistry(
  input: string,
  projectDir: string,
): Promise<{ ecosystem: string, name: string, version: string, strategy: RegistryStrategy } | null> {
  const { ecosystem: explicitEcosystem, spec } = parseEcosystem(input)

  const lastAt = spec.lastIndexOf('@')
  const name = lastAt > 0 ? spec.substring(0, lastAt) : spec
  const version = lastAt > 0 ? spec.substring(lastAt + 1) : 'latest'

  const ecosystem = explicitEcosystem ?? detectEcosystem(projectDir)

  consola.info(`Looking up ${ecosystem}:${name} in registry...`)

  const entry = await fetchRegistryEntry(ecosystem, name)
  if (!entry) {
    return null
  }

  let strategies: RegistryStrategy[]
  try {
    strategies = expandStrategies({
      repo: entry.repo,
      docsPath: entry.docsPath,
      strategies: entry.strategies,
    })
  }
  catch (error) {
    consola.warn(`Registry entry for ${name} is misconfigured: ${(error as Error).message}`)
    return null
  }

  consola.success(`Found ${entry.name} in registry: ${entry.description}`)

  const strategy = selectBestStrategy(strategies, { requestedPackage: name })
  consola.info(`Using source: ${strategy.source}`)

  // For monorepo entries that hold multiple scoped packages, prefer the
  // requested package name over the entry's display name. Otherwise both
  // `@mastra/core` and `@mastra/memory` would be saved under the same
  // `Mastra` slug and overwrite each other on disk. Scoped names are
  // normalized to a filesystem-safe slug because they end up as both
  // a directory name (`.ask/docs/<slug>@<ver>/`) and a Claude Code skill
  // name (which forbids `/` and `@`).
  const isMonorepoEntry = (entry.strategies?.filter(s => s.source === 'npm').length ?? 0) > 1
  const resolvedName = isMonorepoEntry ? slugifyPackageName(name) : entry.name

  return {
    ecosystem,
    name: resolvedName,
    version,
    strategy,
  }
}

/**
 * Convert an npm package name into a filesystem- and skill-name-safe slug.
 *
 * Examples:
 *   - `@mastra/core`     → `mastra-core`
 *   - `@scope/pkg-name`  → `scope-pkg-name`
 *   - `lodash`           → `lodash`
 *   - `next`             → `next`
 *
 * The Claude Code skill `name:` field allows `[a-z0-9-]+` only — `@` and
 * `/` are both invalid. Storage paths also become awkward when nested
 * (`.ask/docs/@scope/pkg@version/` would create a stray `.ask/docs/@scope/`
 * directory). One slug normalization handles both surfaces.
 */
export function slugifyPackageName(pkg: string): string {
  if (pkg.startsWith('@')) {
    // `@scope/pkg` → `scope-pkg`
    return pkg.slice(1).replace('/', '-')
  }
  return pkg
}
