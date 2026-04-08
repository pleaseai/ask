/**
 * Manifest reader — inspects a project's lockfiles and manifests to find the
 * exact version (or range) of an installed dependency. This is used by the
 * `add` command's "manifest gate" to auto-resolve versions when the user omits
 * one (e.g. `ask docs add npm:next` in a project that has `next` in bun.lock).
 *
 * Readers are stateless pure functions over the filesystem, so they are easy
 * to unit test with programmatic fixtures.
 */

import { NpmManifestReader } from './npm.js'

export interface ManifestHit {
  /** The resolved version string (exact if `exact=true`, a range otherwise). */
  version: string
  /** Human-readable provenance string (e.g. `'bun.lock'`, `'package.json'`). */
  source: string
  /** Whether the version is an exact pin (from a lockfile) or a range. */
  exact: boolean
}

export interface ManifestReader {
  /**
   * Read the installed version of `name` from the project at `projectDir`.
   * Returns `null` if the package is not tracked by any manifest/lockfile.
   */
  readInstalledVersion: (name: string, projectDir: string) => ManifestHit | null
}

/**
 * Return the reader for a given ecosystem. Currently only `npm` is supported;
 * other ecosystems fall through to `undefined` and callers should skip the
 * manifest gate.
 */
const npmReader: ManifestReader = new NpmManifestReader()

export function getReader(ecosystem: string): ManifestReader | undefined {
  switch (ecosystem) {
    case 'npm':
      return npmReader
    default:
      return undefined
  }
}
