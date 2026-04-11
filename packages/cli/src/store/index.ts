import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { consola } from 'consola'

// ── ASK_HOME resolution ────────────────────────────────────────────

/**
 * Resolve the global ASK home directory.
 *
 * Precedence (first non-empty wins):
 * 1. `ASK_HOME` environment variable (absolute path, tilde-expanded)
 * 2. `~/.ask/` (default)
 */
export function resolveAskHome(): string {
  const envVal = process.env.ASK_HOME
  if (envVal) {
    const expanded = envVal.startsWith('~/')
      ? path.join(os.homedir(), envVal.slice(2))
      : envVal
    return path.resolve(expanded)
  }
  return path.join(os.homedir(), '.ask')
}

// ── Per-kind store paths ───────────────────────────────────────────

/**
 * Assert that `candidate` resolves inside `parent`. Prevents path-traversal
 * attacks via `..` segments or absolute paths in user-controlled inputs.
 *
 * Throws a descriptive error on containment violation so the caller (e.g.
 * a source adapter) can surface it as an install failure instead of
 * silently writing files outside the store.
 */
function assertContained(parent: string, candidate: string): string {
  const resolvedParent = path.resolve(parent)
  const resolvedCandidate = path.resolve(candidate)
  const rel = path.relative(resolvedParent, resolvedCandidate)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `Unsafe path: ${candidate} is outside ${parent}`,
    )
  }
  return resolvedCandidate
}

export function npmStorePath(askHome: string, pkg: string, version: string): string {
  const candidate = path.join(askHome, 'npm', `${pkg}@${version}`)
  return assertContained(askHome, candidate)
}

export function githubDbPath(askHome: string, owner: string, repo: string): string {
  const candidate = path.join(askHome, 'github', 'db', `${owner}__${repo}.git`)
  return assertContained(askHome, candidate)
}

export function githubCheckoutPath(
  askHome: string,
  owner: string,
  repo: string,
  ref: string,
): string {
  const candidate = path.join(askHome, 'github', 'checkouts', `${owner}__${repo}`, ref)
  return assertContained(askHome, candidate)
}

/**
 * Resolve the nested per-entry directory for a github-kind store entry.
 *
 * Layout: `<askHome>/github/<host>/<owner>/<repo>/<tag>/`
 *
 * Mirrors the PM-style `<kind>/<identity>@<version>/` convention shared
 * by npm / web / llms-txt sources (and by cargo / bun / go / pnpm).
 * `host` is a reserved path segment — `github.com` is the only value
 * shipped, but the nesting leaves room for `gitlab.com` /
 * `bitbucket.org` without a layout migration.
 *
 * All four segments run through `assertContained` so `..` / absolute
 * paths from user-controlled inputs (repo names, tags) cannot escape
 * the store root.
 */
/**
 * Reject path-segment values that contain `..`, `/`, `\`, or are empty.
 * Used by `githubStorePath` to keep host/owner/repo/tag inputs from
 * escaping the github subdirectory via segment-level traversal —
 * which `assertContained` alone cannot catch because `../foo` inside
 * a deeper segment may still resolve inside the containment root.
 */
function assertSafeSegment(name: string, value: string): void {
  if (!value || value.includes('..') || value.includes('/') || value.includes('\\')) {
    throw new Error(`Unsafe path: ${name} '${value}' contains path traversal characters`)
  }
}

export function githubStorePath(
  askHome: string,
  host: string,
  owner: string,
  repo: string,
  tag: string,
): string {
  assertSafeSegment('host', host)
  assertSafeSegment('owner', owner)
  assertSafeSegment('repo', repo)
  assertSafeSegment('tag', tag)
  const githubRoot = path.join(askHome, 'github')
  const candidate = path.join(githubRoot, host, owner, repo, tag)
  return assertContained(githubRoot, candidate)
}

export function webStorePath(askHome: string, url: string): string {
  const hash = crypto.createHash('sha256').update(normalizeUrl(url)).digest('hex')
  return path.join(askHome, 'web', hash)
}

export function llmsTxtStorePath(askHome: string, url: string, version: string): string {
  const hash = crypto.createHash('sha256').update(normalizeUrl(url)).digest('hex')
  return path.join(askHome, 'llms-txt', `${hash}@${version}`)
}

const RE_TRAILING_SLASHES = /\/+$/

