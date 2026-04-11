import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

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
  // Strip trailing slash and lowercase scheme+host for dedup
  return url.replace(RE_TRAILING_SLASHES, '').toLowerCase()
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
    hash.update(fs.readFileSync(path.join(dir, file)))
  }
  return `sha256-${hash.digest('hex')}`
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
