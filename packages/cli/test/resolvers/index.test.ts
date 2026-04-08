import { describe, expect, it } from 'bun:test'
import { getResolver } from '../../src/resolvers/index.js'

describe('getResolver', () => {
  it('returns a resolver for maven', () => {
    const resolver = getResolver('maven')
    expect(resolver).toBeDefined()
    expect(typeof resolver.resolve).toBe('function')
  })

  it('returns a resolver for npm', () => {
    const resolver = getResolver('npm')
    expect(resolver).toBeDefined()
    expect(typeof resolver.resolve).toBe('function')
  })

  it('returns a resolver for pypi', () => {
    const resolver = getResolver('pypi')
    expect(resolver).toBeDefined()
    expect(typeof resolver.resolve).toBe('function')
  })

  it('returns a resolver for pub', () => {
    const resolver = getResolver('pub')
    expect(resolver).toBeDefined()
    expect(typeof resolver.resolve).toBe('function')
  })

  it('returns null for unsupported ecosystem', () => {
    expect(getResolver('cargo')).toBeNull()
  })
})
