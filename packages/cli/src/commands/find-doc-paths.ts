import fs from 'node:fs'
import path from 'node:path'

/** Module-scope regex — reused across every directory visited by the walker. */
const DOC_DIR_RE = /doc/i

/** Skip set — directories that are never useful for docs discovery. */
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
 * Walk `root` and return:
 *   - The root itself as the first element (always, even if empty/missing).
 *   - Every subdirectory whose basename matches `/doc/i`, up to depth 4.
 *
 * Skips `node_modules`, `.git`, `.next`, `.nuxt`, `dist`, `build`,
 * `coverage`, and any dotdir.
 *
 * Used by `ask docs` to surface candidate documentation paths from a
 * cached source tree (and from `node_modules/<pkg>/` for npm specs).
 * The caller — typically a coding agent — decides which path is the
 * "real" docs directory by reading the contents.
 *
 * Returns an empty array when `root` does not exist (no throw). This
 * matches the calling convention of `ask docs`, which may want to walk
 * a node_modules path that does not exist for the current project.
 */
export function findDocLikePaths(root: string): string[] {
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
    if (DOC_DIR_RE.test(entry.name)) {
      out.push(full)
    }
    walk(full, depth + 1, out)
  }
}