function normalizeUrl(url: string): string {
  // Strip trailing slash and lowercase only the scheme+host (RFC 3986: path is case-sensitive)
  const stripped = url.replace(RE_TRAILING_SLASHES, '')
  try {
    const parsed = new URL(stripped)
    parsed.protocol = parsed.protocol.toLowerCase()
    parsed.hostname = parsed.hostname.toLowerCase()
    return parsed.toString()
  }
  catch {
    // fallback for non-parseable strings: lowercase the whole thing
    return stripped.toLowerCase()
  }
}

// ── Atomic writes ──────────────────────────────────────────────────

/**
 * Atomically write a directory of files to `targetDir`.
 *
 * Writes to a temp directory first, then renames. This ensures the
 * target is never partially written.
 */
export function writeEntryAtomic(
  targetDir: string,
  files: { path: string, content: string }[],
): void {
  const tmpDir = `${targetDir}.tmp-${crypto.randomUUID().slice(0, 8)}`

  fs.mkdirSync(tmpDir, { recursive: true })
  try {
    for (const file of files) {
      const filePath = path.join(tmpDir, file.path)
      // Defense-in-depth: a malicious archive could produce a file with
      // `path: '../../etc/passwd'`. Reject any entry that escapes tmpDir.
      assertContained(tmpDir, filePath)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, file.content, 'utf-8')
    }
    // Atomic swap. To minimize the race window where the target is
    // briefly absent, rename the existing target to a stale-backup path
    // first (if present), then rename tmp → target, then remove the
    // backup. This keeps the target directory observable continuously:
    //   - Before: target → X
    //   - During: target → tmp (new content), X lingers as backup
    //   - After: target → tmp (renamed), backup removed
    // Callers holding `acquireEntryLock` are the exclusive writers, so
    // the backup is safe from contention.
    if (fs.existsSync(targetDir)) {
      const backupDir = `${targetDir}.bak-${crypto.randomUUID().slice(0, 8)}`
      fs.renameSync(targetDir, backupDir)
      try {
        fs.renameSync(tmpDir, targetDir)
      }
      catch (err) {
        // Restore the original target if the new rename failed
        fs.renameSync(backupDir, targetDir)
        throw err
      }
      // New target is in place; clean up backup asynchronously
      fs.rmSync(backupDir, { recursive: true, force: true })
    }
    else {
      fs.renameSync(tmpDir, targetDir)
    }
  }
  catch (err) {
    // Clean up temp directory on failure
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
    catch {
      // best-effort cleanup
    }
    throw err
  }
}

/**
 * Atomically copy an entire directory tree to `targetDir`.
 *
 * Copies to a temp directory first, then renames. Mirrors the atomicity
 * guarantee of `writeEntryAtomic` for the case where source files are
 * already on disk (e.g., extracted GitHub tarballs).
 */
export function cpDirAtomic(sourceDir: string, targetDir: string): void {
  const tmpDir = `${targetDir}.tmp-${crypto.randomUUID().slice(0, 8)}`
  fs.mkdirSync(path.dirname(tmpDir), { recursive: true })
  try {
    fs.cpSync(sourceDir, tmpDir, { recursive: true })
    if (fs.existsSync(targetDir)) {
      const backupDir = `${targetDir}.bak-${crypto.randomUUID().slice(0, 8)}`
      fs.renameSync(targetDir, backupDir)
      try {
        fs.renameSync(tmpDir, targetDir)
      }
      catch (err) {
        fs.renameSync(backupDir, targetDir)
        throw err
      }
      fs.rmSync(backupDir, { recursive: true, force: true })
    }
    else {
      fs.renameSync(tmpDir, targetDir)
    }
  }
  catch (err) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
    catch {
      // best-effort cleanup
    }
    throw err
  }
}

// ── Entry locking ──────────────────────────────────────────────────

const LOCK_TIMEOUT_MS = 60_000
const LOCK_INITIAL_DELAY_MS = 100
const LOCK_MAX_DELAY_MS = 1600

/**
 * Acquire a per-entry lock file. Returns a release function.
 *
 * Uses `fs.openSync(path, 'wx')` (exclusive create) as a simple
 * cross-platform advisory lock. If the lock is held, waits up to
 * `LOCK_TIMEOUT_MS` with exponential backoff. If the target entry
 * exists after the wait, treats it as a hit (another process completed
 * the write) and returns `null` — the caller should skip the write.
 */
