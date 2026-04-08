import { MavenResolver } from './maven.js'
import { NpmResolver } from './npm.js'
import { PubResolver } from './pub.js'
import { PypiResolver } from './pypi.js'

/**
 * Result of resolving an ecosystem package to a GitHub repository.
 * Always handed off to the github source for download.
 */
export interface ResolveResult {
  /** GitHub `owner/repo` */
  repo: string
  /** Primary git ref to try first (tag or branch) */
  ref: string
  /**
   * Fallback refs to try if the primary ref doesn't exist.
   * Implements FR-5: try `v{version}`, then `{version}`, then default branch.
   */
  fallbackRefs?: string[]
  /** Resolved version string (e.g. `4.17.21`) */
  resolvedVersion: string
}

/**
 * Ecosystem resolver: maps a package name + version to a GitHub repository.
 *
 * Resolvers are orthogonal to sources — they only perform metadata lookups
 * and never download documentation themselves. The resolved `repo` + `ref`
 * are handed to the `github` source for the actual download.
 */
export interface EcosystemResolver {
  resolve: (name: string, version: string) => Promise<ResolveResult>
}

type SupportedEcosystem = 'maven' | 'npm' | 'pypi' | 'pub'

const resolvers: Record<SupportedEcosystem, EcosystemResolver> = {
  maven: new MavenResolver(),
  npm: new NpmResolver(),
  pypi: new PypiResolver(),
  pub: new PubResolver(),
}

/**
 * Return the resolver for the given ecosystem, or `null` if unsupported.
 */
export function getResolver(ecosystem: string): EcosystemResolver | null {
  return (resolvers as Record<string, EcosystemResolver>)[ecosystem] ?? null
}
