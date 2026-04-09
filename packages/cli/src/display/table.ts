// ---------------------------------------------------------------------------
// Table rendering helper.
//
// Ported from @tanstack/intent (MIT, https://github.com/tanstack/intent)
// `packages/intent/src/display.ts`. Adapted to:
//   - return a string (`formatTable`) so it is trivially unit-testable, and
//   - emit via consola (`printTable`) instead of raw `console.log`.
// ---------------------------------------------------------------------------

import { consola } from 'consola'

function padColumn(text: string, width: number): string {
  return text.length >= width ? `${text}  ` : text.padEnd(width)
}

/**
 * Format a table as a multi-line string. Column widths are the max of
 * (header, longest cell) + 2 for breathing room. A U+2500 separator
 * line runs under the header. Returns the empty string for a table
 * with zero headers. A table with headers but no rows renders the
 * header + separator only.
 */
export function formatTable(
  headers: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
): string {
  if (headers.length === 0) {
    return ''
  }
  const widths = headers.map(
    (h, i) =>
      Math.max(h.length, ...rows.map(r => (r[i] ?? '').length)) + 2,
  )

  const lines: string[] = []
  lines.push(headers.map((h, i) => padColumn(h, widths[i]!)).join(''))
  lines.push(widths.map(w => '─'.repeat(w)).join(''))
  for (const row of rows) {
    lines.push(row.map((cell, i) => padColumn(cell ?? '', widths[i]!)).join(''))
  }
  return lines.join('\n')
}

/**
 * Emit `formatTable(headers, rows)` one line at a time via consola.log.
 */
export function printTable(
  headers: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
): void {
  const out = formatTable(headers, rows)
  if (out === '')
    return
  for (const line of out.split('\n')) {
    consola.log(line)
  }
}
