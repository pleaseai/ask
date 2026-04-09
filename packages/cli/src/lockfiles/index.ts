/**
 * Lockfile readers — translate a dependency name into the version
 * actually pinned by the project's package manager. Each reader is a
 * pure, stateless function over the filesystem and can be unit-tested
 * with programmatic fixtures.
 *
 * The npm-ecosystem facade probes lockfiles in priority order:
 *
 *   bun.lock → package-lock.json → pnpm-lock.yaml → yarn.lock → package.json
 *
 * The first hit wins. The `package.json` fallback returns a range
 * rather than an exact version (`exact: false`), so callers can decide
 * whether to ask a resolver to normalize it.
 */

import { bunLockReader } from './bun.js'
import { npmLockReader } from './npm.js'
import { packageJsonReader } from './package-json.js'
import { pnpmLockReader } from './pnpm.js'
import { yarnLockReader } from './yarn.js'

export interface LockfileHit {
  /** The resolved version (exact pin if `exact=true`, range otherwise). */
  version: string
  /** Provenance label, e.g. `'bun.lock'`, `'package.json'`. */
  source: string
  /** True when read from a lockfile, false when read from a manifest range. */
  exact: boolean
}

/**
 * Per-format reader contract. Implementations probe a single lockfile
 * (or manifest) and return null when the file is missing or the package
 * is absent.
 */
export interface LockfileReader {
  /** Filename this reader inspects, relative to `projectDir`. */
  file: string
  /** Whether hits from this reader are exact pins. */
  exact: boolean
  read: (name: string, projectDir: string) => LockfileHit | null
}

/**
 * The npm-ecosystem chain in priority order. Exported so tests can
 * inject a custom chain if needed.
 */
export const npmEcosystemChain: readonly LockfileReader[] = [
  bunLockReader,
  npmLockReader,
  pnpmLockReader,
  yarnLockReader,
  packageJsonReader,
]

/**
 * Combined reader that probes the npm-ecosystem chain in order. Returns
 * the first hit, or null if every reader misses.
 */
export const npmEcosystemReader: LockfileReader = {
  file: '<npm-ecosystem>',
  exact: false,
  read(name, projectDir) {
    for (const reader of npmEcosystemChain) {
      const hit = reader.read(name, projectDir)
      if (hit) {
        return hit
      }
    }
    return null
  },
}

// ---------------------------------------------------------------------------
// Legacy compatibility shims
//
// The pre-refactor API exposed `getReader(eco)` returning a class with
// `readInstalledVersion(name, projectDir)`. Until the legacy `addCmd` and
// its `runManifestGate` are deleted in Phase E, we keep that surface
// alive as a thin adapter over `npmEcosystemReader`.
// ---------------------------------------------------------------------------

export type ManifestHit = LockfileHit
export interface ManifestReader {
  readInstalledVersion: (name: string, projectDir: string) => ManifestHit | null
}

const npmManifestAdapter: ManifestReader = {
  readInstalledVersion(name, projectDir) {
    return npmEcosystemReader.read(name, projectDir)
  },
}

export function getReader(ecosystem: string): ManifestReader | undefined {
  switch (ecosystem) {
    case 'npm':
      return npmManifestAdapter
    default:
      return undefined
  }
}

export {
  bunLockReader,
  npmLockReader,
  packageJsonReader,
  pnpmLockReader,
  yarnLockReader,
}
