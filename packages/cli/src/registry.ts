import fs from 'node:fs'
import path from 'node:path'
import { consola } from 'consola'
import { expandStrategies } from './registry-schema.js'

const REGISTRY_BASE_URL = 'https://ask-registry.pages.dev'

export interface RegistryStrategy {
  source: 'npm' | 'github' | 'web' | 'llms-txt'
  package?: string
  repo?: string
  branch?: string
  tag?: string
  docsPath?: string
  urls?: string[]
  url?: string
  maxDepth?: number
  allowedPathPrefix?: string
}

export interface RegistryEntry {
  name: string
  ecosystem: string
  description: string
  repo?: string
  homepage?: string
  license?: string
  docsPath?: string
  strategies: RegistryStrategy[]
  tags?: string[]
}

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
 */
export async function fetchRegistryEntry(
  ecosystem: string,
  name: string,
): Promise<RegistryEntry | null> {
  const url = `${REGISTRY_BASE_URL}/api/registry/${ecosystem}/${name}`

  try {
    const response = await fetch(url)
    if (!response.ok) {
      return null
    }
    const data = await response.json() as RegistryEntry
    return data
  }
  catch (error) {
    consola.debug(`Registry lookup failed for ${ecosystem}/${name}:`, error)
    return null
  }
}

/**
 * Source type priority for selecting the best strategy from a registry entry.
 *
 * Lower number = higher priority. Based on Nuxt UI eval results (2026-04-07):
 * GitHub docs achieved 100% pass rate at lowest cost, while llms.txt scored
 * below baseline. See evals/nuxt-ui/README.md for full methodology.
 */
const SOURCE_PRIORITY: Record<RegistryStrategy['source'], number> = {
  'github': 0,
  'npm': 1,
  'web': 2,
  'llms-txt': 3,
}

/**
 * Pick the highest-priority strategy from a list, preserving the original
 * order for ties (stable sort).
 */
export function selectBestStrategy(strategies: RegistryStrategy[]): RegistryStrategy {
  if (strategies.length === 0) {
    throw new Error('selectBestStrategy requires at least one strategy')
  }
  // Stable sort by priority — lower priority value wins
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

  const strategy = selectBestStrategy(strategies)
  consola.info(`Using source: ${strategy.source}`)

  return {
    ecosystem,
    name: entry.name,
    version,
    strategy,
  }
}
