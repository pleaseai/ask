import type { DiscoveryResult, LocalDiscoveryAdapter } from './types.js'
import fs from 'node:fs'
import path from 'node:path'
import { NpmSource } from '../sources/npm.js'

interface PackageJsonWithAsk {
  version?: string
  ask?: {
    docsPath?: string
  }
}

/**
 * Adapter: `local-ask` — library author opt-in via
 * `package.json.ask.docsPath`.
 *
 * This is the highest-priority local adapter. If the installed package
 * explicitly declares a docs path in its own manifest, we trust it
 * regardless of whether the path matches one of the conventions, and
 * regardless of whether the package also has `tanstack-intent` in its
 * keywords. Authors can always override the scan this way.
 *
 * The actual file read delegates to `NpmSource.tryLocalRead`, which
 * already enforces the version match, the path traversal guard, and the
 * symlink realpath check.
 */
export const localAskAdapter: LocalDiscoveryAdapter = async (opts) => {
  const { projectDir, pkg, requestedVersion } = opts

  const pkgJsonPath = path.join(projectDir, 'node_modules', pkg, 'package.json')
  if (!fs.existsSync(pkgJsonPath)) {
    return null
  }

  let meta: PackageJsonWithAsk
  try {
    meta = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as PackageJsonWithAsk
  }
  catch {
    return null
  }

  const docsPath = meta.ask?.docsPath
  if (!docsPath) {
    return null
  }

  const local = new NpmSource().tryLocalRead({
    projectDir,
    pkg,
    requestedVersion,
    docsPath,
  })
  if (!local) {
    return null
  }

  const result: DiscoveryResult = {
    kind: 'docs',
    adapter: 'local-ask',
    files: local.files,
    resolvedVersion: local.resolvedVersion,
    installPath: local.meta?.installPath,
    docsPath,
  }
  return result
}
