import type { RegistrySource } from '@pleaseai/ask-schema'
import fs from 'node:fs'
import path from 'node:path'
import { consola } from 'consola'

export type { RegistryAlias, RegistryEntry, RegistryPackage, RegistrySource } from '@pleaseai/ask-schema'

const REGISTRY_BASE_URL = 'https://ask-registry.pages.dev'

/**
 * Parse ecosystem prefix from spec.
 * "npm:next@canary" -> { ecosystem: "npm", spec: "next@canary" }
 * "next@canary" -> { ecosystem: undefined, spec: "next@canary" }
 */
export function parseEcosystem(input: string): { ecosystem: string | undefined, spec: string } {
  // An ecosystem prefix is anything before the first `:`, as long as that
  // colon appears before any `/`. The `/` guard rules out `owner/repo`
  // shorthand (which has no colon anyway) while still correctly handling
  // scoped npm names like `npm:@mastra/client-js`, where the colon comes
  // before the slash.
  const colonIdx = input.indexOf(':')
  const slashIdx = input.indexOf('/')
  if (colonIdx > 0 && (slashIdx === -1 || colonIdx < slashIdx)) {
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
 * Shape of the registry API response — flattened view of one registry
 * entry focused on a single package.
 *
 * For direct `owner/repo` lookups the server returns the sole package of a
 * single-package entry (and 409s on monorepo entries). For alias lookups
 * the server returns the one package that declared the alias.
 *
 * `resolvedName` is the CLI-facing identifier safe for use as both a
 * directory name and a Claude Code skill name — `@mastra/core` →
 * `mastra-core`. For single-package entries it equals `entry.name`; for
 * monorepo entries it is `slugifyPackageName(package.name)`.
 *
 * `sources` is in the entry author's declared priority order. The CLI
 * uses the head as the primary choice and can walk the remainder as a
 * fallback chain on download failure. See the ADR-0001 decision record.
 */
export interface RegistryApiResponse {
  name: string
  description: string
  repo: string
  homepage?: string
  license?: string
  tags?: string[]
  resolvedName: string
  package: {
    name: string
    description?: string
  }
  sources: RegistrySource[]
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
): Promise<RegistryApiResponse | null> {
  // `second` may contain `/` for scoped npm packages (`@mastra/client-js`).
  // Encode it so the server sees a single catch-all segment instead of
  // splitting the scope into its own segment and rejecting the slug.
  const url = `${REGISTRY_BASE_URL}/api/registry/${encodeURIComponent(first)}/${encodeURIComponent(second)}`

  try {
    const response = await fetch(url)
    if (response.status === 404) {
      return null
    }
    if (!response.ok) {
      // Non-404 errors carry actionable information we must not swallow.
      // The registry server returns 409 Conflict with a `statusMessage`
      // telling the caller to disambiguate a monorepo entry via an
      // ecosystem alias (e.g. `npm:@mastra/core` instead of
      // `mastra-ai/mastra`). Surface it via `consola.warn` so the user
      // sees the guidance; 5xx/other errors get the same treatment so
      // they don't silently degrade to "entry not found".
      const body = await response.json().catch(() => ({})) as { statusMessage?: string }
      const message = body.statusMessage ?? response.statusText
      consola.warn(`Registry lookup for ${first}/${second} returned ${response.status}: ${message}`)
      return null
    }
    const data = await response.json() as RegistryApiResponse
    return data
  }
  catch (error) {
    consola.debug(`Registry lookup failed for ${first}/${second}:`, error)
    return null
  }
}

/**
 * Resolve source config from registry.
 *
 * Returns the first source from the selected package in declaration order.
 * Per ADR-0001, priority is author-decided — the CLI no longer reorders
 * sources client-side. A future enhancement can walk `entry.sources` as a
 * fallback chain when the primary source fails.
 */
export async function resolveFromRegistry(
  input: string,
  projectDir: string,
): Promise<{ ecosystem: string, name: string, version: string, source: RegistrySource } | null> {
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

  const [primary] = entry.sources
  if (!primary) {
    consola.warn(`Registry entry for ${name} has no sources`)
    return null
  }

  consola.success(`Found ${entry.name} in registry: ${entry.description}`)
  consola.info(`Using source: ${primary.type}`)

  return {
    ecosystem,
    name: entry.resolvedName,
    version,
    source: primary,
  }
}
