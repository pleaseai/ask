import type { LockfileReader } from './index.js'
import fs from 'node:fs'
import path from 'node:path'
import { isRegistryVersion } from './parse-helpers.js'

/**
 * Parse `package.json` for a dependency range. The returned version is
 * NOT exact — callers receive `exact: false` so the install orchestrator
 * can decide whether to ask the resolver to normalize the range or to
 * skip with a warning.
 *
 * Entries that aren't real registry ranges (e.g. `workspace:*`,
 * `link:../pkg`, `file:./tarball.tgz`, `git+https://...`) are skipped so
 * the caller isn't handed a string that can't be resolved against npm.
 */
function parse(content: string, name: string): string | null {
  try {
    const json = JSON.parse(content) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    const value = (
      json.dependencies?.[name]
      ?? json.devDependencies?.[name]
      ?? json.peerDependencies?.[name]
      ?? json.optionalDependencies?.[name]
      ?? null
    )
    return value !== null && isRegistryVersion(value) ? value : null
  }
  catch {
    return null
  }
}

export const packageJsonReader: LockfileReader = {
  file: 'package.json',
  exact: false,
  read(name, projectDir) {
    const filePath = path.join(projectDir, 'package.json')
    let content: string
    try {
      content = fs.readFileSync(filePath, 'utf8')
    }
    catch {
      return null
    }
    const version = parse(content, name)
    return version ? { version, source: 'package.json', exact: false } : null
  },
}
