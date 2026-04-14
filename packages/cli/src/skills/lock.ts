import fs from 'node:fs'
import path from 'node:path'

export const LOCK_FILENAME = '.ask/skills-lock.json'

export interface LockSkill {
  /** Skill name — the basename of the source skill directory. */
  name: string
  /** Agents whose `<agent>/skills/<name>` symlinks were installed. */
  agents: string[]
}

export interface LockEntry {
  /** Original user-facing spec, e.g. `npm:next@14.2.3`. */
  spec: string
  /** Filesystem-safe encoding (see `encodeSpecKey`). */
  specKey: string
  /** Skills installed for this entry. */
  skills: LockSkill[]
  /** ISO timestamp of the last install. */
  installedAt: string
}

export interface LockFile {
  version: 1
  entries: Record<string, LockEntry>
}

const EMPTY_LOCK: LockFile = { version: 1, entries: {} }

export function lockPath(projectDir: string): string {
  return path.join(projectDir, LOCK_FILENAME)
}

export function readLock(projectDir: string): LockFile {
  const p = lockPath(projectDir)
  if (!fs.existsSync(p)) {
    return { version: 1, entries: {} }
  }
  const raw = fs.readFileSync(p, 'utf-8')
  const parsed = JSON.parse(raw) as unknown
  if (!isLockFile(parsed)) {
    throw new Error(`${LOCK_FILENAME}: schema mismatch`)
  }
  return parsed
}

export function upsertEntry(lock: LockFile, entry: LockEntry): LockFile {
  return {
    version: 1,
    entries: { ...lock.entries, [entry.specKey]: entry },
  }
}

export function removeEntry(lock: LockFile, specKey: string): LockFile {
  if (!(specKey in lock.entries)) {
    return lock
  }
  const next = { ...lock.entries }
  delete next[specKey]
  return { version: 1, entries: next }
}

/**
 * Atomic write — serialise to a `.tmp` neighbour first, then rename. Avoids
 * half-written files if the process dies mid-write. The parent directory
 * (`.ask/`) is created on demand so callers never have to pre-mkdir.
 */
export function writeLockAtomic(projectDir: string, lock: LockFile): void {
  const target = lockPath(projectDir)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(lock, null, 2)}\n`, 'utf-8')
  fs.renameSync(tmp, target)
}

function isLockFile(value: unknown): value is LockFile {
  if (typeof value !== 'object' || value === null)
    return false
  const v = value as Partial<LockFile>
  return v.version === 1 && typeof v.entries === 'object' && v.entries !== null
}

export { EMPTY_LOCK }
