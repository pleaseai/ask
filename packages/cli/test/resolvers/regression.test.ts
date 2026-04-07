import { describe, expect, it } from 'bun:test'
import { parseDocSpec } from '../../src/registry.js'
import { getResolver } from '../../src/resolvers/index.js'

describe('resolver regression', () => {
  it('registry-hit specs do not trigger resolvers', () => {
    // Bare names parse as 'name' kind, not 'ecosystem' kind,
    // so the add command's resolver fallback branch is never reached.
    const bare = parseDocSpec('next')
    expect(bare.kind).toBe('name')

    // Even with an ecosystem prefix, the registry is checked first.
    // The resolver is only used when the registry returns null.
    const prefixed = parseDocSpec('npm:next')
    expect(prefixed.kind).toBe('ecosystem')
  })

  it('getResolver returns null for unsupported ecosystems', () => {
    expect(getResolver('cargo')).toBeNull()
    expect(getResolver('go')).toBeNull()
    expect(getResolver('hex')).toBeNull()
    expect(getResolver('nuget')).toBeNull()
  })

  it('getResolver returns resolvers for supported ecosystems', () => {
    expect(getResolver('npm')).not.toBeNull()
    expect(getResolver('pypi')).not.toBeNull()
    expect(getResolver('pub')).not.toBeNull()
  })
})