export async function acquireEntryLock(
  entryDir: string,
): Promise<{ release: () => void } | null> {
  const lockPath = `${entryDir}.lock`

  fs.mkdirSync(path.dirname(lockPath), { recursive: true })

  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let delay = LOCK_INITIAL_DELAY_MS

  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx')
      fs.closeSync(fd)
      return {
        release: () => {
          try {
            fs.unlinkSync(lockPath)
          }
          catch {
            // lock file may already be cleaned up
          }
        },
      }
    }
    catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err
      }
      // Lock held by another process. If target already exists,
      // another process finished the write — treat as a store hit.
      if (fs.existsSync(entryDir)) {
        return null
      }
      if (Date.now() >= deadline) {
        // Timed out waiting for the holder to finish. Do NOT delete
        // the lock file here — deleting a live lock while another
        // process still holds it would allow two concurrent writers
        // into the same store entry. Let the caller handle the
        // timeout (e.g. by skipping the install for this entry or
        // surfacing it to the user).
        throw new Error(
          `Timed out waiting for lock: ${lockPath}. `
          + `Another ask install may be in progress. If no other process is running, remove ${lockPath} manually.`,
        )
      }
      await sleep(delay)
      delay = Math.min(delay * 2, LOCK_MAX_DELAY_MS)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Content verification ───────────────────────────────────────────

const HASH_FILE = '.ask-hash'

/**
 * Compute and store a content hash for a finalized store entry.
 */
export function stampEntry(entryDir: string): string {
  const hash = hashDir(entryDir)
  fs.writeFileSync(path.join(entryDir, HASH_FILE), hash, 'utf-8')
  return hash
}

/**
 * Verify that a store entry's content hash matches the recorded hash.
 * Returns `true` if valid, `false` otherwise.
 */
export function verifyEntry(entryDir: string): boolean {
  const hashPath = path.join(entryDir, HASH_FILE)
  if (!fs.existsSync(hashPath)) {
    return false
  }
  const recorded = fs.readFileSync(hashPath, 'utf-8').trim()
  const actual = hashDir(entryDir)
  return recorded === actual
}

function hashDir(dir: string): string {
  const hash = crypto.createHash('sha256')
  const files = collectFiles(dir).sort()
  for (const file of files) {
    if (path.basename(file) === HASH_FILE)
      continue
    hash.update(file)
    hash.update('\0')
    hash.update(fs.readFileSync(path.join(dir, file)))
    hash.update('\0')
  }
  return `sha256-${hash.digest('hex')}`
}

// ── Quarantine ─────────────────────────────────────────────────────

const RE_TIMESTAMP_PUNCT = /[:.]/g

/**
 * Move a corrupted store entry (one that fails `verifyEntry`) to the
 * quarantine directory at `<askHome>/.quarantine/<ts>-<uuid>/`. Used
 * by both the install orchestrator and the github source when a
 * store-hit short-circuit detects tampering or a missing stamp — the
 * corrupt entry is preserved for human inspection rather than deleted
 * outright, and a fresh fetch replaces it on the next run.
 *
 * Failures to rename (cross-device, permissions) fall through to a
 * best-effort `rm -rf` so the caller can always continue.
 */
export function quarantineEntry(askHome: string, storeDir: string): void {
  const ts = new Date().toISOString().replace(RE_TIMESTAMP_PUNCT, '-')
  const uuid = crypto.randomUUID().slice(0, 8)
  const quarantineDir = path.join(askHome, '.quarantine', `${ts}-${uuid}`)
  fs.mkdirSync(path.dirname(quarantineDir), { recursive: true })
  try {
    fs.renameSync(storeDir, quarantineDir)
    consola.warn(
      `Corrupted store entry at ${storeDir} quarantined to ${quarantineDir}. `
      + 'A fresh fetch will replace it.',
    )
  }
  catch (err) {
    consola.warn(
      `Could not quarantine corrupted entry at ${storeDir}: `
      + `${err instanceof Error ? err.message : String(err)}. Removing in place.`,
    )
    try {
      fs.rmSync(storeDir, { recursive: true, force: true })
    }
    catch {
      // best-effort
    }
  }
}

function collectFiles(dir: string, prefix = ''): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const result: string[] = []
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      result.push(...collectFiles(path.join(dir, entry.name), rel))
    }
    else {
      result.push(rel)
    }
  }
  return result
}
