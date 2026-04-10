import type { LockfileReader } from './index.js'
import fs from 'node:fs'
import path from 'node:path'

const RE_REGEX_META = /[.*+?^${}()|[\]\\]/g
function escapeRegex(input: string): string {
  return input.replace(RE_REGEX_META, '\\$&')
}

/**
 * Parse a `bun.lock` file to find the installed version of `name`.
 *
 * bun.lock is a text-based TOML-ish format. Dependencies appear as:
 *
 *     "next@15.0.3": { ... }
 *     "next": ["next@15.0.3", ...],
 *
 * We look for a quoted `"<name>@<version>"` token. Scoped names are
 * handled by escaping `name` literally and requiring `@<version>`
 * after it (the LAST `@` separator inside the token).
 */
function parse(content: string, name: string): string | null {
  const escaped = escapeRegex(name)
  const re = new RegExp(`"${escaped}@([^"@][^"]*)"`)
  const match = content.match(re)
  return match ? match[1]! : null
}

export const bunLockReader: LockfileReader = {
  file: 'bun.lock',
  exact: true,
  read(name, projectDir) {
    const filePath = path.join(projectDir, 'bun.lock')
    let content: string
    try {
      content = fs.readFileSync(filePath, 'utf8')
    }
    catch {
      return null
    }
    const version = parse(content, name)
    return version ? { version, source: 'bun.lock', exact: true } : null
  },
}
