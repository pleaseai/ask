import type { QualityScore } from './types.js'
import fs from 'node:fs'
import path from 'node:path'
import { isExcludedFilename, MAX_WALK_DEPTH } from './conventions.js'

/** Minimum markdown file count OR byte total required to pass the filter. */
const MIN_FILES = 3
const MIN_BYTES = 4 * 1024

/** Module-scope regex so the pattern is not recompiled on every file entry. */
const MARKDOWN_EXT_RE = /\.mdx?$/i

/**
 * Score a candidate docs directory by walking it recursively and counting
 * all markdown files that are not in the exclusion list. Returns
 * `{ passes: true }` when either the count or byte threshold is satisfied,
 * and `false` otherwise — callers use this to drop noise-only candidates
 * (see SC-3: a repo containing only `CONTRIBUTING.md` + `CHANGELOG.md`
 * must not be misclassified as having docs).
 *
 * The walker tolerates permission errors and symlink loops by catching
 * around each `readdirSync` call: a partial score is still useful, since
 * the caller only needs to know whether the threshold was crossed.
 */
export function scoreDirectory(dir: string): QualityScore {
  let fileCount = 0
  let totalBytes = 0

  const walk = (current: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH) {
      return
    }
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    }
    catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) {
        continue
      }
      if (!MARKDOWN_EXT_RE.test(entry.name)) {
        continue
      }
      if (isExcludedFilename(entry.name)) {
        continue
      }
      fileCount++
      try {
        totalBytes += fs.statSync(full).size
      }
      catch {
        // Partial count is fine — worst case the threshold check is
        // slightly under-counted and the candidate fails through to the
        // next convention path.
      }
    }
  }

  try {
    const stat = fs.statSync(dir)
    if (!stat.isDirectory()) {
      return { fileCount: 0, totalBytes: 0, passes: false }
    }
  }
  catch {
    return { fileCount: 0, totalBytes: 0, passes: false }
  }

  walk(dir, 0)

  return {
    fileCount,
    totalBytes,
    passes: fileCount >= MIN_FILES || totalBytes >= MIN_BYTES,
  }
}
