import { describe, expect, it } from 'bun:test'
import { decodeSpecKey, encodeSpecKey } from '../../src/skills/spec-key.js'

describe('encodeSpecKey', () => {
  it('encodes a simple npm spec', () => {
    expect(encodeSpecKey({ ecosystem: 'npm', name: 'next', version: '14.2.3' }))
      .toBe('npm__next__14.2.3')
  })

  it('encodes a scoped npm package by replacing slash with __', () => {
    expect(encodeSpecKey({ ecosystem: 'npm', name: '@vercel/ai', version: '5.0.0' }))
      .toBe('npm__@vercel__ai__5.0.0')
  })

  it('encodes a github spec with owner/repo', () => {
    expect(encodeSpecKey({ ecosystem: 'github', name: 'vercel/ai', version: 'v5.0.0' }))
      .toBe('github__vercel__ai__v5.0.0')
  })

  it('encodes a monorepo tag (contains @)', () => {
    expect(encodeSpecKey({ ecosystem: 'github', name: 'tanstack/router', version: '@tanstack/router-core@1.0.0' }))
      .toBe('github__tanstack__router__@tanstack__router-core@1.0.0')
  })

  it('rejects empty parts', () => {
    expect(() => encodeSpecKey({ ecosystem: '', name: 'x', version: '1' }))
      .toThrow()
  })
})

describe('decodeSpecKey', () => {
  it('round-trips a simple npm spec', () => {
    const input = { ecosystem: 'npm', name: 'next', version: '14.2.3' }
    expect(decodeSpecKey(encodeSpecKey(input))).toEqual(input)
  })

  it('round-trips a scoped npm spec', () => {
    const input = { ecosystem: 'npm', name: '@vercel/ai', version: '5.0.0' }
    expect(decodeSpecKey(encodeSpecKey(input))).toEqual(input)
  })

  it('round-trips a github spec', () => {
    const input = { ecosystem: 'github', name: 'vercel/ai', version: 'v5.0.0' }
    expect(decodeSpecKey(encodeSpecKey(input))).toEqual(input)
  })

  it('throws on malformed key without __ separator', () => {
    expect(() => decodeSpecKey('onlyone')).toThrow()
  })

  it('throws on malformed key missing version segment', () => {
    expect(() => decodeSpecKey('npm__next')).toThrow()
  })
})
