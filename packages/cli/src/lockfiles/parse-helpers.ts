/**
 * Shared text-level helpers for the hand-rolled pnpm / yarn lockfile
 * parsers. Ported from opensrc's `core/version.rs` (vercel-labs/opensrc#51).
 */

const RE_QUOTES = /^['"]+|['"]+$/g

/**
 * Strip a pnpm peer-dependency suffix like `(react@18.0.0)` from a version
 * string, so `18.2.0(react@17.0.0)` becomes `18.2.0`. Cuts at the first `(`
 * so nested peer suffixes like `18.2.0(a@1)(b@2(c@3))` also collapse
 * cleanly.
 */
export function stripPeerSuffix(v: string): string {
  const i = v.indexOf('(')
  return (i >= 0 ? v.slice(0, i) : v).trimEnd()
}

/**
 * Strip a YAML-style inline comment. Only strips when `#` is preceded by
 * whitespace, so URL fragments like `github:foo/bar#branch` pass through
 * intact.
 */
export function stripInlineComment(s: string): string {
  const i = s.indexOf(' #')
  return i >= 0 ? s.slice(0, i).trimEnd() : s
}

/** Strip any mix of surrounding single/double quotes from a trimmed string. */
export function trimQuotes(s: string): string {
  return s.replace(RE_QUOTES, '')
}

/**
 * Normalise a raw YAML value: trim whitespace, strip an inline comment, and
 * strip surrounding quotes. Does NOT strip peer-dep suffixes — callers do
 * that when appropriate.
 */
export function cleanValue(s: string): string {
  return trimQuotes(stripInlineComment(s.trim()))
}

/**
 * Split a `<pkg>@<rest>` spec into `[name, rest]`, treating scoped names
 * (`@scope/pkg`) correctly. Returns `null` if there's no `@` separator.
 */
export function splitPkgSpec(spec: string): [string, string] | null {
  let atPos: number
  if (spec.startsWith('@')) {
    const i = spec.indexOf('@', 1)
    if (i < 0)
      return null
    atPos = i
  }
  else {
    atPos = spec.indexOf('@')
    if (atPos < 0)
      return null
  }
  return [spec.slice(0, atPos), spec.slice(atPos + 1)]
}

/**
 * Return `true` if `v` looks like a version we can resolve against a public
 * registry. Lockfiles (and package.json) can legitimately contain
 * workspace/link/file/git/URL protocol strings — for example a pnpm importer
 * may pin a sibling workspace package with `version: link:../pkg`, and a
 * yarn Berry workspace root has `version: 0.0.0-use.local`. Returning any
 * of those would make the caller try to fetch `<pkg>@link:../pkg` from npm,
 * which fails with a confusing error.
 *
 * Real npm versions never contain `:`, so treating a colon as disqualifying
 * catches every known protocol prefix (`link:`, `file:`, `workspace:`,
 * `portal:`, `git:`, `git+ssh://`, `github:`, `http:`, `https:`, `npm:`,
 * etc.) without having to enumerate them.
 */
export function isRegistryVersion(v: string): boolean {
  return v.length > 0 && v !== '0.0.0-use.local' && !v.includes(':')
}
