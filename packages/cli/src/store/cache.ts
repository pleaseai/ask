import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { consola } from 'consola'

// ── Types ──────────────────────────────────────────────────────────

export interface CacheEntry {
  kind: 'npm' | 'github' | 'web' | 'llms-txt'
  key: string
  path: string
  sizeBytes: number
  /**
   * True when the entry lives in the legacy `github/db` or
   * `github/checkouts` layout. Consumers render these with a
   * `(legacy)` tag so users can spot them without a separate flag.
   */
  legacy?: boolean
}

export interface CacheGcResult {
  removed: CacheEntry[]
  kept: CacheEntry[]
  freedBytes: number
}

// ── cacheLs ────────────────────────────────────────────────────────

/**
 * List all entries in the global store at `askHome`.
 */
export function cacheLs(
  askHome: string,
  filter?: { kind?: CacheEntry['kind'] },
): CacheEntry[] {
  const entries: CacheEntry[] = []

  const kinds = filter?.kind
    ? [filter.kind]
    : ['npm', 'github', 'web', 'llms-txt'] as const

  for (const kind of kinds) {
    if (kind === 'github') {
      // Walk the new nested layout: github/<host>/<owner>/<repo>/<tag>/
      const githubDir = path.join(askHome, 'github')
      if (fs.existsSync(githubDir)) {
        for (const host of safeReaddir(githubDir)) {
          // Skip legacy subdirectories — they're handled separately below
          if (host === 'db' || host === 'checkouts')
            continue
          const hostPath = path.join(githubDir, host)
          if (!safeIsDirectory(hostPath))
            continue
          for (const owner of safeReaddir(hostPath)) {
            const ownerPath = path.join(hostPath, owner)
            if (!safeIsDirectory(ownerPath))
              continue
            for (const repo of safeReaddir(ownerPath)) {
              const repoPath = path.join(ownerPath, repo)
              if (!safeIsDirectory(repoPath))
                continue
              for (const tag of safeReaddir(repoPath)) {
                const tagPath = path.join(repoPath, tag)
                if (!safeIsDirectory(tagPath))
                  continue
                entries.push({
                  kind: 'github',
                  key: `${host}/${owner}/${repo}/${tag}`,
                  path: tagPath,
                  sizeBytes: dirSize(tagPath),
                })
              }
            }
          }
        }
      }

      // Legacy layout: github/checkouts/<owner>__<repo>/<ref>/
      const legacyCheckoutDir = path.join(askHome, 'github', 'checkouts')
      if (fs.existsSync(legacyCheckoutDir)) {
        for (const repoDir of safeReaddir(legacyCheckoutDir)) {
          const repoPath = path.join(legacyCheckoutDir, repoDir)
          if (!safeIsDirectory(repoPath))
            continue
          for (const ref of safeReaddir(repoPath)) {
            const refPath = path.join(repoPath, ref)
            if (!safeIsDirectory(refPath))
              continue
            entries.push({
              kind: 'github',
              key: `(legacy) ${repoDir}/${ref}`,
              path: refPath,
              sizeBytes: dirSize(refPath),
              legacy: true,
            })
          }
        }
      }
    }
    else {
      const kindDir = path.join(askHome, kind)
      if (!fs.existsSync(kindDir))
        continue
      const subdirs = safeReaddir(kindDir)
      for (const subdir of subdirs) {
        const entryPath = path.join(kindDir, subdir)
        if (!safeIsDirectory(entryPath))
          continue
        entries.push({
          kind,
          key: subdir,
          path: entryPath,
          sizeBytes: dirSize(entryPath),
        })
      }
    }
  }

  return entries
}

// ── Legacy detection + cleanup ────────────────────────────────────

/**
 * Paths under `<askHome>` that belong to the pre-store-v2 layout.
 * `github/db` held shared bare clones; `github/checkouts` held the
 * flattened `owner__repo/ref` working trees. Both are superseded by
 * the nested `github/<host>/<owner>/<repo>/<tag>/` layout.
 */
export function legacyLayoutPaths(askHome: string): string[] {
  return [
    path.join(askHome, 'github', 'db'),
    path.join(askHome, 'github', 'checkouts'),
  ]
}

/**
 * True iff any legacy github path exists under `<askHome>`. Used on
 * install start to emit a one-line warning pointing at
 * `ask cache clean --legacy`.
 */
export function detectLegacyLayout(askHome: string): boolean {
  return legacyLayoutPaths(askHome).some(p => fs.existsSync(p))
}

/**
 * Remove all legacy github store paths under `<askHome>`. Idempotent:
 * running against a clean tree is a no-op.
 */
export function cacheCleanLegacy(askHome: string): { removed: string[] } {
  const removed: string[] = []
  for (const p of legacyLayoutPaths(askHome)) {
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true })
      removed.push(p)
    }
  }
  return { removed }
}

function safeIsDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  }
  catch {
    return false
  }
}

