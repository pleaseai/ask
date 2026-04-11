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
    const kindDir = kind === 'github'
      ? path.join(askHome, 'github', 'checkouts')
      : path.join(askHome, kind)

    if (!fs.existsSync(kindDir))
      continue

    if (kind === 'github') {
      // github checkouts: <owner>__<repo>/<ref>/
      const repoDirs = safeReaddir(kindDir)
      for (const repoDir of repoDirs) {
        const repoPath = path.join(kindDir, repoDir)
        if (!fs.statSync(repoPath).isDirectory())
          continue
        const refs = safeReaddir(repoPath)
        for (const ref of refs) {
          const refPath = path.join(repoPath, ref)
          if (!fs.statSync(refPath).isDirectory())
            continue
          entries.push({
            kind: 'github',
            key: `${repoDir}/${ref}`,
            path: refPath,
            sizeBytes: dirSize(refPath),
          })
        }
      }
    }
    else {
      // npm/web/llms-txt: direct subdirectories
      const subdirs = safeReaddir(kindDir)
      for (const subdir of subdirs) {
        const entryPath = path.join(kindDir, subdir)
        if (!fs.statSync(entryPath).isDirectory())
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
  const scanRoots = options.scanRoots ?? [process.env.HOME ?? '']

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
