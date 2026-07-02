import type { LockfileReader } from './index.js'
import fs from 'node:fs'
import path from 'node:path'
import {
  cleanValue,
  isRegistryVersion,
  splitPkgSpec,
  stripPeerSuffix,
  trimQuotes,
} from './parse-helpers.js'

const RE_WS = /\s/

/**
 * Block-based `yarn.lock` parser handling both classic v1 and Berry v2+
 * in one code path, ported from opensrc's `core/version.rs`
 * (vercel-labs/opensrc#51). Replaces the previous regex-based parser,
 * whose multi-specifier headers only matched the first specifier:
 *
 *     v1:    "foo@^1.0.0", "foo@~1.2.0":
 *     Berry: "foo@npm:^1.0.0, foo@workspace:*":
 *
 * Blocks are separated by blank lines. For each block whose header
 * mentions `pkg` in ANY specifier, the nearest `version` line in the
 * body wins — unless it is a workspace sentinel (`0.0.0-use.local`) or
 * protocol string (`file:...`), in which case later blocks may still
 * provide a real version.
 */
export function parseYarnLock(text: string, pkg: string): string | null {
  const blocks: string[][] = []
  let current: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.trim().length === 0) {
      if (current.length > 0) {
        blocks.push(current)
        current = []
      }
    }
    else {
      current.push(line)
    }
  }
  if (current.length > 0)
    blocks.push(current)

  for (const block of blocks) {
    let header: string | null = null
    const body: string[] = []

    for (const line of block) {
      if (line.trimStart().startsWith('#'))
        continue
      if (header === null && !RE_WS.test(line[0]))
        header = line
      else
        body.push(line)
    }

    if (header === null)
      continue
    if (header.startsWith('__metadata:'))
      continue
    if (!header.endsWith(':'))
      continue
    const headerBody = header.slice(0, -1)

    // Splitting on `, ` covers both:
    //   v1:    "foo@^1.0.0", "foo@~1.2.0":
    //   Berry: "foo@npm:^1.0.0, foo@workspace:*":
    // In the Berry case, the first split part keeps a leading `"` and the
    // last keeps a trailing `"`; `trimQuotes` strips either form.
    const matched = headerBody.split(', ').some((s) => {
      const spec = trimQuotes(s.trim())
      const split = splitPkgSpec(spec)
      return split !== null && split[0] === pkg
    })

    if (!matched)
      continue

    for (const line of body) {
      const trimmed = line.trimStart()
      if (!trimmed.startsWith('version'))
        continue
      let rest = trimmed.slice('version'.length)
      // Must be followed by `:` (Berry) or whitespace (v1) to be the
      // version key — not e.g. `versions:`.
      const next = rest[0]
      if (next !== ':' && next !== ' ' && next !== '\t')
        continue
      rest = rest.trimStart()
      if (rest.startsWith(':'))
        rest = rest.slice(1)
      const stripped = stripPeerSuffix(cleanValue(rest))
      // Skip workspace sentinels (`0.0.0-use.local`) and protocol
      // strings (`workspace:.`, `portal:.`, etc.) so the caller gets
      // `null` rather than an unfetchable "version". If another block
      // later in the file has a real version, we'll find it there.
      if (isRegistryVersion(stripped))
        return stripped
    }
  }

  return null
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
    const version = parseYarnLock(content, name)
    return version ? { version, source: 'yarn.lock', exact: true } : null
  },
}
