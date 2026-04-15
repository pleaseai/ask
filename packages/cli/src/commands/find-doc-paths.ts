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
 * Walk `root` and return every subdirectory whose basename matches
 * `/doc/i`, up to depth 4. When no such subdirectory exists, fall back
 * to `[root]` so small projects whose docs live as a top-level
 * `README.md` still produce a usable path.
 *
 * Skips `node_modules`, `.git`, `.next`, `.nuxt`, `dist`, `build`,
 * `coverage`, and any dotdir.
 *
 * Used by `ask docs` to surface documentation paths from a cached
 * source tree (and from `node_modules/<pkg>/` for npm specs). Emitting
 * only doc-like subdirs when they exist keeps shell substitution
 * (`rg "x" $(ask docs <spec>)`) focused on docs instead of dragging
 * the whole source tree into the search. Callers that need the
 * checkout root itself should use `ask src`.
 *
 * Returns an empty array when `root` does not exist (no throw).
 */
export function findDocLikePaths(root: string): string[] {
  if (!fs.existsSync(root)) {
    return []
  }
  const subdirs: string[] = []

  // `dist/docs` is a common publish-time convention (e.g. mastra ships
  // its docs there). The walker skips `dist/` wholesale to avoid build
  // noise, so probe this path explicitly.
  const distDocs = path.join(root, 'dist', 'docs')
  try {
    if (fs.statSync(distDocs).isDirectory()) {
      subdirs.push(distDocs)
    }
  }
  catch {
    // missing or not a directory — ignore
  }

  walk(root, 0, subdirs)
  return subdirs.length > 0 ? subdirs : [root]
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
