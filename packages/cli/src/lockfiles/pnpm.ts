import type { LockfileReader } from './index.js'
import fs from 'node:fs'
import path from 'node:path'

const RE_REGEX_META = /[.*+?^${}()|[\]\\]/g
function escapeRegex(input: string): string {
  return input.replace(RE_REGEX_META, '\\$&')
}

/**
 * Parse a `pnpm-lock.yaml` file (best-effort, regex-based).
 *
 * pnpm lockfiles are real YAML, but the shape we care about is regular:
 * the `packages:` map is keyed as `'/<name>@<version>'` (or
 * `'/<name>@<version>_peerhash'`), which is the most stable form across
 * pnpm versions.
 *
 * LIMITATION: monorepo importers other than `.` are ignored.
 */
function parse(content: string, name: string): string | null {
  const escaped = escapeRegex(name)
  const re = new RegExp(`^\\s*'?/${escaped}@([^():\\s_]+)`, 'm')
  const match = content.match(re)
  return match ? match[1]! : null
}

export const pnpmLockReader: LockfileReader = {
  file: 'pnpm-lock.yaml',
  exact: true,
  read(name, projectDir) {
    const filePath = path.join(projectDir, 'pnpm-lock.yaml')
    let content: string
    try {
      content = fs.readFileSync(filePath, 'utf8')
    }
    catch {
      return null
    }
    const version = parse(content, name)
    return version ? { version, source: 'pnpm-lock.yaml', exact: true } : null
  },
}
