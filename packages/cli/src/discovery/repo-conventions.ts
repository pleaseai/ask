import type { DocFile } from '../sources/index.js'
import type { DiscoveryResult, RepoDiscoveryAdapter } from './types.js'
import fs from 'node:fs'
import path from 'node:path'
import { REPO_CONVENTIONS } from './conventions.js'
import { scoreDirectory } from './quality.js'

/** Module-scope regex — reused across every file visited by the walker. */
const DOC_EXT_RE = /\.(?:mdx?|txt|rst)$/i

/**
 * Adapter: `repo-conventions` — scans a downloaded GitHub repo archive
 * for the first conventional docs directory whose quality score passes
 * the threshold.
 *
 * This runs after an ecosystem resolver produces a repo + ref and the
 * github source extracts the tarball into `repoDir`. The adapter is
 * purely a directory selector + walker; the file contents it returns
 * then flow through the existing `docs` pipeline
 * (`saveDocs` → `.claude/skills` → `AGENTS.md`).
 *
 * Order is top-to-bottom through `REPO_CONVENTIONS` — the first passing
 * candidate wins. Using "first-passing" (rather than "best-scored")
 * keeps the order in `conventions.ts` as the single lever for tuning
 * priority, and avoids subtle cases where a noisy `docs/` beats a
 * curated `src/content/docs/` on raw byte count.
 */
export const repoConventionsAdapter: RepoDiscoveryAdapter = async (opts) => {
  const { repoDir, resolvedVersion } = opts

  if (!fs.existsSync(repoDir)) {
    return null
  }

  for (const convention of REPO_CONVENTIONS) {
    const candidate = path.join(repoDir, convention)
    if (!fs.existsSync(candidate)) {
      continue
    }
    const score = scoreDirectory(candidate)
    if (!score.passes) {
      continue
    }
    const files = collectDocFiles(candidate, candidate)
    if (files.length === 0) {
      continue
    }
    const result: DiscoveryResult = {
      kind: 'docs',
      adapter: 'repo-conventions',
      files,
      resolvedVersion,
      docsPath: convention,
      quality: score,
    }
    return result
  }

  return null
}

/**
 * Walk `currentDir` recursively collecting markdown / text / rst files.
 * The excluded-filename filter is intentionally NOT applied here — the
 * quality score in `scoreDirectory` already decided the candidate was
 * good enough, and by the time we are copying we want the user to get
 * everything under the selected root (including meta files inside
 * `docs/`, which are often legitimate content).
 */
function collectDocFiles(baseDir: string, currentDir: string): DocFile[] {
  const files: DocFile[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true })
  }
  catch {
    return files
  }
  for (const entry of entries) {
    const full = path.join(currentDir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectDocFiles(baseDir, full))
      continue
    }
    if (!entry.isFile()) {
      continue
    }
    if (!DOC_EXT_RE.test(entry.name)) {
      continue
    }
    try {
      const content = fs.readFileSync(full, 'utf-8')
      files.push({ path: path.relative(baseDir, full), content })
    }
    catch {
      // Unreadable file — skip; the remaining files still give a usable
      // result.
    }
  }
  return files
}
