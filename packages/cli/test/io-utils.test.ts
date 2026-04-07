import { describe, expect, it } from 'bun:test'
import { contentHash, sortedJSON } from '../src/io.js'

describe('sortedJSON', () => {
  it('sorts top-level keys alphabetically', () => {
    const out = sortedJSON({ b: 1, a: 2, c: 3 })
    expect(out).toBe('{\n  "a": 2,\n  "b": 1,\n  "c": 3\n}\n')
  })

  it('sorts nested object keys', () => {
    const out = sortedJSON({ z: { y: 1, x: 2 } })
    expect(out).toBe('{\n  "z": {\n    "x": 2,\n    "y": 1\n  }\n}\n')
  })

  it('preserves array element order', () => {
    const out = sortedJSON([{ b: 1 }, { a: 2 }])
    expect(out).toBe('[\n  {\n    "b": 1\n  },\n  {\n    "a": 2\n  }\n]\n')
  })

  it('produces a trailing newline', () => {
    expect(sortedJSON({ a: 1 }).endsWith('\n')).toBe(true)
  })

  it('is deterministic across calls with shuffled input', () => {
    const a = sortedJSON({ a: 1, b: 2, c: 3 })
    const b = sortedJSON({ c: 3, b: 2, a: 1 })
    expect(a).toBe(b)
  })

  it('handles primitives and null', () => {
    expect(sortedJSON(null)).toBe('null\n')
    expect(sortedJSON(42)).toBe('42\n')
    expect(sortedJSON('hi')).toBe('"hi"\n')
  })
})

describe('contentHash', () => {
  it('returns sha256-<64hex>', () => {
    const h = contentHash([
      { relpath: 'a.md', bytes: new TextEncoder().encode('hello') },
    ])
    expect(h).toMatch(/^sha256-[0-9a-f]{64}$/)
  })

  it('is order-independent (sorts by relpath)', () => {
    const files = [
      { relpath: 'a.md', bytes: new TextEncoder().encode('A') },
      { relpath: 'b.md', bytes: new TextEncoder().encode('B') },
      { relpath: 'c.md', bytes: new TextEncoder().encode('C') },
    ]
    const h1 = contentHash(files)
    const h2 = contentHash([...files].reverse())
    expect(h1).toBe(h2)
  })

  it('changes when content changes', () => {
    const a = contentHash([
      { relpath: 'a.md', bytes: new TextEncoder().encode('hello') },
    ])
    const b = contentHash([
      { relpath: 'a.md', bytes: new TextEncoder().encode('hello!') },
    ])
    expect(a).not.toBe(b)
  })

  it('changes when a file is added', () => {
    const a = contentHash([
      { relpath: 'a.md', bytes: new TextEncoder().encode('A') },
    ])
    const b = contentHash([
      { relpath: 'a.md', bytes: new TextEncoder().encode('A') },
      { relpath: 'b.md', bytes: new TextEncoder().encode('B') },
    ])
    expect(a).not.toBe(b)
  })

  it('distinguishes path from content (separator prevents ambiguity)', () => {
    const a = contentHash([
      { relpath: 'ab', bytes: new TextEncoder().encode('cd') },
    ])
    const b = contentHash([
      { relpath: 'a', bytes: new TextEncoder().encode('bcd') },
    ])
    expect(a).not.toBe(b)
  })
})
