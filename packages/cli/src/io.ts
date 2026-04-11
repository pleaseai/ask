import type { AskJson, ResolvedEntry, ResolvedJson } from './schemas.js'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { AskJsonSchema, LaxAskJsonSchema, ResolvedJsonSchema } from './schemas.js'

/**
 * Options for read/write ask.json operations. Legacy fields (kept for
 * API stability) — the runtime behaviour no longer branches on these.
 *
 * readAskJson and writeAskJson always use `LaxAskJsonSchema` because
 * they have to stay callable from internal read paths that don't know
 * or care about the CLI's `--allow-mutable-ref` flag (listDocs,
 * generateAgentsMd, manageIgnoreFiles, etc.). Strict validation is
 * performed by CLI entry points (install / add) via
 * `validateAskJsonStrict` before any internal read runs.
 */
export interface AskJsonIoOptions {
  allowMutableRef?: boolean
}

/**
 * Explicit strict-parse helper used by CLI entry points to reject
 * mutable refs before the rest of the pipeline sees the data.
 * Returns the validated AskJson on success; throws on violation so
 * the CLI can surface the error.
 */
export function validateAskJsonStrict(askJson: AskJson): AskJson {
  return AskJsonSchema.parse(askJson) as AskJson
}

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

export interface HashableFile {
  relpath: string
  bytes?: Uint8Array
  content?: string
}

/**
 * Compute a deterministic content hash over a list of files. Files are
 * sorted by relative path; each file contributes `<relpath>\0<bytes>\0`
 * to the hash stream. Null separators prevent `path + content`
 * ambiguity (`"ab" + "cd"` vs `"a" + "bcd"`).
 */
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
const ASK_JSON_FILE = 'ask.json'
const RESOLVED_FILE = 'resolved.json'

export function getAskDir(projectDir: string): string {
  return path.join(projectDir, ASK_DIR)
}

/**
 * `ask.json` is a root-level file (sits beside `package.json`), NOT
 * inside `.ask/`. The `.ask/` directory is reserved for materialized,
 * gitignored output (docs + resolved cache).
 */
export function getAskJsonPath(projectDir: string): string {
  return path.join(projectDir, ASK_JSON_FILE)
}

export function getResolvedJsonPath(projectDir: string): string {
  return path.join(getAskDir(projectDir), RESOLVED_FILE)
}

/**
 * Read and validate `ask.json`. Returns null when the file does not
 * exist (so the install orchestrator can bootstrap an empty file per
 * FR-8). Throws on invalid JSON or schema violations.
 */
export function readAskJson(projectDir: string, _options?: AskJsonIoOptions): AskJson | null {
  const file = getAskJsonPath(projectDir)
  if (!fs.existsSync(file)) {
    return null
  }
  const raw = fs.readFileSync(file, 'utf-8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch (err) {
    throw new Error(
      `Failed to parse ${file}: ${err instanceof Error ? err.message : err}.`,
    )
  }
  return LaxAskJsonSchema.parse(parsed) as AskJson
}

/**
 * Validate and write `ask.json`. Library entries are NOT reordered —
 * users may care about declaration order, and `ask add` always
 * appends. Uses the lax schema so internal writes don't need to know
 * about `--allow-mutable-ref`; strict validation is performed by CLI
 * entry points via `validateAskJsonStrict`.
 */
export function writeAskJson(
  projectDir: string,
  askJson: AskJson,
  _options?: AskJsonIoOptions,
): void {
  const validated = LaxAskJsonSchema.parse(askJson)
  const file = getAskJsonPath(projectDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, sortedJSON(validated), 'utf-8')
}

/**
 * Read and validate `.ask/resolved.json`. Returns the default empty
 * cache when the file does not exist or fails validation — the cache
 * is rebuilt from scratch in that case (FR-11).
 */
export function readResolvedJson(projectDir: string): ResolvedJson {
  const file = getResolvedJsonPath(projectDir)
  if (!fs.existsSync(file)) {
    return emptyResolved()
  }
  const raw = fs.readFileSync(file, 'utf-8')
  try {
    return ResolvedJsonSchema.parse(JSON.parse(raw))
  }
  catch {
    // Treat any read/parse/validation failure as "no cache" — the next
    // install will rebuild it cleanly. This is the contract that makes
    // resolved.json safe to delete by hand.
    return emptyResolved()
  }
}

function emptyResolved(): ResolvedJson {
  return {
    schemaVersion: 1,
    generatedAt: '1970-01-01T00:00:00Z',
    entries: {},
  }
}

/**
 * Validate and write `.ask/resolved.json`. Always rewrites the
 * `generatedAt` timestamp; callers should batch updates rather than
 * call once per entry.
 */
export function writeResolvedJson(projectDir: string, resolved: ResolvedJson): void {
  const validated = ResolvedJsonSchema.parse(resolved)
  const file = getResolvedJsonPath(projectDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, sortedJSON(validated), 'utf-8')
}

/**
 * Upsert a single entry into `.ask/resolved.json`. Skips the rewrite
 * when nothing changed (modulo `fetchedAt`) so file watchers and build
 * caches stay quiet on no-op runs.
 */
export function upsertResolvedEntry(
  projectDir: string,
  key: string,
  entry: ResolvedEntry,
): void {
  const resolved = readResolvedJson(projectDir)
  const previous = resolved.entries[key]
  const changed = !previous
    || sortedJSON(stripFetchedAt(previous)) !== sortedJSON(stripFetchedAt(entry))
  if (!changed) {
    return
  }
  writeResolvedJson(projectDir, {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    entries: { ...resolved.entries, [key]: entry },
  })
}

function stripFetchedAt(entry: ResolvedEntry): Omit<ResolvedEntry, 'fetchedAt'> {
  const { fetchedAt: _f, ...rest } = entry
  return rest
}

/**
 * Remove one or more entries from `.ask/resolved.json` by key. No-op
 * if absent.
 */
export function removeResolvedEntries(projectDir: string, keys: string[]): void {
  if (keys.length === 0) {
    return
  }
  const resolved = readResolvedJson(projectDir)
  const set = new Set(keys)
  const remaining = Object.fromEntries(
    Object.entries(resolved.entries).filter(([k]) => !set.has(k)),
  )
  writeResolvedJson(projectDir, {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    entries: remaining,
  })
}
