import type { LockfileReader } from './index.js'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Parse a `package-lock.json` (npm v2/v3 format).
 *
 * Looks under `packages["node_modules/<name>"].version` first
 * (lockfileVersion 2+), then under `dependencies.<name>.version` (v1).
 */
function parse(content: string, name: string): string | null {
  try {
    const json = JSON.parse(content) as {
      packages?: Record<string, { version?: string }>
      dependencies?: Record<string, { version?: string }>
    }
    const pkgKey = `node_modules/${name}`
    const fromPackages = json.packages?.[pkgKey]?.version
    if (fromPackages)
      return fromPackages
    const fromDeps = json.dependencies?.[name]?.version
    if (fromDeps)
      return fromDeps
    return null
  }
  catch {
    return null
  }
}

export const npmLockReader: LockfileReader = {
  file: 'package-lock.json',
  exact: true,
  read(name, projectDir) {
    const filePath = path.join(projectDir, 'package-lock.json')
    let content: string
    try {
      content = fs.readFileSync(filePath, 'utf8')
    }
    catch {
      return null
    }
    const version = parse(content, name)
    return version ? { version, source: 'package-lock.json', exact: true } : null
  },
}
