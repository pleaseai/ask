import { describe, expect, it } from 'bun:test'
import { has, inject, remove, wrap } from '../src/markers.js'

describe('wrap', () => {
  it('wraps a payload with html markers', () => {
    expect(wrap('hello', 'html')).toBe('<!-- ask:start -->\nhello\n<!-- ask:end -->')
  })

  it('wraps a payload with hash markers', () => {
    expect(wrap('hello', 'hash')).toBe('# ask:start\nhello\n# ask:end')
  })
})

describe('inject', () => {
  it('appends the block to an empty file', () => {
    const block = wrap('payload', 'hash')
    const result = inject('', block, 'hash')
    expect(result).toBe(`${block}\n`)
  })

  it('appends the block with a blank-line separator', () => {
    const block = wrap('payload', 'hash')
    const result = inject('existing\n', block, 'hash')
    expect(result).toBe(`existing\n\n${block}\n`)
  })

  it('replaces an existing block in place', () => {
    const existing = 'before\n\n# ask:start\nold\n# ask:end\n\nafter\n'
    const block = wrap('new', 'hash')
    const result = inject(existing, block, 'hash')
    expect(result).toBe('before\n\n# ask:start\nnew\n# ask:end\n\nafter\n')
  })

  it('is idempotent', () => {
    const block = wrap('payload', 'html')
    const once = inject('existing\n', block, 'html')
    const twice = inject(once, block, 'html')
    expect(twice).toBe(once)
  })
})

describe('remove', () => {
  it('strips an existing block and preserves surrounding content', () => {
    const existing = 'before\n\n# ask:start\npayload\n# ask:end\n\nafter\n'
    expect(remove(existing, 'hash')).toBe('before\n\nafter\n')
  })

  it('returns content unchanged when no marker is present', () => {
    expect(remove('plain content\n', 'hash')).toBe('plain content\n')
  })

  it('returns empty string when content only contained the block', () => {
    const block = wrap('payload', 'hash')
    expect(remove(`${block}\n`, 'hash')).toBe('')
  })
})

describe('has', () => {
  it('detects a present block', () => {
    expect(has('# ask:start\nx\n# ask:end', 'hash')).toBe(true)
  })

  it('returns false for missing blocks', () => {
    expect(has('', 'hash')).toBe(false)
    expect(has('plain', 'hash')).toBe(false)
  })
})
