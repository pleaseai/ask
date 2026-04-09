import type { LockfileReader } from './index.js'
import fs from 'node:fs'
import path from 'node:path'

const RE_REGEX_META = /[.*+?^${}()|[\]\\]/g
function escapeRegex(input: string): string {
  return input.replace(RE_REGEX_META, '\\$&')
}

/**
 * Parse a `yarn.lock` file (Yarn classic v1 format).
 *
 * Entries look like:
 *
 *     "next@^15.0.0", next@15.0.3:
 *       version "15.0.3"
 *
 * Locate an entry header that mentions this package, then capture the
 * nearest following `version "<ver>"` within the block.
 */
function parse(content: string, name: string): string | null {
  const escaped = escapeRegex(name)
  const re = new RegExp(
    `(?:^|[",\\s])${escaped}@[^\\n]*:\\s*\\n(?:\\s+[^\\n]*\\n)*?\\s+version\\s+"([^"]+)"`,
    'm',
  )
  const match = content.match(re)
  return match ? match[1]! : null
}

export const yarnLockReader: LockfileReader = {
  file: 'yarn.lock',
  exact: true,
  read(name, projectDir) {
    const filePath = path.join(projectDir, 'yarn.lock')
    let content: string
    try {
      content = fs.readFileSync(filePath, 'utf8')
    }
    catch {
      return null
    }
    const version = parse(content, name)
    return version ? { version, source: 'yarn.lock', exact: true } : null
  },
}
