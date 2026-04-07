import { createHash } from 'node:crypto'

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
