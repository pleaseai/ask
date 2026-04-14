import fs from 'node:fs'
import path from 'node:path'

/** Module-scope regex — reused across every directory visited by the walker. */
const SKILL_DIR_RE = /skill/i

/** Skip set — mirrors `findDocLikePaths`. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.nuxt',
  'dist',
  'build',
  'coverage',
])

/** Maximum walk depth. Root counts as depth 0. */
const MAX_DEPTH = 4

/**
 * Walk `root` and return the root plus every nested directory whose basename
 * matches `/skill/i`, up to depth 4. Mirrors `findDocLikePaths` with a
 * different regex — used by `ask skills` to surface producer-side skill
 * directories shipped by libraries (e.g. `skills/<skill-name>/SKILL.md`).
 *
 * Returns an empty array when `root` does not exist (no throw).
 */
export function findSkillLikePaths(root: string): string[] {
  if (!fs.existsSync(root)) {
    return []
  }
  const results: string[] = [root]
  walk(root, 0, results)
  return results
}

function walk(currentDir: string, depth: number, out: string[]): void {
  if (depth >= MAX_DEPTH) {
    return
  }
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true })
  }
  catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) {
      continue
    }
    const full = path.join(currentDir, entry.name)
    if (SKILL_DIR_RE.test(entry.name)) {
      out.push(full)
    }
    walk(full, depth + 1, out)
  }
}