// ── cacheGc ────────────────────────────────────────────────────────

const RE_DURATION = /^(\d+)\s*([smhd])$/

/**
 * Parse a duration string like `30d`, `12h`, `90m` into milliseconds.
 * Returns `null` for invalid input.
 */
export function parseDuration(input: string): number | null {
  const match = input.trim().match(RE_DURATION)
  if (!match)
    return null
  const n = Number.parseInt(match[1]!, 10)
  const unit = match[2]
  switch (unit) {
    case 's': return n * 1000
    case 'm': return n * 60 * 1000
    case 'h': return n * 60 * 60 * 1000
    case 'd': return n * 24 * 60 * 60 * 1000
    default: return null
  }
}

/**
 * Remove store entries not referenced by any `.ask/resolved.json`
 * found under `scanRoots`.
 *
 * When `olderThan` (ms) is provided, only entries whose last-modified
 * time is older than `Date.now() - olderThan` are candidates for
 * removal. Entries newer than the threshold are always kept even when
 * unreferenced.
 */
export function cacheGc(
  askHome: string,
  options: {
    dryRun?: boolean
    scanRoots?: string[]
    olderThan?: number
  } = {},
): CacheGcResult {
  const { dryRun = false, olderThan } = options
  const scanRoots = options.scanRoots ?? [process.env.HOME].filter((r): r is string => Boolean(r))

  const referencedPaths = collectReferencedStorePaths(scanRoots, askHome)
  const allEntries = cacheLs(askHome)

  const removed: CacheEntry[] = []
  const kept: CacheEntry[] = []
  let freedBytes = 0

  const cutoffMs = olderThan !== undefined ? Date.now() - olderThan : null

  for (const entry of allEntries) {
    if (referencedPaths.has(entry.path)) {
      kept.push(entry)
      continue
    }
    // Age gate: if --older-than is set, keep entries newer than the cutoff.
    if (cutoffMs !== null) {
      try {
        const mtimeMs = fs.statSync(entry.path).mtimeMs
        if (mtimeMs > cutoffMs) {
          kept.push(entry)
          continue
        }
      }
      catch {
        // Cannot stat → assume stale, fall through to removal
      }
    }
    if (!dryRun) {
      try {
        fs.rmSync(entry.path, { recursive: true, force: true })
        consola.info(`  Removed: ${entry.kind}/${entry.key} (${formatBytes(entry.sizeBytes)})`)
      }
      catch (err) {
        consola.warn(`  Failed to remove ${entry.path}: ${err}`)
        kept.push(entry)
        continue
      }
    }
    removed.push(entry)
    freedBytes += entry.sizeBytes
  }

  return { removed, kept, freedBytes }
}

// ── Helpers ────────────────────────────────────────────────────────

function collectReferencedStorePaths(
  scanRoots: string[],
  askHome: string,
): Set<string> {
  const referenced = new Set<string>()
  const resolvedAskHome = path.resolve(askHome) + path.sep

  for (const root of scanRoots) {
    if (!root || !fs.existsSync(root))
      continue
    findResolvedJsonFiles(root, referenced, resolvedAskHome, 0, 8)
  }

  return referenced
}

function findResolvedJsonFiles(
  dir: string,
  referenced: Set<string>,
  askHomePrefix: string,
  depth: number,
  maxDepth: number,
): void {
  if (depth > maxDepth)
    return

  const resolvedPath = path.join(dir, '.ask', 'resolved.json')
  if (fs.existsSync(resolvedPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'))
      if (data.entries) {
        for (const entry of Object.values(data.entries)) {
          const e = entry as { storePath?: string }
          if (e.storePath) {
            // Only trust storePath values that point inside askHome.
            // Malicious or stale resolved.json files cannot force us
            // to keep entries outside the store.
            const resolvedStorePath = path.resolve(e.storePath)
            if (resolvedStorePath.startsWith(askHomePrefix) || resolvedStorePath + path.sep === askHomePrefix) {
              referenced.add(resolvedStorePath)
            }
          }
        }
      }
    }
    catch {
      // malformed resolved.json, skip
    }
  }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      // entry.isDirectory() returns false for symlinks, so symlinks
      // are naturally excluded from the walk — preventing cycle traps
      // and scope escape via symlinked directories.
      if (!entry.isDirectory())
        continue
      // Skip hidden dirs, node_modules, .git
      if (entry.name.startsWith('.') || entry.name === 'node_modules')
        continue
      findResolvedJsonFiles(
        path.join(dir, entry.name),
        referenced,
        askHomePrefix,
        depth + 1,
        maxDepth,
      )
    }
  }
  catch {
    // permission denied, etc
  }
}

function dirSize(dir: string): number {
  let size = 0
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        size += dirSize(fullPath)
      }
      else {
        size += fs.statSync(fullPath).size
      }
    }
  }
  catch {
    // permission denied, etc
  }
  return size
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  }
  catch {
    return []
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} B`
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
