import { describe, expect, it } from 'bun:test'
import { formatTable } from '../../src/display/table.js'

describe('formatTable', () => {
  it('returns empty string for zero headers', () => {
    expect(formatTable([], [])).toBe('')
  })

  it('renders header + separator for empty rows', () => {
    const out = formatTable(['Name', 'Version'], [])
    const lines = out.split('\n')
    expect(lines.length).toBe(2)
    expect(lines[0]).toContain('Name')
    expect(lines[0]).toContain('Version')
    expect(lines[1]).toMatch(/^─+$/)
  })

  it('pads each column to max(header, widest cell) + 2', () => {
    const out = formatTable(
      ['Name', 'Ver'],
      [
        ['zod', '3.22.4'],
        ['react', '19.0.0'],
      ],
    )
    const lines = out.split('\n')
    // header name col width = max(4, 5) + 2 = 7; "Name" + 3 spaces
    expect(lines[0]!.startsWith('Name   ')).toBe(true)
    // row "react" fills 5 chars + 2 = 7
    expect(lines[3]!.startsWith('react  ')).toBe(true)
  })

  it('does not crash on a single-column table', () => {
    const out = formatTable(['X'], [['a'], ['bbb']])
    expect(out.split('\n')).toHaveLength(4)
  })

  it('treats missing cells as empty strings', () => {
    const out = formatTable(['A', 'B', 'C'], [['1', '2']])
    expect(out.split('\n')).toHaveLength(3)
  })
})
