import type { DiscoveryResult, LocalDiscoveryAdapter } from './types.js'
import fs from 'node:fs'
import path from 'node:path'
import { consola } from 'consola'
import { NpmSource } from '../sources/npm.js'
import { LOCAL_CONVENTIONS } from './conventions.js'
import { scoreDirectory } from './quality.js'

/**
 * Adapter: `local-conventions` — zero-config scan of an installed
 * package for commonly used docs paths.
 *
 * Walks `LOCAL_CONVENTIONS` in order and keeps the first candidate whose
 * quality score passes the threshold. If nothing passes, falls back to
 * `README.md` with a warning so the user knows discovery did not find
 * richer content (spec: "A README-only fallback emits a warning").
 *
 * File reading is delegated to `NpmSource.tryLocalRead` — it already
 * enforces version match, traversal guards, and symlink realpath checks.
 * The adapter itself only decides *which* `docsPath` to hand in.
 */
export const localConventionsAdapter: LocalDiscoveryAdapter = async (opts) => {
  const { projectDir, pkg, requestedVersion } = opts

  const pkgDir = path.join(projectDir, 'node_modules', pkg)
  if (!fs.existsSync(pkgDir)) {
    return null
  }

  const npmSource = new NpmSource()

  // Stage 1: conventional directories, quality-filtered.
  for (const convention of LOCAL_CONVENTIONS) {
    const candidate = path.join(pkgDir, convention)
    if (!fs.existsSync(candidate)) {
      continue
    }
    const score = scoreDirectory(candidate)
    if (!score.passes) {
      continue
    }
    const local = npmSource.tryLocalRead({
      projectDir,
      pkg,
      requestedVersion,
      docsPath: convention,
    })
    if (!local) {
      continue
    }
    const result: DiscoveryResult = {
      kind: 'docs',
      adapter: 'local-conventions',
      files: local.files,
      resolvedVersion: local.resolvedVersion,
      installPath: local.meta?.installPath,
      docsPath: convention,
      quality: score,
    }
    return result
  }

  // Stage 2: README fallback. Only taken when no convention path had
  // enough content. Emits a warning so callers can surface "discovery
  // found only the README" to the user.
  const readmePath = path.join(pkgDir, 'README.md')
  if (fs.existsSync(readmePath)) {
    const local = npmSource.tryLocalRead({
      projectDir,
      pkg,
      requestedVersion,
      docsPath: 'README.md',
    })
    if (local) {
      consola.warn(
        `  ${pkg}: discovery fell back to README.md (no docs/ or dist/docs/ with sufficient content)`,
      )
      const result: DiscoveryResult = {
        kind: 'docs',
        adapter: 'local-conventions',
        files: local.files,
        resolvedVersion: local.resolvedVersion,
        installPath: local.meta?.installPath,
        docsPath: 'README.md',
      }
      return result
    }
  }

  return null
}
