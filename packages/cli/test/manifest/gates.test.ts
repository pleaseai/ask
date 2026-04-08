import { describe, expect, it } from 'bun:test'
import { checkBareNameGate, runManifestGate } from '../../src/index.js'

describe('checkBareNameGate (Gate A)', () => {
  it('rejects bare name without explicit source', () => {
    const err = checkBareNameGate('next', 'name', false)
    expect(err).not.toBeNull()
    expect(err).toContain('Ambiguous spec \'next\'')
    expect(err).toContain('npm:<name>')
    expect(err).toContain('owner>/<repo')
  })

  it('accepts bare name when --source is passed', () => {
    expect(checkBareNameGate('next', 'name', true)).toBeNull()
  })

  it('accepts ecosystem spec', () => {
    expect(checkBareNameGate('npm:next', 'ecosystem', false)).toBeNull()
  })

  it('accepts github shorthand', () => {
    expect(checkBareNameGate('vercel/next.js', 'github', false)).toBeNull()
  })
})

describe('runManifestGate (Gate B)', () => {
  function mockReader(hit: { version: string, source: string, exact: boolean } | null) {
    return (_: string) => ({ readInstalledVersion: () => hit })
  }

  it('returns override when reader finds a hit', () => {
    const result = runManifestGate(
      'npm',
      'next',
      'latest',
      '/tmp/project',
      { noManifest: false, fromManifest: false },
      mockReader({ version: '15.0.3', source: 'bun.lock', exact: true }),
    )
    expect(result).toEqual({ kind: 'ok', version: '15.0.3', source: 'bun.lock' })
  })

  it('returns ok (no override) when reader has no hit', () => {
    const result = runManifestGate(
      'npm',
      'next',
      'latest',
      '/tmp/project',
      { noManifest: false, fromManifest: false },
      mockReader(null),
    )
    expect(result).toEqual({ kind: 'ok' })
  })

  it('returns error when --from-manifest is set and no hit', () => {
    const result = runManifestGate(
      'npm',
      'next',
      'latest',
      '/tmp/project',
      { noManifest: false, fromManifest: true },
      mockReader(null),
    )
    expect(result.kind).toBe('error')
    if (result.kind === 'error') {
      expect(result.message).toContain('--from-manifest')
      expect(result.message).toContain('next')
    }
  })

  it('skips manifest lookup when --no-manifest is set', () => {
    let called = false
    const result = runManifestGate(
      'npm',
      'next',
      'latest',
      '/tmp/project',
      { noManifest: true, fromManifest: false },
      (_: string) => {
        called = true
        return { readInstalledVersion: () => ({ version: '9.9.9', source: 'bun.lock', exact: true }) }
      },
    )
    expect(called).toBe(false)
    expect(result).toEqual({ kind: 'ok' })
  })

  it('skips when version is explicit (not latest)', () => {
    let called = false
    const result = runManifestGate(
      'npm',
      'next',
      '15.0.0',
      '/tmp/project',
      { noManifest: false, fromManifest: false },
      (_: string) => {
        called = true
        return { readInstalledVersion: () => ({ version: '9.9.9', source: 'bun.lock', exact: true }) }
      },
    )
    expect(called).toBe(false)
    expect(result).toEqual({ kind: 'ok' })
  })

  it('returns ok when ecosystem has no reader registered', () => {
    const result = runManifestGate(
      'unknown',
      'foo',
      'latest',
      '/tmp/project',
      { noManifest: false, fromManifest: false },
      (_: string) => undefined,
    )
    expect(result).toEqual({ kind: 'ok' })
  })
})
