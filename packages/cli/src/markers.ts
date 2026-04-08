/**
 * Marker block helpers for injecting ASK-owned content into user files
 * without touching the surrounding user content.
 *
 * Two comment syntaxes are supported:
 *   - `html` — for Markdown files (`<!-- ask:start --> ... <!-- ask:end -->`)
 *   - `hash` — for ignore/properties files (`# ask:start ... # ask:end`)
 */

export type MarkerSyntax = 'html' | 'hash'

interface MarkerPair {
  begin: string
  end: string
}

const LEADING_WHITESPACE_RE = /^\s+/

const MARKERS: Record<MarkerSyntax, MarkerPair> = {
  html: {
    begin: '<!-- ask:start -->',
    end: '<!-- ask:end -->',
  },
  hash: {
    begin: '# ask:start',
    end: '# ask:end',
  },
}

/**
 * Wrap a payload with begin/end markers for the given comment syntax.
 * The output does not include a trailing newline.
 */
export function wrap(payload: string, syntax: MarkerSyntax): string {
  const { begin, end } = MARKERS[syntax]
  return `${begin}\n${payload}\n${end}`
}

/**
 * Inject or refresh a marker block in `content`. If a block with matching
 * markers already exists, it is replaced in place. Otherwise the block is
 * appended to the end of the file with a blank line separator.
 *
 * The function is deterministic and idempotent: calling `inject` twice with
 * the same block produces the same output.
 */
export function inject(
  content: string,
  block: string,
  syntax: MarkerSyntax,
): string {
  const { begin, end } = MARKERS[syntax]
  const beginIdx = content.indexOf(begin)
  const endIdx = content.indexOf(end)

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    // Replace existing block in place.
    return content.substring(0, beginIdx) + block + content.substring(endIdx + end.length)
  }

  // Append to end with a blank-line separator.
  if (content.length === 0) {
    return `${block}\n`
  }
  return `${content.trimEnd()}\n\n${block}\n`
}

/**
 * Strip the marker block from `content` if present. Returns the content
 * unchanged if no marker pair is found. Trailing blank lines around the
 * removed block are normalised.
 */
export function remove(content: string, syntax: MarkerSyntax): string {
  const { begin, end } = MARKERS[syntax]
  const beginIdx = content.indexOf(begin)
  const endIdx = content.indexOf(end)
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
    return content
  }
  const before = content.substring(0, beginIdx).trimEnd()
  const after = content.substring(endIdx + end.length).replace(LEADING_WHITESPACE_RE, '')
  if (before.length === 0 && after.length === 0)
    return ''
  if (before.length === 0)
    return after.endsWith('\n') ? after : `${after}\n`
  if (after.length === 0)
    return `${before}\n`
  const tail = after.endsWith('\n') ? after : `${after}\n`
  return `${before}\n\n${tail}`
}

/**
 * Test whether a marker block of the given syntax exists in `content`.
 */
export function has(content: string, syntax: MarkerSyntax): boolean {
  const { begin, end } = MARKERS[syntax]
  const beginIdx = content.indexOf(begin)
  const endIdx = content.indexOf(end)
  return beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx
}
