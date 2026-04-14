/**
 * Filesystem-safe encoding of a resolved library spec used as the top-level
 * directory name under `.ask/skills/<spec-key>/`. Only `/` and `:` — the
 * structural separators that collide with path syntax — are rewritten to
 * `__`. `@` is kept as-is so scoped npm packages stay human-readable.
 *
 * Examples:
 *   { npm, next, 14.2.3 }               → npm__next__14.2.3
 *   { npm, @vercel/ai, 5.0.0 }          → npm__@vercel__ai__5.0.0
 *   { github, vercel/ai, v5.0.0 }       → github__vercel__ai__v5.0.0
 */

export interface SpecKeyInput {
  /** Ecosystem prefix: `npm`, `github`, `pypi`, etc. */
  ecosystem: string
  /** Package name or `owner/repo` for github. */
  name: string
  /** Resolved version or git ref. */
  version: string
}

const FORBIDDEN_RE = /[/:]/g

export function encodeSpecKey(input: SpecKeyInput): string {
  return [input.ecosystem, input.name, input.version].map(encodePart).join('__')
}

function encodePart(value: string): string {
  if (value === '') {
    throw new Error('spec-key part must be non-empty')
  }
  return value.replace(FORBIDDEN_RE, '__')
}

/**
 * Reverse of {@link encodeSpecKey}. The input is split on `__` and the
 * canonical layout has at least three segments: `[ecosystem, …name parts, version]`.
 * Name parts are re-joined with `/` since that is the only separator we encode
 * inside `name` (the `:` replacement is rare and reserved for ecosystem-specific
 * metadata we do not currently emit).
 */
export function decodeSpecKey(key: string): SpecKeyInput {
  const segments = key.split('__')
  if (segments.length < 3) {
    throw new Error(`malformed spec-key (needs at least 3 segments): ${key}`)
  }
  const ecosystem = segments[0]
  const version = segments[segments.length - 1]
  const name = segments.slice(1, -1).join('/')
  if (!ecosystem || !name || !version) {
    throw new Error(`malformed spec-key (empty segment): ${key}`)
  }
  return { ecosystem, name, version }
}
