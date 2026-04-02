import fs from 'node:fs'
import path from 'node:path'
import { consola } from 'consola'

const REGISTRY_BASE_URL = 'https://ask-registry.pages.dev'

export interface RegistryStrategy {
  source: 'npm' | 'github' | 'web'
  package?: string
  repo?: string
  branch?: string
  tag?: string
  docsPath?: string
  urls?: string[]
  maxDepth?: number
  allowedPathPrefix?: string
}

export interface RegistryEntry {
  name: string
  ecosystem: string
  description: string
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
  catch {
    return null
  }
}

/**
 * Resolve source config from registry.
 * Returns the first strategy from the registry entry.
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
  if (!entry || entry.strategies.length === 0) {
    return null
  }

  consola.success(`Found ${entry.name} in registry: ${entry.description}`)

  return {
    ecosystem,
    name: entry.name,
    version,
    strategy: entry.strategies[0],
  }
}
