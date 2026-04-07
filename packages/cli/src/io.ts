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

const ENCODER = new TextEncoder()
const NUL = new Uint8Array([0])

/**
 * Compute a deterministic content hash over a list of files.
 * Files are sorted by relative path; each file contributes
 * `<relpath>\0<bytes>\0` to the hash stream. The null separators prevent
 * `path + content` ambiguity (e.g. "ab" + "cd" vs "a" + "bcd").
 *
 * Accepts either pre-encoded bytes or string content (the common case for
 * DocFile records returned by source adapters).
 */
export interface HashableFile {
  relpath: string
  bytes?: Uint8Array
  content?: string
}

export function contentHash(files: HashableFile[]): string {
  const sorted = [...files].sort((a, b) =>
    a.relpath < b.relpath ? -1 : a.relpath > b.relpath ? 1 : 0,
  )
  const hash = createHash('sha256')
  for (const f of sorted) {
    hash.update(ENCODER.encode(f.relpath))
    hash.update(NUL)
    hash.update(f.bytes ?? ENCODER.encode(f.content ?? ''))
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

/**
 * Read and validate `.ask/config.json`. Returns the default empty config when
 * the file does not exist. Throws on invalid contents.
 */
export function readConfig(projectDir: string): Config {
  const file = getConfigPath(projectDir)
  if (!fs.existsSync(file)) {
    return { schemaVersion: 1, docs: [] }
  }
  const raw = fs.readFileSync(file, 'utf-8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch (err) {
    throw new Error(
      `Failed to parse ${file}: ${err instanceof Error ? err.message : err}. `
      + 'The file may be corrupt — delete it and re-run `ask docs sync` to regenerate.',
    )
  }
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

/**
 * Read and validate `.ask/ask.lock`. Returns the default empty lock when the
 * file does not exist. Throws on invalid contents.
 */
export function readLock(projectDir: string): Lock {
  const file = getLockPath(projectDir)
  if (!fs.existsSync(file)) {
    return {
      lockfileVersion: 1,
      generatedAt: '1970-01-01T00:00:00Z',
      entries: {},
    }
  }
  const raw = fs.readFileSync(file, 'utf-8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch (err) {
    throw new Error(
      `Failed to parse ${file}: ${err instanceof Error ? err.message : err}. `
      + 'The file may be corrupt — delete it and re-run `ask docs sync` to regenerate.',
    )
  }
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
  // No-op short circuit: if nothing changed (modulo fetchedAt), don't rewrite
  // the file at all. This preserves mtime for build caches and file watchers.
  if (!changed) {
    return
  }
  writeLock(projectDir, {
    lockfileVersion: 1,
    generatedAt: new Date().toISOString(),
    entries: { ...lock.entries, [name]: entry },
  })
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
