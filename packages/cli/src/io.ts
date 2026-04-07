import type { Config, Lock, LockEntry } from './schemas.js'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ConfigSchema, LockSchema } from './schemas.js'

/**
 * Recursively sort object keys for deterministic JSON serialization.
 * Arrays preserve their element order; only object keys are reordered.
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys)
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, sortKeys(v)] as const)
    return Object.fromEntries(entries)
  }
  return value
}

/**
 * Serialize a value to JSON with sorted keys, 2-space indent, and a trailing
 * newline. Two calls with semantically equivalent input always produce the
 * same byte string.
 */
export function sortedJSON(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`
}

/**
 * Compute a deterministic content hash over a list of files.
 * Files are sorted by relative path; each file contributes
 * `<relpath>\0<bytes>\0` to the hash stream. The null separators prevent
 * `path + content` ambiguity (e.g. "ab" + "cd" vs "a" + "bcd").
 */
export function contentHash(
  files: Array<{ relpath: string, bytes: Uint8Array }>,
): string {
  const sorted = [...files].sort((a, b) =>
    a.relpath < b.relpath ? -1 : a.relpath > b.relpath ? 1 : 0,
  )
  const hash = createHash('sha256')
  const NUL = new Uint8Array([0])
  for (const f of sorted) {
    hash.update(new TextEncoder().encode(f.relpath))
    hash.update(NUL)
    hash.update(f.bytes)
    hash.update(NUL)
  }
  return `sha256-${hash.digest('hex')}`
}

const ASK_DIR = '.ask'
const CONFIG_FILE = 'config.json'
const LOCK_FILE = 'ask.lock'

export function getAskDir(projectDir: string): string {
  return path.join(projectDir, ASK_DIR)
}

export function getConfigPath(projectDir: string): string {
  return path.join(getAskDir(projectDir), CONFIG_FILE)
}

export function getLockPath(projectDir: string): string {
  return path.join(getAskDir(projectDir), LOCK_FILE)
}

const EMPTY_CONFIG: Config = { schemaVersion: 1, docs: [] }

/**
 * Read and validate `.ask/config.json`. Returns the default empty config when
 * the file does not exist. Throws on invalid contents.
 */
export function readConfig(projectDir: string): Config {
  const file = getConfigPath(projectDir)
  if (!fs.existsSync(file)) {
    return { ...EMPTY_CONFIG, docs: [] }
  }
  const raw = fs.readFileSync(file, 'utf-8')
  const parsed = JSON.parse(raw) as unknown
  return ConfigSchema.parse(parsed)
}

/**
 * Validate, sort, and write `.ask/config.json`. Sorts `docs[]` by name.
 * Throws (without writing) if the input fails Zod validation.
 */
export function writeConfig(projectDir: string, config: Config): void {
  const validated = ConfigSchema.parse(config)
  const sortedDocs = [...validated.docs].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )
  const out: Config = { ...validated, docs: sortedDocs }
  const file = getConfigPath(projectDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, sortedJSON(out), 'utf-8')
}

const EMPTY_LOCK: Lock = {
  lockfileVersion: 1,
  generatedAt: '1970-01-01T00:00:00Z',
  entries: {},
}

/**
 * Read and validate `.ask/ask.lock`. Returns the default empty lock when the
 * file does not exist. Throws on invalid contents.
 */
export function readLock(projectDir: string): Lock {
  const file = getLockPath(projectDir)
  if (!fs.existsSync(file)) {
    return { ...EMPTY_LOCK, entries: {} }
  }
  const raw = fs.readFileSync(file, 'utf-8')
  const parsed = JSON.parse(raw) as unknown
  return LockSchema.parse(parsed)
}

/**
 * Validate, sort, and write `.ask/ask.lock`. Throws (without writing) if the
 * input fails Zod validation.
 */
export function writeLock(projectDir: string, lock: Lock): void {
  const validated = LockSchema.parse(lock)
  const file = getLockPath(projectDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, sortedJSON(validated), 'utf-8')
}

/**
 * Upsert a single entry into `.ask/ask.lock`. Updates `generatedAt` only when
 * the entry actually changes (so byte-stable on no-op re-runs).
 */
export function upsertLockEntry(
  projectDir: string,
  name: string,
  entry: LockEntry,
): void {
  const lock = readLock(projectDir)
  const previous = lock.entries[name]
  const changed = !previous
    || sortedJSON(stripFetchedAt(previous)) !== sortedJSON(stripFetchedAt(entry))
  const next: Lock = {
    lockfileVersion: 1,
    generatedAt: changed ? new Date().toISOString() : lock.generatedAt,
    entries: {
      ...lock.entries,
      [name]: entry,
    },
  }
  writeLock(projectDir, next)
}

function stripFetchedAt(entry: LockEntry): Omit<LockEntry, 'fetchedAt'> {
  const { fetchedAt: _, ...rest } = entry
  return rest as Omit<LockEntry, 'fetchedAt'>
}

/**
 * Remove one or more entries from the lock by name. No-op if absent.
 */
export function removeLockEntries(
  projectDir: string,
  names: string[],
): void {
  if (names.length === 0)
    return
  const lock = readLock(projectDir)
  const set = new Set(names)
  const remaining = Object.fromEntries(
    Object.entries(lock.entries).filter(([k]) => !set.has(k)),
  )
  writeLock(projectDir, {
    lockfileVersion: 1,
    generatedAt: new Date().toISOString(),
    entries: remaining,
  })
}
